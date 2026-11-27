// Opens the brain host for this tab (see ./host.ts for the contract).
//
// The brain runs in a dedicated worker (./worker.ts) on SQLite stored in the
// origin private file system. SQLite's OPFS SAH pool VFS holds its files
// exclusively, so at most one worker in the origin may open them. Tabs agree
// on which one with Web Locks:
//
// - Every tab asks for the `OWNER_LOCK`. The tab that gets it is the owner:
//   it starts the worker and opens the brain. The lock is held until the tab
//   closes (or navigates away), when the browser releases it.
// - Every other tab is a follower. It learns the owner's id over a
//   `BroadcastChannel` and sends its requests there; the owner runs them in
//   its worker, in one queue with its own, and sends the response back. So
//   every tab sees the same single copy of the data: nothing is cached on
//   the follower side except the config, which the owner rebroadcasts after
//   every change.
// - Each tab also holds a lock named after itself for its whole life. A
//   follower waits on the owner's, so it learns at once when the owner tab is
//   gone. A request the owner never answered is then retried with the next
//   owner if it reads only, or fails with `BrainOwnerClosedError` if it could
//   have changed something (the person tries again; nothing is applied twice).
// - A follower's own request for `OWNER_LOCK` is still queued, so one of them
//   becomes the next owner and opens the files once the old worker is gone.
//
// Without Web Locks or BroadcastChannel (neither is missing in any browser
// with OPFS), the tab simply opens the brain itself; a second tab then can't
// get the files and fails with `StorageBusyError` rather than diverging.

import { engine as core, type storage } from '@somememos/core';
import type { BlogSettingsView, BlogSlugCheck, SyncView } from '../sync/types.ts';
import type {
  BrainChange,
  BrainHost,
  ImportFile,
  ImportOptions,
  ImportProgress,
  ImportResult,
  StorageInfo,
} from './host.ts';
import {
  ENGINE_METHODS,
  READ_ONLY_METHODS,
  fromWireError,
  memoryReason,
  toWireError,
  type OpenRequest,
  type Target,
  type WireError,
  type WorkerEventMessage,
  type WorkerStorage,
} from './protocol.ts';
import { workerTransport, type Transport } from './worker-client.ts';
import { clearAllDrafts } from '../ui/storage.ts';

const OWNER_LOCK = 'somememos:brain:owner';
const TAB_LOCK_PREFIX = 'somememos:brain:tab:';
const CHANNEL_NAME = 'somememos:brain';

/** Files per import message, and a cap on their text, so no message is huge. */
const IMPORT_CHUNK_FILES = 250;
const IMPORT_CHUNK_CHARS = 2_000_000;

type BrainConfig = storage.BrainConfig;

type TabMessage =
  | { readonly type: 'hello'; readonly from: string }
  | { readonly type: 'owner'; readonly id: string }
  | {
      readonly type: 'request';
      readonly from: string;
      readonly to: string;
      readonly id: number;
      readonly target: Target;
      readonly method: string;
      readonly args: readonly unknown[];
    }
  | {
      readonly type: 'response';
      readonly to: string;
      readonly id: number;
      readonly ok: boolean;
      readonly value?: unknown;
      readonly error?: WireError;
    }
  | {
      readonly type: 'changed';
      readonly origin: string;
      readonly operation: string;
      readonly config: BrainConfig;
      readonly sync?: SyncView;
    };

interface RemoteCall {
  readonly owner: string;
  readonly target: Target;
  readonly method: string;
  readonly args: readonly unknown[];
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/** The tab that ran the brain closed before it answered a request that may change data. */
export class BrainOwnerClosedError extends Error {
  override name = 'BrainOwnerClosedError';
}

/** An operation that may change the brain, by its name for `BrainChange`. */
function changeOperation(target: Target, method: string): string | null {
  if (target === 'engine') return READ_ONLY_METHODS.has(method) ? null : method;
  if (method === 'importEnd') return 'importFiles';
  if (method === 'updateConfig' || method === 'reset') return method;
  // Sync's own status changes arrive as worker events; these change notes.
  if (method === 'syncResolve' || method === 'syncStartOver' || method === 'syncResolveConfig')
    return 'sync';
  return null;
}

/**
 * A structured-clone-safe copy of JSON-like data. Svelte's `$state` proxies
 * can't be posted to a worker; their plain copies can. `undefined` is kept.
 */
function plain<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => plain(v)) as T;
  if (value !== null && typeof value === 'object') {
    if (ArrayBuffer.isView(value)) return value;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = plain((value as Record<string, unknown>)[key]);
    return out as T;
  }
  return value;
}

/** Null when OPFS looks usable from this page, else why not. */
async function opfsProblem(): Promise<string | null> {
  try {
    if (typeof navigator.storage?.getDirectory !== 'function') {
      return 'This browser has no origin private file system';
    }
    await navigator.storage.getDirectory();
    return null;
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
}

const never = () => new Promise<never>(() => undefined);

class BrainConnection {
  readonly tabId = crypto.randomUUID();
  config!: BrainConfig;
  storage!: WorkerStorage;
  readonly listeners = new Set<(change: BrainChange) => void>();

  private channel: BroadcastChannel | undefined;
  private local: Transport | undefined;
  private ownerId: string | undefined;
  /** True once another tab ran the brain for this one, so owning it later is a takeover. */
  private followedAnother = false;
  private failure: Error | undefined;
  private waiters: (() => void)[] = [];
  private readonly remote = new Map<number, RemoteCall>();
  private nextId = 1;
  private firstOwner!: { resolve(): void; reject(error: unknown): void };

  get runsHere(): boolean {
    return this.local !== undefined;
  }

  async start(): Promise<void> {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks || typeof BroadcastChannel === 'undefined') {
      await this.becomeOwner();
      return;
    }
    const known = new Promise<void>((resolve, reject) => (this.firstOwner = { resolve, reject }));

    void locks.request(TAB_LOCK_PREFIX + this.tabId, never);
    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this.channel.onmessage = (event: MessageEvent<TabMessage>) => this.onTabMessage(event.data);

    void locks.request(OWNER_LOCK, async () => {
      try {
        await this.becomeOwner();
      } catch (error) {
        // Let another tab try; this one reports the error.
        this.fail(error);
        return;
      }
      await never();
    });
    this.post({ type: 'hello', from: this.tabId });

    await known;
    if (!this.local) {
      this.config = (await this.call('host', 'config', [])) as BrainConfig;
      this.storage = (await this.call('host', 'storageKind', [])) as WorkerStorage;
    }
  }

  private async becomeOwner(): Promise<void> {
    const problem = await opfsProblem();
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'somememos-brain',
    });
    const transport = workerTransport(worker, (event) => this.onWorkerEvent(event));
    const request: OpenRequest = problem
      ? { storage: 'memory', reason: memoryReason(problem) }
      : { storage: 'auto' };
    let opened: { storage: WorkerStorage; config: BrainConfig };
    try {
      opened = (await transport.call('host', 'open', [request])) as typeof opened;
    } catch (error) {
      transport.close();
      throw error;
    }
    // `ownerId` is usually cleared by then (`ownerGone` runs as soon as the
    // old owner's lock is released), so remember having followed one instead.
    const tookOver = this.followedAnother;
    this.local = transport;
    this.storage = opened.storage;
    this.config = opened.config;
    this.setOwner(this.tabId);
    this.post({ type: 'owner', id: this.tabId });
    if (tookOver) this.emit({ source: 'this-tab', operation: 'reopen' });
  }

  /** The worker's sync status changed: tell this tab and the others. */
  private onWorkerEvent(event: WorkerEventMessage): void {
    if (event.config) this.config = event.config;
    this.post({
      type: 'changed',
      origin: this.tabId,
      operation: event.operation,
      config: this.config,
      sync: event.sync,
    });
    this.emit({ source: 'this-tab', operation: event.operation, sync: event.sync });
  }

  private fail(error: unknown): void {
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.firstOwner?.reject(this.failure);
    for (const wake of this.waiters.splice(0)) wake();
  }

  private post(message: TabMessage): void {
    this.channel?.postMessage(message);
  }

  private setOwner(id: string): void {
    if (this.ownerId === id) return;
    this.ownerId = id;
    this.failure = undefined;
    if (id !== this.tabId) {
      this.followedAnother = true;
      // Granted when the owner tab is gone.
      void navigator.locks.request(TAB_LOCK_PREFIX + id, async () => this.ownerGone(id));
    }
    this.firstOwner?.resolve();
    for (const wake of this.waiters.splice(0)) wake();
  }

  private ownerGone(id: string): void {
    if (this.ownerId === id) this.ownerId = undefined;
    for (const [requestId, call] of [...this.remote]) {
      if (call.owner !== id) continue;
      this.remote.delete(requestId);
      if (READ_ONLY_METHODS.has(call.method)) {
        this.route(call.target, call.method, call.args).then(call.resolve, call.reject);
      } else {
        call.reject(
          new BrainOwnerClosedError(
            'The tab that was running the brain closed before it finished. Try again.',
          ),
        );
      }
    }
  }

  private onTabMessage(message: TabMessage): void {
    switch (message.type) {
      case 'hello':
        if (this.local) this.post({ type: 'owner', id: this.tabId });
        break;
      case 'owner':
        if (message.id !== this.tabId && !this.local) this.setOwner(message.id);
        break;
      case 'request':
        if (message.to === this.tabId) void this.serve(message);
        break;
      case 'response': {
        if (message.to !== this.tabId) break;
        const call = this.remote.get(message.id);
        if (!call) break;
        this.remote.delete(message.id);
        if (message.ok) call.resolve(message.value);
        else call.reject(fromWireError(message.error as WireError));
        break;
      }
      case 'changed':
        this.config = message.config;
        this.emit({
          source: message.origin === this.tabId ? 'this-tab' : 'other-tab',
          operation: message.operation,
          ...(message.sync ? { sync: message.sync } : {}),
        });
        break;
    }
  }

  /** Runs a request another tab sent to this one (the owner). */
  private async serve(message: Extract<TabMessage, { type: 'request' }>): Promise<void> {
    const reply = (fields: { ok: boolean; value?: unknown; error?: WireError }): void =>
      this.post({ type: 'response', to: message.from, id: message.id, ...fields });
    if (!this.local) {
      reply({ ok: false, error: toWireError(new Error('this tab is not running the brain')) });
      return;
    }
    try {
      const value = await this.runLocal(message.target, message.method, message.args, message.from);
      reply({ ok: true, value });
    } catch (error) {
      reply({ ok: false, error: toWireError(error) });
    }
  }

  private async runLocal(
    target: Target,
    method: string,
    args: readonly unknown[],
    origin: string,
  ): Promise<unknown> {
    const value = await (this.local as Transport).call(target, method, args);
    const operation = changeOperation(target, method);
    if (operation) {
      if (method === 'updateConfig' || method === 'reset') this.config = value as BrainConfig;
      this.post({ type: 'changed', origin, operation, config: this.config });
      this.emit({ source: origin === this.tabId ? 'this-tab' : 'other-tab', operation });
    }
    return value;
  }

  private async route(target: Target, method: string, args: readonly unknown[]): Promise<unknown> {
    for (;;) {
      if (this.local) return this.runLocal(target, method, args, this.tabId);
      const owner = this.ownerId;
      if (owner !== undefined) return this.send(owner, target, method, args);
      if (this.failure) throw this.failure;
      await new Promise<void>((wake) => this.waiters.push(wake));
    }
  }

  private send(
    owner: string,
    target: Target,
    method: string,
    args: readonly unknown[],
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.remote.set(id, { owner, target, method, args, resolve, reject });
      try {
        this.post({ type: 'request', from: this.tabId, to: owner, id, target, method, args });
      } catch (error) {
        this.remote.delete(id);
        reject(error);
      }
    });
  }

  call(target: Target, method: string, args: readonly unknown[]): Promise<unknown> {
    return this.route(target, method, plain(args));
  }

  emit(change: BrainChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (error) {
        console.error(error);
      }
    }
  }
}

function createHost(conn: BrainConnection): BrainHost {
  const methods: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const name of ENGINE_METHODS) methods[name] = (...args) => conn.call('engine', name, args);
  const facade = Object.freeze(
    Object.defineProperties(methods, {
      config: { get: () => conn.config, enumerable: true },
    }),
  ) as unknown as core.Engine;

  return {
    engine: facade,

    async importFiles(
      files: readonly ImportFile[] | Iterable<ImportFile> | AsyncIterable<ImportFile>,
      options: ImportOptions = {},
    ): Promise<ImportResult> {
      const total = Array.isArray(files) ? files.length : null;
      let done = 0;
      let imported = 0;
      let skipped = 0;
      const report = (phase: ImportProgress['phase']): void =>
        options.onProgress?.({ phase, done, total, imported, skipped });

      const id = (await conn.call('host', 'importBegin', [])) as number;
      try {
        let chunk: ImportFile[] = [];
        let chars = 0;
        const flush = async (): Promise<void> => {
          const sent = chunk;
          chunk = [];
          chars = 0;
          const r = (await conn.call('host', 'importChunk', [id, sent])) as {
            imported: number;
            skipped: number;
          };
          done += sent.length;
          imported += r.imported;
          skipped += r.skipped;
          report('writing');
        };
        report('writing');
        for await (const file of files as AsyncIterable<ImportFile>) {
          const text = file?.text;
          chunk.push({
            path: String(file?.path),
            text: typeof text === 'string' ? text : (null as unknown as string),
            ...(typeof file?.mtime === 'number' ? { mtime: file.mtime } : {}),
          });
          chars += typeof text === 'string' ? text.length : 0;
          if (chunk.length >= IMPORT_CHUNK_FILES || chars >= IMPORT_CHUNK_CHARS) await flush();
        }
        if (chunk.length > 0) await flush();
        report('indexing');
        const result = (await conn.call('host', 'importEnd', [id])) as ImportResult;
        report('done');
        return result;
      } catch (error) {
        await conn.call('host', 'importAbort', [id]).catch(() => undefined);
        throw error;
      }
    },

    async updateConfig(config) {
      await conn.call('host', 'updateConfig', [config]);
    },

    exportArchive: () =>
      conn.call('host', 'exportArchive', []) as ReturnType<BrainHost['exportArchive']>,

    async storageInfo(): Promise<StorageInfo> {
      const kind = (await conn.call('host', 'storageKind', [])) as WorkerStorage;
      let persisted = false;
      let usage: number | undefined;
      let quota: number | undefined;
      try {
        persisted = (await navigator.storage?.persisted?.()) ?? false;
        const estimate = await navigator.storage?.estimate?.();
        usage = estimate?.usage;
        quota = estimate?.quota;
      } catch {
        // Not reported by this browser.
      }
      return {
        kind: kind.kind,
        persisted: kind.kind === 'device' && persisted,
        ...(usage !== undefined ? { usage } : {}),
        ...(quota !== undefined ? { quota } : {}),
        ...(kind.reason ? { reason: kind.reason } : {}),
        runsIn: conn.runsHere ? 'this-tab' : 'other-tab',
      };
    },

    async requestPersistence(): Promise<boolean> {
      try {
        return (await navigator.storage?.persist?.()) ?? false;
      } catch {
        return false;
      }
    },

    async reset() {
      await conn.call('host', 'reset', []);
      // Unsaved editor drafts hold note text, in this origin's localStorage
      // (shared by every tab): they go with the notes.
      clearAllDrafts();
    },

    subscribe(listener) {
      conn.listeners.add(listener);
      return () => {
        conn.listeners.delete(listener);
      };
    },

    sync: {
      probe: () => conn.call('host', 'syncProbe', []) as ReturnType<BrainHost['sync']['probe']>,
      listBrains: (token) =>
        conn.call('host', 'syncListBrains', [token]) as ReturnType<BrainHost['sync']['listBrains']>,
      plan: (request) =>
        conn.call('host', 'syncPlan', [request]) as ReturnType<BrainHost['sync']['plan']>,
      connect: (request, confirmed = false) =>
        conn.call('host', 'syncConnect', [request, confirmed]) as Promise<SyncView>,
      disconnect: () => conn.call('host', 'syncDisconnect', []) as Promise<SyncView>,
      setToken: (token) => conn.call('host', 'syncSetToken', [token]) as Promise<SyncView>,
      status: () => conn.call('host', 'syncView', []) as Promise<SyncView>,
      syncNow: () => conn.call('host', 'syncNow', []) as Promise<SyncView>,
      startOver: () => conn.call('host', 'syncStartOver', []) as Promise<SyncView>,
      hint: async (kind) => {
        await conn.call('host', 'syncHint', [kind]);
      },
      conflicts: () =>
        conn.call('host', 'syncConflicts', []) as ReturnType<BrainHost['sync']['conflicts']>,
      resolveConflict: (path, choice) =>
        conn.call('host', 'syncResolve', [path, choice]) as Promise<{ kept: string | null }>,
      blogSettings: () => conn.call('host', 'syncBlogSettings', []) as Promise<BlogSettingsView>,
      saveBlogSettings: (settings) =>
        conn.call('host', 'syncSaveBlogSettings', [settings]) as Promise<BlogSettingsView>,
      checkBlogSlug: (slug) =>
        conn.call('host', 'syncCheckBlogSlug', [slug]) as Promise<BlogSlugCheck>,
      postAddress: (path) => conn.call('host', 'syncPostAddress', [path]) as Promise<string | null>,
      configConflict: () =>
        conn.call('host', 'syncConfigConflict', []) as ReturnType<
          BrainHost['sync']['configConflict']
        >,
      resolveConfigConflict: (choice) =>
        conn.call('host', 'syncResolveConfig', [choice]) as Promise<SyncView>,
      noteState: (path, hash) =>
        conn.call('host', 'syncNoteState', [path, hash]) as ReturnType<
          BrainHost['sync']['noteState']
        >,
    },
  };
}

let opened: Promise<BrainHost> | undefined;

/** Opens the brain for this tab (once; later calls share it). Browser only. */
export function openBrainHost(): Promise<BrainHost> {
  opened ??= (async () => {
    const conn = new BrainConnection();
    await conn.start();
    return createHost(conn);
  })();
  opened.catch(() => {
    opened = undefined;
  });
  return opened;
}
