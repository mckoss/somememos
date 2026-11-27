// When automatic sync runs (PLAN.md section 7, as the web app does it):
//
// - on demand ("Sync now") and right after connecting;
// - a few seconds after a save, rename, delete or import settles (debounced,
//   so a burst of changes is one sync, and capped so steady typing still
//   syncs);
// - some seconds after a read, batched the same way, more lazily;
// - when the browser comes back online, and when the app becomes visible
//   after being hidden a while;
// - on a slow interval while the app is open.
//
// Never two at once: a trigger during a run is remembered and served after
// it. A failure backs off exponentially (with a cap and jitter); a token the
// server refuses, or a brain that is gone, stops automatic sync until the
// person acts ("Sync now", a new token, reconnecting).
//
// Pure logic over injected timers, so it is unit-tested with a fake clock.

import type { SyncIndicator } from './types.ts';

export type FailureKind =
  /** The token was refused: stop until it is fixed. */
  | 'auth'
  /** No network, or no answer: retry with backoff, and as soon as the browser is online. */
  | 'offline'
  /** An error answer: retry with backoff (at least `retryAfterMs`). */
  | 'server'
  /** Retrying can't help (the brain is gone, or the server was reset): stop. */
  | 'fatal';

export type RunResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: FailureKind; readonly retryAfterMs?: number };

export type Trigger = 'now' | 'connect' | 'change' | 'read' | 'online' | 'visible' | 'interval';

export interface ScheduleOptions {
  /** Quiet time after a change before syncing. */
  readonly changeDelayMs: number;
  /** A change waits at most this long after the first unsynced one, however busy. */
  readonly changeMaxWaitMs: number;
  /** Quiet time after a read. */
  readonly readDelayMs: number;
  /** The slow interval while open. */
  readonly intervalMs: number;
  /** Becoming visible syncs when the last good sync is older than this. */
  readonly visibleStaleMs: number;
  /** Coming back online syncs after this short pause (the network settles). */
  readonly onlineDelayMs: number;
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
}

export const DEFAULT_SCHEDULE: ScheduleOptions = Object.freeze({
  changeDelayMs: 3_000,
  changeMaxWaitMs: 20_000,
  readDelayMs: 15_000,
  intervalMs: 5 * 60_000,
  visibleStaleMs: 60_000,
  onlineDelayMs: 1_000,
  backoffBaseMs: 5_000,
  backoffCapMs: 5 * 60_000,
});

/**
 * The wait before retry number `failures` (1 for the first retry): `base ·
 * 2^(failures-1)`, at most `cap`, scaled by a jitter factor between 0.75 and
 * 1 so devices that failed together don't retry together.
 */
export function backoffDelay(
  failures: number,
  base: number,
  cap: number,
  random: () => number = Math.random,
): number {
  if (!(failures >= 1)) return 0;
  const exp = Math.min(cap, base * 2 ** Math.min(failures - 1, 30));
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(exp * (0.75 + 0.25 * r));
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  /** Milliseconds. */
  now(): number;
}

export const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export interface SchedulerState {
  readonly enabled: boolean;
  readonly running: boolean;
  /** Why automatic sync is stopped, or null. */
  readonly paused: 'auth' | 'fatal' | null;
  readonly offline: boolean;
  readonly failures: number;
  /** When the next run is due, ms; null when none is planned (the interval aside). */
  readonly nextAt: number | null;
  readonly lastOkAt: number | null;
}

type Pending = 'change' | 'read' | 'retry' | 'soon';

export class SyncScheduler {
  private readonly run: () => Promise<RunResult>;
  private readonly timers: Timers;
  private readonly onState: (state: SchedulerState) => void;
  private readonly random: () => number;
  private enabled = false;
  private running = false;
  private rerun: 'now' | 'change' | null = null;
  private paused: 'auth' | 'fatal' | null = null;
  private offline = false;
  private failures = 0;
  private lastOkAt: number | null = null;
  private timer: unknown = null;
  private dueAt: number | null = null;
  private pendingKind: Pending | null = null;
  private firstChangeAt: number | null = null;
  private interval: unknown = null;
  private waiters: (() => void)[] = [];
  private readonly options: ScheduleOptions;

  constructor(
    run: () => Promise<RunResult>,
    timers: Timers = realTimers,
    options: Partial<ScheduleOptions> = {},
    onState: (state: SchedulerState) => void = () => undefined,
    random: () => number = Math.random,
  ) {
    this.run = run;
    this.timers = timers;
    this.onState = onState;
    this.random = random;
    this.options = { ...DEFAULT_SCHEDULE, ...options };
  }

  get state(): SchedulerState {
    return {
      enabled: this.enabled,
      running: this.running,
      paused: this.paused,
      offline: this.offline,
      failures: this.failures,
      nextAt: this.dueAt,
      lastOkAt: this.lastOkAt,
    };
  }

  /** Starts automatic sync (connected). */
  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.interval = this.timers.set(() => this.tick(), this.options.intervalMs);
    this.changed();
  }

  /** Stops everything (disconnected, reset). A run in progress finishes on its own. */
  disable(): void {
    this.enabled = false;
    this.clearPending();
    if (this.interval !== null) this.timers.clear(this.interval);
    this.interval = null;
    this.rerun = null;
    this.paused = null;
    this.failures = 0;
    this.offline = false;
    this.firstChangeAt = null;
    this.changed();
  }

  /** Something happened that may call for a sync. */
  trigger(reason: Trigger): void {
    if (!this.enabled) return;
    const now = this.timers.now();
    switch (reason) {
      case 'connect':
        this.paused = null;
        this.failures = 0;
        this.offline = false;
        this.startOrQueue('now');
        break;
      case 'now':
        this.startOrQueue('now');
        break;
      case 'change':
      case 'read': {
        if (this.paused) return;
        if (this.running) {
          this.rerun ??= 'change';
          return;
        }
        if (this.failures > 0 && this.pendingKind === 'retry') return; // the retry carries it
        this.firstChangeAt ??= now;
        const delay = reason === 'change' ? this.options.changeDelayMs : this.options.readDelayMs;
        const due = Math.min(now + delay, this.firstChangeAt + this.options.changeMaxWaitMs);
        if (this.dueAt === null) this.plan(due, reason);
        else if (reason === 'change' && this.pendingKind === 'change') this.plan(due, 'change');
        else if (due < this.dueAt) this.plan(due, reason);
        break;
      }
      case 'online':
        this.offline = false;
        if (this.paused || this.running) {
          this.changed();
          return;
        }
        this.plan(now + this.options.onlineDelayMs, 'soon');
        break;
      case 'visible': {
        if (this.paused || this.running) return;
        const stale = this.lastOkAt === null || now - this.lastOkAt >= this.options.visibleStaleMs;
        if (stale) void this.start();
        break;
      }
      case 'interval':
        this.tick();
        break;
    }
  }

  /** Resolves once no run is in progress or planned to start at once. */
  idle(): Promise<void> {
    if (!this.running && this.rerun === null) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private tick(): void {
    if (!this.enabled) return;
    this.interval = this.timers.set(() => this.tick(), this.options.intervalMs);
    if (this.paused || this.running || this.dueAt !== null) return;
    void this.start();
  }

  private plan(at: number, kind: Pending): void {
    this.clearPending();
    this.dueAt = at;
    this.pendingKind = kind;
    this.timer = this.timers.set(
      () => {
        this.timer = null;
        this.dueAt = null;
        this.pendingKind = null;
        void this.start();
      },
      Math.max(0, at - this.timers.now()),
    );
    this.changed();
  }

  private clearPending(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.dueAt = null;
    this.pendingKind = null;
  }

  private startOrQueue(kind: 'now'): void {
    if (this.running) {
      this.rerun = kind;
      return;
    }
    this.clearPending();
    void this.start();
  }

  private async start(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.clearPending();
    this.running = true;
    this.firstChangeAt = null;
    this.changed();
    let result: RunResult;
    try {
      result = await this.run();
    } catch {
      result = { ok: false, kind: 'server' };
    }
    this.running = false;
    if (!this.enabled) {
      this.finish();
      return;
    }
    if (result.ok) {
      this.failures = 0;
      this.paused = null;
      this.offline = false;
      this.lastOkAt = this.timers.now();
    } else {
      this.failures++;
      if (result.kind === 'auth' || result.kind === 'fatal') {
        this.paused = result.kind;
        this.rerun = null;
        this.clearPending();
      } else {
        this.offline = result.kind === 'offline';
        const wait = Math.max(
          backoffDelay(
            this.failures,
            this.options.backoffBaseMs,
            this.options.backoffCapMs,
            this.random,
          ),
          Math.min(result.retryAfterMs ?? 0, this.options.backoffCapMs),
        );
        this.plan(this.timers.now() + wait, 'retry');
      }
    }
    const again = this.rerun;
    this.rerun = null;
    if (again === 'now') {
      this.clearPending();
      void this.start();
      return;
    }
    if (again === 'change' && result.ok) {
      this.trigger('change');
    }
    this.finish();
  }

  private finish(): void {
    this.changed();
    if (!this.running && this.rerun === null) {
      for (const wake of this.waiters.splice(0)) wake();
    }
  }

  private changed(): void {
    try {
      this.onState(this.state);
    } catch {
      // A listener's problem is not the scheduler's.
    }
  }
}

/** The header's indicator for a state. */
export function indicatorFor(state: {
  readonly connected: boolean;
  readonly running: boolean;
  readonly paused: 'auth' | 'fatal' | null;
  readonly offline: boolean;
  readonly failures: number;
  readonly conflicts: number;
  readonly pendingNotes: number;
  readonly pendingChanges: number;
}): SyncIndicator {
  if (!state.connected) return 'off';
  if (state.running) return 'syncing';
  if (state.paused !== null || state.conflicts > 0) return 'attention';
  if (state.offline) return 'offline';
  // A server error that keeps coming back is worth a look; one or two is not.
  if (state.failures >= 3) return 'attention';
  if (state.pendingNotes + state.pendingChanges > 0 || state.failures > 0) return 'waiting';
  return 'synced';
}
