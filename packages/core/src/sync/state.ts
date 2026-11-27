// An offline copy's sync state (PLAN.md section 7): what it has pulled from
// and pushed to its server. Durable meta (beside the event log, never deleted
// by `resetIndex`), one JSON value under `sync.state`:
//
// - `since`: the last server mutation number this copy applied. The next
//   request asks for everything after it.
// - `pushedEventSeq` / `pushedChangeSeq`: the local `seq` of the last event
//   and change record the server acknowledged. The next request pushes the
//   entries after them. Entries that arrived from the server are skipped over
//   when nothing local is waiting before them (see `applySync`), so they are
//   not pushed back; when they are, the server ignores them as duplicates.
// - `bases`: for each note, the content hash it had at the last sync (the
//   server's version). A note whose hash differs is a local edit to push with
//   that base; a base with no note is a local delete (or, with the same hash
//   at a new path, a rename); a note with no base is a local create.
// - `lastSyncAt`: when a sync last completed, Unix seconds.
// - `configRevision` / `configKey`: the server's shared-config revision this
//   copy last agreed with, and `sharedConfigKey` of that config. A copy whose
//   config no longer has that key changed it locally (and pushes it before
//   the next sync). 0 / null: not known yet (the first sync compares).

import type { MetaStore } from '../storage/types.js';

export const META_SYNC_STATE = 'sync.state';

export interface SyncState {
  readonly since: number;
  readonly pushedEventSeq: number;
  readonly pushedChangeSeq: number;
  readonly bases: Readonly<Record<string, string>>;
  readonly lastSyncAt: number | null;
  readonly configRevision: number;
  readonly configKey: string | null;
  /**
   * Notes the server refused with `NAME_CLASH` (a note and a folder would
   * share a name), sorted. They stay on this copy and are not sent again
   * while a note is at that path; a note that moves away is forgotten here.
   */
  readonly nameClash: readonly string[];
  /**
   * The conflict copies this copy made, each with the note it belongs to
   * (copy path → original path). A copy is not always beside its note
   * (`conflictCopyPath` may put it in a memo folder), so its name alone
   * cannot say. Forgotten once the copy is gone.
   */
  readonly conflictCopies: Readonly<Record<string, string>>;
}

export const EMPTY_SYNC_STATE: SyncState = Object.freeze({
  since: 0,
  pushedEventSeq: 0,
  pushedChangeSeq: 0,
  bases: Object.freeze({}),
  lastSyncAt: null,
  configRevision: 0,
  configKey: null,
  nameClash: Object.freeze([]),
  conflictCopies: Object.freeze({}),
});

const nonNegativeInteger = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** The stored sync state, or the empty state when there is none (or it is unreadable). */
export async function readSyncState(meta: MetaStore): Promise<SyncState> {
  const text = await meta.get(META_SYNC_STATE);
  if (text === undefined) return EMPTY_SYNC_STATE;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return EMPTY_SYNC_STATE;
  }
  const bases: Record<string, string> = {};
  if (value.bases && typeof value.bases === 'object') {
    for (const [path, hash] of Object.entries(value.bases as Record<string, unknown>)) {
      if (typeof hash === 'string') bases[path] = hash;
    }
  }
  const conflictCopies: Record<string, string> = {};
  if (value.conflictCopies && typeof value.conflictCopies === 'object') {
    for (const [copy, original] of Object.entries(
      value.conflictCopies as Record<string, unknown>,
    )) {
      if (typeof original === 'string') conflictCopies[copy] = original;
    }
  }
  return {
    since: nonNegativeInteger(value.since),
    pushedEventSeq: nonNegativeInteger(value.pushedEventSeq),
    pushedChangeSeq: nonNegativeInteger(value.pushedChangeSeq),
    bases,
    lastSyncAt: typeof value.lastSyncAt === 'number' ? value.lastSyncAt : null,
    configRevision: nonNegativeInteger(value.configRevision),
    configKey: typeof value.configKey === 'string' ? value.configKey : null,
    nameClash: Array.isArray(value.nameClash)
      ? [...new Set(value.nameClash.filter((p): p is string => typeof p === 'string'))].sort()
      : [],
    conflictCopies,
  };
}

export async function writeSyncState(meta: MetaStore, state: SyncState): Promise<void> {
  const bases: Record<string, string> = {};
  for (const path of Object.keys(state.bases).sort()) bases[path] = state.bases[path] as string;
  const nameClash = [...new Set(state.nameClash ?? [])].sort();
  const conflictCopies: Record<string, string> = {};
  const copies = state.conflictCopies ?? {};
  for (const copy of Object.keys(copies).sort()) conflictCopies[copy] = copies[copy] as string;
  await meta.set(META_SYNC_STATE, JSON.stringify({ ...state, bases, nameClash, conflictCopies }));
}

/** Records the shared-config revision (and its config's key) this copy now agrees with. */
export async function recordConfigRevision(
  meta: MetaStore,
  revision: number,
  key: string,
): Promise<void> {
  const state = await readSyncState(meta);
  await writeSyncState(meta, { ...state, configRevision: revision, configKey: key });
}

/** Forgets the sync state (before syncing with a different server or brain). */
export async function clearSyncState(meta: MetaStore): Promise<void> {
  await meta.delete(META_SYNC_STATE);
}
