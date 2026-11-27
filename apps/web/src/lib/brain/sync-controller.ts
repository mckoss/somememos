// Sync with the server, inside the brain worker, next to the engine
// (PLAN.md section 7). The worker is the one place that holds the access
// token, makes the network requests and runs the engine's side of the
// protocol (`prepareSync` / `applySync`, a round at a time, paged while the
// outcome says `more`). Only the tab that owns the brain runs this worker
// (./open.ts), so only one copy ever syncs; the other tabs see its status
// through `BrainHost.subscribe`.
//
// - The server is the origin the app was loaded from (`/api`); it refuses
//   cross-origin requests.
// - The token is stored in the brain's durable meta (the events database in
//   OPFS), beside the sync record, so "Start over" (reset) wipes it with the
//   notes. It is never put in a URL, a message the page can display, an
//   error, a log line or the exported event log. The page only ever gets
//   its last four characters.
// - When to sync is ../sync/schedule.ts; what connecting does is
//   ../sync/connect-plan.ts.

import { engine as core, storage, sync as coreSync } from '@somememos/core';
import {
  BRAIN_ID,
  ConnectPlanError,
  canonicalJson,
  parseConflictPath,
  planConnect,
} from '../sync/connect-plan.ts';
import {
  SyncScheduler,
  indicatorFor,
  realTimers,
  type RunResult,
  type ScheduleOptions,
  type SchedulerState,
  type Timers,
} from '../sync/schedule.ts';
import type {
  BlogSettingsInput,
  BlogSettingsView,
  BlogSlugCheck,
  ConfigConflictView,
  ConnectPlan,
  ConnectRequest,
  NoteSyncState,
  RemoteBrain,
  ServerAvailability,
  SyncConflictView,
  SyncProblem,
  SyncProgress,
  SyncRunSummary,
  SyncView,
} from '../sync/types.ts';

/** Durable meta: the connection (brain id and token). Removed by Disconnect. */
export const META_CONNECTION = 'web.sync.connection';
/** Durable meta: the brain (and origin) this device last connected to. Kept by Disconnect. */
export const META_LAST_BRAIN = 'web.sync.brain';

interface Connection {
  readonly brainId: string;
  readonly token: string;
  /** Unix seconds. */
  readonly connectedAt: number;
}

/** What the worker tells its page: the status, and the config when sync changed it. */
export interface SyncEventMessage {
  /** 'sync': notes or activity changed; 'syncStatus': only the status did. */
  readonly operation: 'sync' | 'syncStatus';
  readonly sync: SyncView;
  readonly config?: storage.BrainConfig;
}

export interface SyncControllerDeps {
  /** The current engine (it is replaced when the config changes). */
  engine(): core.Engine;
  meta(): storage.MetaStore;
  content(): storage.ContentStore;
  config(): storage.BrainConfig;
  /** Runs `fn` in the brain's one request queue. */
  queue<T>(fn: () => Promise<T>): Promise<T>;
  /** Replaces the config and re-indexes (queued by the caller's side; call it outside `queue`). */
  updateConfig(next: unknown): Promise<storage.BrainConfig>;
  emit(event: SyncEventMessage): void;
  /** The app's origin, e.g. `https://example.com`. */
  readonly origin: string;
  readonly fetch?: typeof fetch;
  readonly timers?: Timers;
  readonly schedule?: Partial<ScheduleOptions>;
  /** Whether the device thinks it is online (`navigator.onLine`). */
  readonly online?: () => boolean;
}

/** An HTTP failure: `status` 0 when no answer came. Its message never holds the token. */
export class SyncHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterMs: number | null;
  /** The error body's other fields (a 409's current config and revision). */
  readonly details: Readonly<Record<string, unknown>>;
  override name = 'SyncHttpError';
  constructor(
    status: number,
    code: string,
    message: string,
    retryAfterMs: number | null = null,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.details = details;
  }
}

/** The current config a 409 `config-changed` or `config-conflict` carries. */
function viewFromError(error: SyncHttpError): coreSync.ConfigView | null {
  const { config, revision } = error.details as { config?: unknown; revision?: unknown };
  if (typeof revision !== 'number' || !config || typeof config !== 'object') return null;
  return { revision, config: config as coreSync.SharedConfig };
}

/** How long a sync request (which may carry megabytes) may take to answer. */
export const SYNC_REQUEST_TIMEOUT_MS = 120_000;
/** How long any other request may take. */
export const REQUEST_TIMEOUT_MS = 30_000;

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const enc = encodeURIComponent;

/** Removes every occurrence of `secret` from `text`. */
function scrub(text: string, secret: string | null | undefined): string {
  return secret && secret.length >= 4 ? text.split(secret).join('•••') : text;
}

function checkToken(token: unknown): string {
  if (typeof token !== 'string' || token.trim() === '') {
    throw new ConnectPlanError('Enter the access token for this server.');
  }
  const t = token.trim();
  if (/\s/.test(t)) throw new ConnectPlanError('An access token has no spaces in it.');
  return t;
}

function checkBrainId(id: unknown): string {
  if (typeof id !== 'string' || !BRAIN_ID.test(id)) {
    throw new ConnectPlanError(
      'A brain name is 1 to 63 lower-case letters, digits and dashes, starting with a letter or digit.',
    );
  }
  return id;
}

/** This device's config without its client id, as plain JSON (the form the server stores). */
function storedConfig(config: storage.BrainConfig): Record<string, unknown> {
  const { clientId: _clientId, ...rest } = JSON.parse(
    storage.serializeBrainConfig(config),
  ) as Record<string, unknown>;
  return rest;
}

export class SyncController {
  private readonly deps: SyncControllerDeps;
  private conn: Connection | null = null;
  private previous: { brainId: string; origin: string } | null = null;
  /** Bumped whenever the connection changes, so a run in flight stops applying. */
  private generation = 0;
  private problem: SyncProblem | null = null;
  private progress: SyncProgress | null = null;
  private pending = { notes: 0, events: 0, changes: 0 };
  private conflictCount = 0;
  private lastSyncAt: number | null = null;
  private lastAttemptAt: number | null = null;
  private lastRun: SyncRunSummary | null = null;
  /** A shared-config conflict waiting for the person's choice. */
  private configConflict: coreSync.ConfigConflictError | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly scheduler: SyncScheduler;
  private readonly fetchFn: typeof fetch;

  constructor(deps: SyncControllerDeps) {
    this.deps = deps;
    this.fetchFn = deps.fetch ?? ((input, init) => fetch(input, init));
    this.scheduler = new SyncScheduler(
      () => this.runSync(),
      deps.timers ?? realTimers,
      deps.schedule ?? {},
      () => this.emitStatus(),
    );
    const scope = globalThis as { addEventListener?: (type: string, fn: () => void) => void };
    scope.addEventListener?.('online', () => this.scheduler.trigger('online'));
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Reads the stored connection and, if there is one, starts syncing. */
  async start(): Promise<void> {
    const { conn, previous } = await this.deps.queue(async () => {
      const meta = this.deps.meta();
      return {
        conn: parseJson<Connection>(await meta.get(META_CONNECTION)),
        previous: parseJson<{ brainId: string; origin: string }>(await meta.get(META_LAST_BRAIN)),
      };
    });
    this.previous = previous && typeof previous.brainId === 'string' ? previous : null;
    const sync = await this.deps.queue(() => this.deps.engine().syncStatus());
    this.lastSyncAt = sync.lastSyncAt;
    if (conn && typeof conn.token === 'string' && typeof conn.brainId === 'string') {
      this.conn = conn;
      this.scheduler.enable();
      this.scheduler.trigger('now');
    }
    await this.refresh();
  }

  /** After the brain was reset (its databases wiped): forget everything and start again. */
  async reload(): Promise<void> {
    this.generation++;
    this.scheduler.disable();
    this.conn = null;
    this.previous = null;
    this.problem = null;
    this.lastRun = null;
    this.lastSyncAt = null;
    this.configConflict = null;
    await this.start();
  }

  /** The brain changed through this worker: sync soon (and refresh the counts now). */
  noteChange(kind: 'change' | 'read'): void {
    this.scheduler.trigger(kind);
    this.scheduleRefresh();
  }

  /** A hint from a page. */
  hint(kind: unknown): void {
    if (kind === 'online') this.scheduler.trigger('online');
    else if (kind === 'visible') this.scheduler.trigger('visible');
  }

  // --- Status ----------------------------------------------------------------

  /** The current view, with fresh counts. */
  async status(): Promise<SyncView> {
    await this.refresh(false);
    return this.view();
  }

  private view(): SyncView {
    const s: SchedulerState = this.scheduler.state;
    const connected = this.conn !== null;
    return {
      connected,
      brainId: this.conn?.brainId ?? null,
      tokenHint: this.conn ? this.conn.token.slice(-4) : null,
      previousBrainId: this.previous?.brainId ?? null,
      indicator: indicatorFor({
        connected,
        running: s.running,
        paused: s.paused,
        offline: s.offline,
        failures: s.failures,
        conflicts: this.conflictCount,
        pendingNotes: this.pending.notes,
        pendingChanges: this.pending.changes,
      }),
      running: s.running,
      autoSync: connected && s.paused === null,
      offline: s.offline,
      failures: s.failures,
      lastSyncAt: this.lastSyncAt,
      lastAttemptAt: this.lastAttemptAt,
      nextAttemptAt: connected ? s.nextAt : null,
      problem: connected ? this.problem : null,
      pending: { ...this.pending },
      progress: this.progress,
      conflicts: this.conflictCount,
      lastRun: this.lastRun,
    };
  }

  private emitStatus(operation: 'sync' | 'syncStatus' = 'syncStatus', withConfig = false): void {
    this.deps.emit({
      operation,
      sync: this.view(),
      ...(withConfig ? { config: this.deps.config() } : {}),
    });
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh().catch(() => undefined);
    }, 250);
  }

  /** Re-reads what is pending and the conflict copies; emits the status. */
  private async refresh(emit = true): Promise<void> {
    const { pending, conflicts } = await this.deps.queue(async () => ({
      pending: (await this.deps.engine().syncStatus()).pending,
      conflicts: (await this.deps.content().list()).filter((e) => parseConflictPath(e.path)).length,
    }));
    this.pending = { ...pending };
    this.conflictCount = conflicts;
    if (emit) this.emitStatus();
  }

  // --- The network -----------------------------------------------------------

  private async api(
    token: string | null,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-somememos-client': this.deps.config().clientId,
    };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    // A request that never answers must not hold sync forever (one run at a
    // time): give up after a while; the retry is safe (ids deduplicate).
    const signal = AbortSignal.timeout(
      body !== undefined ? SYNC_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
    );
    const timedOut = () => new SyncHttpError(0, 'timeout', 'the server took too long to answer');
    let response: Response;
    try {
      response = await this.fetchFn(`${this.deps.origin}/api${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        signal,
      });
    } catch {
      if (signal.aborted) throw timedOut();
      throw new SyncHttpError(0, 'network', 'no answer from the server');
    }
    const type = response.headers.get('content-type') ?? '';
    let json: unknown = null;
    if (/\bjson\b/i.test(type)) {
      try {
        json = await response.json();
      } catch {
        if (signal.aborted) throw timedOut();
        json = null;
      }
    }
    if (!response.ok) {
      const error = (
        json as { error?: { code?: unknown; message?: unknown } & Record<string, unknown> } | null
      )?.error;
      const retry = Number(response.headers.get('retry-after'));
      const { code: _c, message: _m, ...details } = error ?? {};
      throw new SyncHttpError(
        response.status,
        typeof error?.code === 'string' ? error.code : type.includes('json') ? 'error' : 'not-api',
        scrub(typeof error?.message === 'string' ? error.message : response.statusText, token),
        Number.isFinite(retry) && retry > 0 ? retry * 1000 : null,
        details,
      );
    }
    if (json === null) throw new SyncHttpError(response.status, 'not-api', 'not a JSON answer');
    return json;
  }

  /** Words for a failed request made while connecting (never retried). */
  private connectError(error: unknown): Error {
    if (error instanceof ConnectPlanError) return error;
    if (error instanceof SyncHttpError) {
      if (error.code === 'timeout') {
        return new ConnectPlanError('The server took too long to answer. Try again in a moment.');
      }
      if (error.status === 0) {
        return new ConnectPlanError(
          'The server can’t be reached. Check that this device is online, then try again.',
        );
      }
      if (error.status === 401) {
        return new ConnectPlanError(
          'The server didn’t accept this access token. Check it and try again.',
        );
      }
      if (error.status === 429) {
        return new ConnectPlanError(
          'Too many attempts with a wrong token. Wait a few minutes, then try again.',
        );
      }
      if (error.code === 'no-database' || error.status === 503) {
        return new ConnectPlanError('This server doesn’t offer sync right now.');
      }
      if (error.code === 'brain-exists') {
        return new ConnectPlanError('The server already has a brain with that name.');
      }
      return new ConnectPlanError(`The server refused: ${error.message}`);
    }
    if (error instanceof Error && error.name === 'ConfigError') {
      return new ConnectPlanError(`The server’s folder roles can’t be used here: ${error.message}`);
    }
    return new ConnectPlanError(
      `Connecting failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // --- Connecting ------------------------------------------------------------

  /** Whether this origin offers sync. Needs no token. */
  async probe(): Promise<ServerAvailability> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.deps.origin}/api/health`, {
        cache: 'no-store',
        credentials: 'omit',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return {
        available: false,
        reason: 'unreachable',
        message:
          'The server can’t be reached right now, so sync can’t be set up. The app keeps working on this device.',
      };
    }
    interface Health {
      version?: unknown;
      status?: unknown;
      database?: { configured?: unknown; connected?: unknown };
    }
    const body: Health | null = /\bjson\b/i.test(response.headers.get('content-type') ?? '')
      ? ((await response.json().catch(() => null)) as Health | null)
      : null;
    if (!body || typeof body !== 'object') {
      return {
        available: false,
        reason: 'static',
        message:
          'This copy of the app is served without the somememos server, so it doesn’t offer sync. Everything works on this device.',
      };
    }
    if (body.database?.configured === false) {
      return {
        available: false,
        reason: 'no-database',
        message:
          'This server doesn’t offer sync: it runs without a database. Everything works on this device.',
      };
    }
    if (!response.ok || body.status !== 'ok') {
      return {
        available: false,
        reason: 'unavailable',
        message:
          'This server’s sync isn’t available right now (its database isn’t ready). Try again later; the app keeps working on this device.',
      };
    }
    return { available: true, version: typeof body.version === 'string' ? body.version : null };
  }

  /** The brains a token can see. The token is used for this call only. */
  async listBrains(token: unknown): Promise<RemoteBrain[]> {
    const t = checkToken(token);
    try {
      const body = (await this.api(t, 'GET', '/brains')) as { brains?: RemoteBrain[] };
      return (body.brains ?? []).map((b) => ({
        id: String(b.id),
        createdAt: Number(b.createdAt) || 0,
        mutation: Number(b.mutation) || 0,
      }));
    } catch (error) {
      throw this.connectError(error);
    }
  }

  /** What connecting would do. Changes nothing. */
  async plan(request: ConnectRequest): Promise<ConnectPlan> {
    try {
      return (await this.gather(request)).plan;
    } catch (error) {
      throw this.connectError(error);
    }
  }

  private async gather(request: ConnectRequest): Promise<{
    plan: ConnectPlan;
    token: string;
    serverConfig: Record<string, unknown> | null;
  }> {
    const token = checkToken(request?.token);
    const brainId = checkBrainId(request?.brainId);
    const create = request.create === true;
    const brains = await this.listBrains(token);
    const found = brains.find((b) => b.id === brainId);
    let serverConfig: Record<string, unknown> | null = null;
    if (found) {
      const info = (await this.api(token, 'GET', `/brains/${enc(brainId)}`)) as {
        config?: Record<string, unknown>;
      };
      serverConfig = info.config ?? null;
    }
    const local = await this.deps.queue(async () => {
      const status = await this.deps.engine().status();
      const state = await coreSync.readSyncState(this.deps.meta());
      return {
        notes: status.notes.total,
        hasSyncState:
          state.since > 0 || state.pushedEventSeq > 0 || Object.keys(state.bases).length > 0,
      };
    });
    const plan = planConnect({
      brainId,
      create,
      exists: found !== undefined,
      serverMutation: found?.mutation ?? 0,
      serverConfig,
      localConfig: storedConfig(this.deps.config()),
      localNotes: local.notes,
      hasSyncState: local.hasSyncState,
      previous: this.previous,
      origin: this.deps.origin,
    });
    return { plan, token, serverConfig };
  }

  /**
   * Connects: creates the brain if asked, takes the server's config when it
   * differs, clears a sync record from another brain, stores the token, and
   * starts the first sync (it carries on in the background; watch the
   * status). A plan that needs confirmation is refused without `confirmed`.
   */
  async connect(request: ConnectRequest, confirmed: unknown): Promise<SyncView> {
    let configChanged = false;
    try {
      const { plan, token, serverConfig } = await this.gather(request);
      if (plan.needsConfirmation && confirmed !== true) {
        throw new ConnectPlanError('This needs your confirmation first.');
      }
      if (plan.create) {
        await this.api(token, 'POST', '/brains', {
          id: plan.brainId,
          config: storedConfig(this.deps.config()),
        });
      } else if (serverConfig && (plan.rolesDiffer || plan.settingsDiffer)) {
        const local = this.deps.config();
        const next = storage.parseBrainConfig(
          { ...serverConfig, clientId: local.clientId },
          'the server’s config',
        );
        if (canonicalJson(storedConfig(next)) !== canonicalJson(storedConfig(local))) {
          await this.deps.updateConfig(next);
          configChanged = true;
        }
      }
      this.generation++;
      this.scheduler.disable();
      if (plan.differentBrain) await this.deps.queue(() => this.deps.engine().resetSync());
      const conn: Connection = { brainId: plan.brainId, token, connectedAt: nowSeconds() };
      const previous = { brainId: plan.brainId, origin: this.deps.origin };
      await this.deps.queue(async () => {
        const meta = this.deps.meta();
        await meta.set(META_CONNECTION, JSON.stringify(conn));
        await meta.set(META_LAST_BRAIN, JSON.stringify(previous));
      });
      this.conn = conn;
      this.previous = previous;
      this.problem = null;
      this.lastRun = null;
      this.scheduler.enable();
      this.scheduler.trigger('connect');
      this.emitStatus(configChanged ? 'sync' : 'syncStatus', configChanged);
      return this.view();
    } catch (error) {
      if (configChanged) this.emitStatus('sync', true);
      throw this.connectError(error);
    }
  }

  /** Forgets the token. Notes, activity and the sync record stay on the device. */
  async disconnect(): Promise<SyncView> {
    this.generation++;
    this.scheduler.disable();
    this.conn = null;
    this.problem = null;
    this.progress = null;
    this.configConflict = null;
    await this.deps.queue(() => Promise.resolve(this.deps.meta().delete(META_CONNECTION)));
    await this.refresh();
    return this.view();
  }

  /** Replaces the token (after the server refused the old one), once the server accepts it. */
  async setToken(token: unknown): Promise<SyncView> {
    const conn = this.conn;
    if (!conn) throw new ConnectPlanError('This device isn’t connected to a server.');
    const t = checkToken(token);
    try {
      await this.api(t, 'GET', `/brains/${enc(conn.brainId)}`);
    } catch (error) {
      if (error instanceof SyncHttpError && error.code === 'brain-not-found') {
        throw new ConnectPlanError(
          `The server has no brain called “${conn.brainId}” for this token.`,
        );
      }
      throw this.connectError(error);
    }
    const next: Connection = { ...conn, token: t };
    await this.deps.queue(() =>
      Promise.resolve(this.deps.meta().set(META_CONNECTION, JSON.stringify(next))),
    );
    this.conn = next;
    this.problem = null;
    this.scheduler.trigger('connect');
    return this.view();
  }

  /** Syncs now (even while automatic sync is stopped) and resolves when done. */
  async syncNow(): Promise<SyncView> {
    if (!this.conn) throw new ConnectPlanError('This device isn’t connected to a server.');
    this.scheduler.trigger('now');
    await this.scheduler.idle();
    return this.view();
  }

  /**
   * After the server turned out to be behind this device (restored or
   * recreated): forget the sync record and compare everything afresh, as a
   * first sync. Nothing is deleted; differing notes become conflict copies.
   */
  async startOver(): Promise<SyncView> {
    if (!this.conn) throw new ConnectPlanError('This device isn’t connected to a server.');
    this.generation++;
    await this.deps.queue(() => this.deps.engine().resetSync());
    this.problem = null;
    this.scheduler.trigger('connect');
    await this.scheduler.idle();
    return this.view();
  }

  // --- One sync ----------------------------------------------------------------

  private async runSync(): Promise<RunResult> {
    const conn = this.conn;
    const generation = this.generation;
    if (!conn) return { ok: true };
    this.lastAttemptAt = nowSeconds();
    const totals = {
      rounds: 0,
      received: { notes: 0, events: 0, changes: 0 },
      pushed: { edits: 0, events: 0, changes: 0 },
      conflicts: 0,
    };
    const tooLarge = new Set<string>();
    const nameClash = new Set<string>();
    let dataChanged = false;
    let configChanged = false;
    const io = this.configIo(conn, () => {
      configChanged = true;
      dataChanged = true;
    });
    try {
      // The shared config first: push this device's change, or stop on a conflict.
      await core.syncSharedConfig(io);
      if (generation !== this.generation) return { ok: true };
      this.configConflict = null;
      let adopted = 0;
      const start = await this.deps.queue(() => this.deps.engine().syncStatus());
      this.pending = { ...start.pending };
      let progress: SyncProgress = {
        sent: 0,
        toSend: start.pending.notes,
        received: 0,
        toReceive: null,
      };
      this.progress = progress;
      this.emitStatus();
      for (;;) {
        const prepared = await this.deps.queue(() => this.deps.engine().prepareSync());
        if (generation !== this.generation) return { ok: true };
        for (const p of prepared.tooLarge) tooLarge.add(p);
        for (const p of prepared.nameClash) nameClash.add(p);
        let response: coreSync.SyncResponse;
        try {
          response = (await this.api(
            conn.token,
            'POST',
            `/brains/${enc(conn.brainId)}/sync`,
            prepared.request,
          )) as coreSync.SyncResponse;
        } catch (error) {
          const view =
            error instanceof SyncHttpError && error.code === 'config-changed'
              ? viewFromError(error)
              : null;
          if (!view || adopted >= 5) throw error;
          // The brain's config changed on the server: take it, then send again.
          adopted++;
          await core.adoptServerConfig(io, view);
          continue;
        }
        if (generation !== this.generation) return { ok: true };
        const outcome = await this.deps.queue(() =>
          this.deps.engine().applySync(prepared, response),
        );
        totals.rounds++;
        totals.received.notes += outcome.received.notes;
        totals.received.events += outcome.received.events;
        totals.received.changes += outcome.received.changes;
        totals.pushed.edits += outcome.pushed.edits;
        totals.pushed.events += outcome.pushed.events;
        totals.pushed.changes += outcome.pushed.changes;
        totals.conflicts += outcome.conflicts.length;
        for (const p of outcome.nameClash) nameClash.add(p);
        if (
          outcome.received.notes + outcome.received.events + outcome.received.changes > 0 ||
          outcome.conflicts.length > 0 ||
          outcome.pushed.applied > 0
        ) {
          dataChanged = true;
        }
        let toReceive = progress.toReceive;
        if (outcome.more && toReceive === null && response.more) {
          // A long catch-up: how far it has to go, for the progress bar.
          try {
            const info = (await this.api(conn.token, 'GET', `/brains/${enc(conn.brainId)}`)) as {
              mutation?: number;
            };
            if (typeof info.mutation === 'number')
              toReceive = Math.max(0, info.mutation - start.since);
          } catch {
            // Only the progress bar needs it.
          }
        }
        progress = {
          sent: Math.min(progress.toSend, totals.pushed.edits),
          toSend: progress.toSend,
          received: Math.max(0, outcome.mutation - start.since),
          toReceive,
        };
        this.progress = progress;
        this.emitStatus(dataChanged ? 'sync' : 'syncStatus');
        if (!outcome.more) break;
        if (totals.rounds >= 2000) throw new Error('sync did not finish');
      }
      this.problem = null;
      this.lastSyncAt = nowSeconds();
      this.lastRun = {
        at: this.lastSyncAt,
        ...totals,
        tooLarge: [...tooLarge].sort(),
        nameClash: [...nameClash].sort(),
      };
      return { ok: true };
    } catch (error) {
      if (error instanceof coreSync.ConfigConflictError) this.configConflict = error;
      const { problem, result } = this.classify(error, conn);
      this.problem = problem;
      return result;
    } finally {
      this.progress = null;
      if (generation === this.generation) {
        await this.refresh(false).catch(() => undefined);
        // The scheduler's own state change emits right after; this one says
        // whether the data changed, so pages refresh what they show.
        this.emitStatus(dataChanged ? 'sync' : 'syncStatus', configChanged);
      }
    }
  }

  /** The shared config's side of sync (core's `SharedConfigSync`) over this connection. */
  private configIo(conn: Connection, onApply: () => void): core.SharedConfigSync {
    const path = `/brains/${enc(conn.brainId)}/config`;
    return {
      current: () => this.deps.config(),
      readState: () => this.deps.queue(() => coreSync.readSyncState(this.deps.meta())),
      record: (revision, key) =>
        this.deps.queue(() => coreSync.recordConfigRevision(this.deps.meta(), revision, key)),
      apply: async (next) => {
        await this.deps.updateConfig(next);
        onApply();
      },
      get: async () => (await this.api(conn.token, 'GET', path)) as coreSync.ConfigView,
      put: async (request) => {
        try {
          return (await this.api(conn.token, 'PUT', path, request)) as coreSync.ConfigPutResult;
        } catch (error) {
          const view =
            error instanceof SyncHttpError && error.code === 'config-conflict'
              ? viewFromError(error)
              : null;
          if (!view) throw error;
          return { status: 'conflict', ...view };
        }
      },
    };
  }

  /** The shared-config conflict waiting for a choice, or null. */
  configConflictView(): ConfigConflictView | null {
    const c = this.configConflict;
    if (!c || !this.conn) return null;
    return {
      local: c.local as unknown as ConfigConflictView['local'],
      server: c.server.config as unknown as ConfigConflictView['server'],
      serverRevision: c.server.revision,
    };
  }

  /**
   * Settles a shared-config conflict: 'mine' replaces the server's config
   * with this device's, 'theirs' takes the server's here. Then syncs.
   */
  async resolveConfigConflict(choice: unknown): Promise<SyncView> {
    const conn = this.conn;
    const conflict = this.configConflict;
    if (!conn) throw new ConnectPlanError('This device isn’t connected to a server.');
    if (!conflict) throw new ConnectPlanError('There is no settings conflict to resolve.');
    if (choice !== 'mine' && choice !== 'theirs') {
      throw new ConnectPlanError('Choose this device’s settings or the server’s.');
    }
    let applied = false;
    try {
      await core.resolveConfigConflict(
        this.configIo(conn, () => (applied = true)),
        choice,
        conflict.server,
      );
    } catch (error) {
      if (error instanceof coreSync.ConfigConflictError) {
        // The server changed again meanwhile: show the newer one.
        this.configConflict = error;
        this.emitStatus('syncStatus');
        throw new ConnectPlanError(
          'The settings changed on the server again in the meantime. Look at them once more, then choose.',
        );
      }
      throw this.connectError(error);
    }
    this.configConflict = null;
    this.problem = null;
    if (applied) this.emitStatus('sync', true);
    this.scheduler.trigger('connect');
    await this.scheduler.idle();
    return this.view();
  }

  private classify(error: unknown, conn: Connection): { problem: SyncProblem; result: RunResult } {
    const at = nowSeconds();
    const problem = (kind: SyncProblem['kind'], message: string): SyncProblem => ({
      kind,
      message: scrub(message, conn.token),
      at,
    });
    if (error instanceof SyncHttpError) {
      if (error.code === 'timeout') {
        return {
          problem: problem(
            'server',
            'The server took too long to answer. Your changes are kept here; it will try again shortly.',
          ),
          result: { ok: false, kind: 'server' },
        };
      }
      if (error.status === 0) {
        const online = this.deps.online?.() ?? true;
        return {
          problem: problem(
            'offline',
            online
              ? 'The server can’t be reached. Your changes are kept here and sync when it can be reached again.'
              : 'This device is offline. Your changes are kept here and sync when it is back online.',
          ),
          result: { ok: false, kind: 'offline' },
        };
      }
      if (error.status === 401) {
        return {
          problem: problem(
            'auth',
            'The server didn’t accept this device’s access token. Automatic sync is stopped until you enter a valid one.',
          ),
          result: { ok: false, kind: 'auth' },
        };
      }
      if (error.code === 'brain-not-found') {
        return {
          problem: problem(
            'gone',
            `The brain “${conn.brainId}” is no longer on the server. Automatic sync is stopped. Disconnect, then connect to a brain that exists.`,
          ),
          result: { ok: false, kind: 'fatal' },
        };
      }
      if (error.status === 429) {
        return {
          problem: problem(
            'server',
            'The server is refusing requests for a while after too many failed attempts. Sync will try again later.',
          ),
          result: { ok: false, kind: 'server', retryAfterMs: error.retryAfterMs ?? 60_000 },
        };
      }
      if (error.status === 503) {
        return {
          problem: problem(
            'unavailable',
            'The server’s sync isn’t available right now. It will try again shortly.',
          ),
          result: { ok: false, kind: 'server' },
        };
      }
      return {
        problem: problem(
          'server',
          `The server answered with an error (${error.status}${error.message ? `: ${error.message}` : ''}). It will try again shortly.`,
        ),
        result: { ok: false, kind: 'server' },
      };
    }
    if (error instanceof coreSync.ConfigConflictError) {
      return {
        problem: problem(
          'config-conflict',
          'The folder roles or other brain settings were changed both here and on another device. Sync is stopped until you choose which to keep (in More, under Folder roles).',
        ),
        result: { ok: false, kind: 'fatal' },
      };
    }
    if (core.isEngineError(error) && /behind this copy/.test(error.message)) {
      return {
        problem: problem(
          'reset',
          `The server’s copy of “${conn.brainId}” is older than this device’s: it may have been restored from a backup or recreated. Automatic sync is stopped. “Compare again” sends this device’s notes afresh; nothing is deleted, and notes that differ are kept as conflict copies.`,
        ),
        result: { ok: false, kind: 'fatal' },
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      problem: problem('other', `Sync failed: ${message}. It will try again shortly.`),
      result: { ok: false, kind: 'server' },
    };
  }

  // --- Conflicts and notes -------------------------------------------------------

  /** The conflict copies on this device, each with the server's version beside it. */
  async conflicts(): Promise<SyncConflictView[]> {
    return this.deps.queue(async () => {
      const content = this.deps.content();
      const out: SyncConflictView[] = [];
      const entries = (await content.list())
        .map((e) => e.path)
        .filter((p) => parseConflictPath(p))
        .sort();
      // A copy may sit in another folder than its note (core's
      // conflictCopyPath): core recorded which note it belongs to.
      const originals = await this.deps.engine().conflictOriginals(entries);
      for (const path of entries) {
        const parsed = parseConflictPath(path);
        const mine = await content.read(path);
        if (!parsed || mine === undefined) continue;
        const original = originals[path] ?? parsed.original;
        const theirs = (await content.read(original)) ?? null;
        out.push({ path, ...parsed, original, mine, theirs });
      }
      return out;
    });
  }

  /**
   * Resolves one conflict copy: 'mine' saves this device's text at the
   * original path, 'theirs' keeps the server's, 'both' keeps this device's as
   * a note of its own beside the original. The conflict copy is then deleted.
   * Each step is an ordinary change, which syncs like any other.
   */
  async resolve(path: unknown, choice: unknown): Promise<{ kept: string | null }> {
    if (typeof path !== 'string') throw new ConnectPlanError('No such conflict copy.');
    const named = parseConflictPath(path);
    if (!named) throw new ConnectPlanError('That note is not a conflict copy.');
    if (choice !== 'mine' && choice !== 'theirs' && choice !== 'both') {
      throw new ConnectPlanError('Choose mine, theirs or both.');
    }
    const result = await this.deps.queue(async () => {
      const content = this.deps.content();
      const engine = this.deps.engine();
      const recorded = (await engine.conflictOriginals([path]))[path];
      const parsed = { ...named, original: recorded ?? named.original };
      const mine = await content.read(path);
      if (mine === undefined) throw new ConnectPlanError('That conflict copy is gone already.');
      let kept: string | null = null;
      if (choice === 'mine') {
        await engine.saveNote(parsed.original, mine, {
          message: 'Resolved a sync conflict: kept this device’s version',
        });
        kept = parsed.original;
      } else if (choice === 'both') {
        const taken = new Set((await content.list()).map((e) => e.path));
        const stem = parsed.original.replace(/\.md$/i, '');
        let target = `${stem} (copy ${parsed.date}).md`;
        for (let n = 2; taken.has(target); n++) target = `${stem} (copy ${parsed.date} ${n}).md`;
        await engine.saveNote(target, mine, {
          baseHash: null,
          message: `Resolved a sync conflict: kept both versions of ${parsed.original}`,
        });
        kept = target;
      }
      // Only now, with the text safe elsewhere (or deliberately dropped), remove the copy.
      try {
        await engine.deleteNote(path, { message: 'Resolved a sync conflict' });
      } catch (error) {
        // A copy whose name has no role was never indexed: remove the file itself.
        if (!core.isEngineError(error) || error.code !== 'not-found') throw error;
        await content.remove(path);
      }
      return { kept };
    });
    this.noteChange('change');
    return result;
  }

  // --- The public blog (the owner's settings on the server) ---------------------

  private connected(): Connection {
    if (!this.conn) throw new ConnectPlanError('This device isn’t connected to a server.');
    return this.conn;
  }

  /** The brain's blog settings on the server. */
  async blogSettings(): Promise<BlogSettingsView> {
    const conn = this.connected();
    try {
      return (await this.api(
        conn.token,
        'GET',
        `/brains/${enc(conn.brainId)}/blog`,
      )) as BlogSettingsView;
    } catch (error) {
      throw this.connectError(error);
    }
  }

  /** Replaces the blog settings. A public name another blog has is refused in words. */
  async saveBlogSettings(input: unknown): Promise<BlogSettingsView> {
    const conn = this.connected();
    const s = (input ?? {}) as Partial<BlogSettingsInput>;
    const body: BlogSettingsInput = {
      enabled: s.enabled === true,
      slug: typeof s.slug === 'string' && s.slug.trim() !== '' ? s.slug.trim() : null,
      title: typeof s.title === 'string' ? s.title : null,
      description: typeof s.description === 'string' ? s.description : null,
      author: typeof s.author === 'string' ? s.author : null,
    };
    try {
      return (await this.api(
        conn.token,
        'PUT',
        `/brains/${enc(conn.brainId)}/blog`,
        body,
      )) as BlogSettingsView;
    } catch (error) {
      if (error instanceof SyncHttpError && error.code === 'slug-taken') {
        throw new ConnectPlanError(
          `Another blog on this server already uses the name “${body.slug}”. Choose a different one.`,
        );
      }
      if (error instanceof SyncHttpError && error.status === 400) {
        throw new ConnectPlanError(`The server refused these settings: ${error.message}.`);
      }
      throw this.connectError(error);
    }
  }

  /** Whether a public name could be this brain's blog's (valid, not reserved, not taken). */
  async checkBlogSlug(slug: unknown): Promise<BlogSlugCheck> {
    const conn = this.connected();
    const s = typeof slug === 'string' ? slug : '';
    try {
      return (await this.api(
        conn.token,
        'GET',
        `/brains/${enc(conn.brainId)}/blog/slug?slug=${enc(s)}`,
      )) as BlogSlugCheck;
    } catch (error) {
      throw this.connectError(error);
    }
  }

  /** The public address of a post at `path` when the blog is on (null otherwise, or offline). */
  async postAddress(path: unknown): Promise<string | null> {
    if (!this.conn || typeof path !== 'string') return null;
    try {
      const r = (await this.api(
        this.conn.token,
        'GET',
        `/brains/${enc(this.conn.brainId)}/blog/address?path=${enc(path)}`,
      )) as { url?: unknown };
      return typeof r.url === 'string' ? `${this.deps.origin}${r.url}` : null;
    } catch {
      return null;
    }
  }

  /** Whether the server has this exact version (`hash`) of a note. */
  async noteState(path: unknown, hash: unknown): Promise<NoteSyncState> {
    if (!this.conn) return 'off';
    if (typeof path !== 'string' || typeof hash !== 'string') return 'waiting';
    const state = await this.deps.queue(() => coreSync.readSyncState(this.deps.meta()));
    return state.bases[path] === hash ? 'synced' : 'waiting';
  }
}

function parseJson<T>(text: string | undefined): T | null {
  if (text === undefined) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
