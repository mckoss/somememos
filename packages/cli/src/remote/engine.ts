// Core's `Engine` over the server's HTTP routes (PLAN.md section 7, "Remote
// clients use the engine over HTTP"): every call is one request, and the
// server's engine logs the read, edit and mention events. Methods the server
// does not offer (an index pass, the local-mode commit, export and import,
// and an offline copy's sync side) throw a `CommandError` saying they are
// not available in remote mode.

import { type engine, storage, type sync } from '@somememos/core';
import { CommandError } from '../brain/output.js';
import { type RemoteClient, SYNC_TIMEOUT_MS, encodeNotePath } from './client.js';

type Engine = engine.Engine;

/** The server's brain record: `GET /api/brains/{id}`. */
export interface RemoteBrainInfo {
  readonly id: string;
  readonly createdAt: number;
  readonly mutation: number;
  /** The brain's config without a client id. */
  readonly config: Omit<storage.BrainConfig, 'clientId'>;
}

/** A note version: `GET …/notes/{path}/history`. */
export interface RemoteNoteVersion {
  readonly path: string;
  readonly mutation: number;
  readonly commit: string;
  readonly hash: string | null;
  readonly renamedTo: string | null;
  readonly time: number;
  readonly client: string;
  readonly message: string;
}

export interface RemoteNoteHistory {
  readonly path: string;
  readonly versions: RemoteNoteVersion[];
}

/** The engine over HTTP, plus the routes that have no engine method. */
export interface RemoteEngine extends Engine {
  readonly client: RemoteClient;
  /** The brain's record and config (cached after the first call). */
  brainInfo(): Promise<RemoteBrainInfo>;
  /** The brain's config with this client's id, as core parses it. */
  brainConfig(): Promise<storage.BrainConfig>;
  history(path: string, limit?: number): Promise<RemoteNoteHistory>;
  restore(
    path: string,
    commit: string,
    options?: { readonly message?: string | null; readonly baseHash?: string | null },
  ): Promise<engine.SaveResult>;
  /** One sync round (`POST …/sync`), for an offline copy's `runSync`. */
  sync(request: sync.SyncRequest): Promise<sync.SyncResponse>;
}

/** Thrown by engine methods the server does not offer. */
export class NotInRemoteModeError extends CommandError {
  override name = 'NotInRemoteModeError';
}

function unavailable(what: string, hint: string): never {
  throw new NotInRemoteModeError(`${what} is not available in remote mode: ${hint}`);
}

export function createRemoteEngine(client: RemoteClient): RemoteEngine {
  let info: Promise<RemoteBrainInfo> | null = null;
  let parsedConfig: storage.BrainConfig | null = null;

  const brainInfo = (): Promise<RemoteBrainInfo> => {
    info ??= client.brain<RemoteBrainInfo>('GET', '').catch((error: unknown) => {
      info = null;
      throw error;
    });
    return info;
  };
  const brainConfig = async (): Promise<storage.BrainConfig> => {
    if (parsedConfig) return parsedConfig;
    const { config } = await brainInfo();
    parsedConfig = storage.parseBrainConfig(
      { ...config, clientId: client.clientId },
      `the server's config for brain ${client.brainId}`,
    );
    return parsedConfig;
  };
  const note = (path: string, suffix = '') => `notes/${encodeNotePath(path)}${suffix}`;

  const remote: RemoteEngine = {
    client,
    get config(): storage.BrainConfig {
      if (parsedConfig) return parsedConfig;
      return unavailable('the brain config', 'call brainConfig() first');
    },
    brainInfo,
    brainConfig,

    index: async () => unavailable('somememos index', 'the server indexes its brain itself'),
    search: (query, options = {}) =>
      client.brain('GET', 'search', {
        query: {
          q: query,
          mode: options.mode,
          limit: options.limit,
          since: options.since,
          until: options.until,
        },
      }),
    list: (mode = 'hot', options = {}) =>
      client.brain('GET', 'list', { query: { mode, limit: options.limit } }),
    readNote: (path, options = {}) =>
      client.brain('GET', note(path), {
        query: options.record === false ? { record: false } : {},
      }),
    saveNote: (path, text, options = {}) =>
      client.brain('PUT', note(path), {
        body: {
          text,
          ...(options.baseHash !== undefined ? { baseHash: options.baseHash } : {}),
          ...(options.message !== undefined && options.message !== null
            ? { message: options.message }
            : {}),
        },
        // A repeated PUT is refused as a conflict whose current hash is the
        // text's own, which the caller treats as saved.
        idempotent: options.baseHash !== undefined,
        resultStatuses: [409],
      }),
    renameNote: (from, to, options = {}) =>
      client.brain('POST', 'rename', {
        body: {
          from,
          to,
          ...(options.message ? { message: options.message } : {}),
        },
      }),
    deleteNote: (path, options = {}) =>
      client.brain('DELETE', note(path), {
        query: options.message ? { message: options.message } : {},
      }),
    commit: async () =>
      unavailable(
        'the local-mode commit',
        'somememos commit sends the working folder’s edited files instead',
      ),
    log: async (options = {}) =>
      (
        await client.brain<{ changes: engine.ChangeRecord[] }>('GET', 'log', {
          query: {
            path: options.path,
            op: options.op,
            q: options.query,
            since: options.since,
            until: options.until,
            limit: options.limit,
            all: options.all,
          },
        })
      ).changes,
    status: () => client.brain('GET', 'status'),
    noteTitles: async () =>
      (await client.brain<{ notes: engine.NoteTitle[] }>('GET', 'titles')).notes,
    danglingLinks: async () =>
      (await client.brain<{ dangling: engine.DanglingCount[] }>('GET', 'dangling')).dangling,
    diaryPath: (date) => client.brain('GET', 'diary', { query: { date } }),
    ensureDiary: (date) =>
      client.brain('POST', 'diary', { body: date === undefined ? {} : { date }, idempotent: true }),
    exportLog: async () =>
      unavailable('somememos export', 'clone the brain (somememos clone) and export the copy'),
    importLog: async () =>
      unavailable('somememos import-log', 'import into a local brain and sync'),
    applyRemote: async () => unavailable('applyRemote', 'it is the server’s side of sync'),
    syncStatus: async () => unavailable('sync', 'a working folder holds no copy to sync'),
    prepareSync: async () => unavailable('sync', 'a working folder holds no copy to sync'),
    applySync: async () => unavailable('sync', 'a working folder holds no copy to sync'),
    resetSync: async () => unavailable('sync', 'a working folder holds no copy to sync'),

    history: (path, limit) => client.brain('GET', note(path, '/history'), { query: { limit } }),
    restore: (path, commit, options = {}) =>
      client.brain('POST', note(path, '/restore'), {
        body: {
          commit,
          ...(options.message ? { message: options.message } : {}),
          ...(options.baseHash !== undefined ? { baseHash: options.baseHash } : {}),
        },
        resultStatuses: [409],
      }),
    sync: (request) =>
      client.brain('POST', 'sync', {
        body: request,
        idempotent: true, // retries re-send the same ids (PLAN.md section 7)
        timeoutMs: SYNC_TIMEOUT_MS,
      }),
  };
  return remote;
}
