// The messages between a page and the brain worker, and between tabs (see
// ./open.ts). Everything here is structured-clone safe: plain objects,
// strings and numbers. No library; one request gets exactly one response.

import { engine, type indexing } from '@somememos/core';
import type {
  ConflictChoice,
  ConnectPlan,
  ConnectRequest,
  NoteSyncState,
  RemoteBrain,
  ServerAvailability,
  SyncConflictView,
  SyncView,
} from '../sync/types.ts';
import type { ImportFile } from './host.ts';

/** The engine's methods, by name (everything but `config`). */
export type EngineMethod = Exclude<keyof engine.Engine, 'config'>;

export const ENGINE_METHODS = [
  'index',
  'search',
  'list',
  'readNote',
  'saveNote',
  'renameNote',
  'deleteNote',
  'commit',
  'log',
  'status',
  'noteTitles',
  'danglingLinks',
  'diaryPath',
  'ensureDiary',
  'exportLog',
  'importLog',
  'syncStatus',
] as const satisfies readonly EngineMethod[];

/**
 * Engine methods that change nothing: safe to retry when the tab that held
 * the brain closed mid-call. (`readNote` logs a read, so it is not here.)
 */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  'search',
  'list',
  'log',
  'status',
  'noteTitles',
  'danglingLinks',
  'diaryPath',
  'exportLog',
  'syncStatus',
  'config',
  'storageKind',
  'syncProbe',
  'syncListBrains',
  'syncPlan',
  'syncView',
  'syncHint',
  'syncConflicts',
  'syncNoteState',
]);

/** Where the open brain keeps its data. */
export interface WorkerStorage {
  readonly kind: 'device' | 'memory';
  /** Why the data is in memory, when it is. */
  readonly reason?: string;
}

/** What the worker opens with. */
export interface OpenRequest {
  /** 'memory' skips OPFS (the page found it unavailable). Default 'auto'. */
  readonly storage?: 'auto' | 'memory';
  /** Why the page chose memory, for `StorageInfo.reason`. */
  readonly reason?: string;
}

/** The worker's own operations, beside the engine's. */
export interface HostCalls {
  open(request: OpenRequest): { storage: WorkerStorage; config: engine.Engine['config'] };
  config(): engine.Engine['config'];
  storageKind(): WorkerStorage;
  /** Starts an import: returns its id. */
  importBegin(): number;
  /** Writes one chunk of files. */
  importChunk(id: number, files: readonly ImportFile[]): { imported: number; skipped: number };
  /** Indexes what the import wrote and ends it. */
  importEnd(id: number): {
    imported: number;
    skipped: number;
    index: indexing.IndexSummary;
  };
  /** Ends an import without indexing (the page gave up). */
  importAbort(id: number): void;
  updateConfig(config: unknown): engine.Engine['config'];
  reset(): engine.Engine['config'];
  // Sync (./sync-controller.ts): run by the worker, which holds the token.
  syncProbe(): ServerAvailability;
  syncListBrains(token: string): RemoteBrain[];
  syncPlan(request: ConnectRequest): ConnectPlan;
  syncConnect(request: ConnectRequest, confirmed: boolean): SyncView;
  syncDisconnect(): SyncView;
  syncSetToken(token: string): SyncView;
  syncView(): SyncView;
  syncNow(): SyncView;
  syncStartOver(): SyncView;
  syncHint(kind: 'online' | 'visible'): void;
  syncConflicts(): SyncConflictView[];
  syncResolve(path: string, choice: ConflictChoice): { kept: string | null };
  syncNoteState(path: string, hash: string): NoteSyncState;
}

export type HostMethod = keyof HostCalls;

export type Target = 'engine' | 'host';

export interface RequestMessage {
  readonly type: 'request';
  readonly id: number;
  readonly target: Target;
  readonly method: string;
  readonly args: readonly unknown[];
}

/** An error, as it crosses a boundary. */
export type WireError =
  | {
      readonly kind: 'engine';
      readonly name: string;
      readonly code: engine.EngineErrorCode;
      readonly message: string;
      readonly path: string | null;
    }
  | {
      readonly kind: 'error';
      readonly name: string;
      readonly message: string;
      /** A ConfigError's problems. */
      readonly problems?: readonly string[];
    };

export type ResponseMessage =
  | { readonly type: 'response'; readonly id: number; readonly ok: true; readonly value: unknown }
  | {
      readonly type: 'response';
      readonly id: number;
      readonly ok: false;
      readonly error: WireError;
    };

/** Sent by the worker unprompted: sync status changed (and, with it, maybe the data or the config). */
export interface WorkerEventMessage {
  readonly type: 'event';
  readonly operation: 'sync' | 'syncStatus';
  readonly sync: SyncView;
  readonly config?: engine.Engine['config'];
}

export type WorkerMessage = ResponseMessage | WorkerEventMessage;

/** Words for the person when the brain can't be kept on the device. */
export function memoryReason(problem: unknown): string {
  const detail = problem instanceof Error ? `${problem.name}: ${problem.message}` : String(problem);
  return (
    'This browser is not letting the app keep files on the device (private browsing, or an ' +
    `older browser), so notes last only until this tab closes. (${detail})`
  );
}

export function toWireError(error: unknown): WireError {
  if (error instanceof engine.EngineError || engine.isEngineError(error)) {
    const e = error as { name?: string; code: engine.EngineErrorCode; message: string };
    const path = (error as { path?: unknown }).path;
    return {
      kind: 'engine',
      name: 'EngineError',
      code: e.code,
      message: String(e.message),
      path: typeof path === 'string' ? path : null,
    };
  }
  if (error instanceof Error) {
    const problems = (error as { problems?: unknown }).problems;
    return {
      kind: 'error',
      name: error.name || 'Error',
      message: error.message,
      ...(Array.isArray(problems) ? { problems: problems.map(String) } : {}),
    };
  }
  return { kind: 'error', name: 'Error', message: String(error) };
}

/** The error a wire error describes: an `EngineError` again, or an `Error` with its name and message. */
export function fromWireError(wire: WireError): Error {
  if (wire.kind === 'engine') return new engine.EngineError(wire.code, wire.message, wire.path);
  const error = new Error(wire.message);
  error.name = wire.name;
  if (wire.problems) Object.assign(error, { problems: [...wire.problems] });
  return error;
}
