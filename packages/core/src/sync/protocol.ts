// The sync protocol (PLAN.md section 7, "Sync protocol (first version)"): the
// request and response shapes of `POST /api/brains/{brain}/sync`, the limits
// both sides enforce, and the path rule both sides share. Isomorphic: the
// server validates with it, and every offline copy (the web app, a later
// `somememos clone`) builds its requests with it through the engine
// (`Engine.prepareSync` / `Engine.applySync`).
//
// Everything here is plain JSON data.

import { isMarkdownPath, normalizePath } from '../markdown/paths.js';
import type { EventKind } from '../timescore/kinds.js';

// ---------------------------------------------------------------------------
// Log entries and change records on the wire

/** An event or rename record as sync sends it: `storage.LogInput` without `seq`. */
export type SyncEvent =
  | {
      readonly id: string;
      readonly kind: EventKind;
      readonly item: string;
      readonly time: number;
      readonly client: string;
    }
  | {
      readonly id: string;
      readonly kind: 'rename';
      readonly item: string;
      /** The new item. */
      readonly to: string;
      readonly time: number;
      readonly client: string;
    };

/** A change record as sync sends it: `storage.ChangeInput`. */
export interface SyncChange {
  readonly id: string;
  readonly time: number;
  readonly client: string;
  readonly message: string | null;
  readonly op: string | null;
  readonly paths: readonly string[];
}

// ---------------------------------------------------------------------------
// The request

export type SyncEditOp = 'write' | 'delete' | 'rename';

/**
 * One note change pushed by an offline copy. Applied by the server only when
 * `baseHash` is the note's current hash there (`null`: the note must not
 * exist; a create). For `rename`, `baseHash` is the hash of `path`, and `to`
 * must not exist.
 */
export interface SyncEdit {
  /** Unique within the request; results are matched by it. */
  readonly id: string;
  readonly op: SyncEditOp;
  readonly path: string;
  /** `rename` only: the new path. */
  readonly to?: string;
  /** The hash the edit was made against; null means "create". Never null for delete and rename. */
  readonly baseHash: string | null;
  /** `write` only: the note's new text. */
  readonly text?: string;
}

export interface SyncRequest {
  /** The last server mutation number this copy has applied (0 for none). */
  readonly since: number;
  /** The id of the client sending this (`BrainConfig.clientId`): the author of edits no change record names. */
  readonly client?: string;
  /** Log entries this copy logged (or received from elsewhere and has not pushed). */
  readonly events: readonly SyncEvent[];
  readonly changes: readonly SyncChange[];
  readonly edits: readonly SyncEdit[];
}

// ---------------------------------------------------------------------------
// The response

export type SyncEditStatus = 'applied' | 'duplicate' | 'conflict' | 'refused';

/**
 * - `applied`: stored; `hash` is the note's new hash (absent for a delete).
 * - `duplicate`: the server already holds exactly this result (a retried
 *   request, or the same change made twice); `hash` as for applied.
 * - `conflict`: the note changed on the server since `baseHash`; nothing was
 *   stored. `currentHash`/`currentText` are the server's version of `path`
 *   (null when it has none).
 * - `refused`: the edit is not allowed (`code`, e.g. `source-immutable`);
 *   nothing was stored; current version as for a conflict.
 */
export interface SyncEditResult {
  readonly id: string;
  readonly status: SyncEditStatus;
  readonly hash?: string | null;
  readonly currentHash?: string | null;
  readonly currentText?: string | null;
  /** `refused` only. */
  readonly code?: string;
}

/**
 * A note's state after the response's window. A rename shows as
 * `{ path: from, renamedTo }` plus the new path's full entry; a receiver may
 * treat `renamedTo` exactly like `deleted`.
 */
export type SyncNote =
  | { readonly path: string; readonly hash: string; readonly text: string }
  | { readonly path: string; readonly deleted: true }
  | { readonly path: string; readonly renamedTo: string };

export interface SyncResponse {
  /**
   * The server's mutation number this response brings the copy up to: store
   * it as the next `since`. Less than the server's counter while `more`.
   */
  readonly mutation: number;
  /** True when more changes remain after `mutation`: repeat the request with it. */
  readonly more: boolean;
  /** One per pushed edit, in request order. */
  readonly results: readonly SyncEditResult[];
  /** Notes changed, deleted or renamed after `since` (through `mutation`), in mutation order. */
  readonly notes: readonly SyncNote[];
  /** Log entries and change records after `since` (through `mutation`), from any client. */
  readonly events: readonly SyncEvent[];
  readonly changes: readonly SyncChange[];
}

// ---------------------------------------------------------------------------
// Limits (the server refuses a request over them; `prepareSync` stays under them)

export const SYNC_LIMITS = Object.freeze({
  /** The largest note text, in UTF-8 bytes. */
  maxNoteBytes: 2 * 1024 * 1024,
  /** The largest request body, in bytes. */
  maxRequestBytes: 32 * 1024 * 1024,
  maxEdits: 1000,
  maxEvents: 20_000,
  maxChanges: 5000,
  /** The longest note path, in UTF-8 bytes. */
  maxPathBytes: 1024,
  /** The longest change message, in characters. */
  maxMessageLength: 20_000,
  /** The longest edit id. */
  maxEditIdLength: 128,
});

/**
 * Seconds an event or change record may be dated ahead of the receiver's
 * clock, for clocks that are slightly off. Both the server and every copy
 * accept the same skew, so an entry one side accepts the other does too.
 */
export const SYNC_CLOCK_SKEW = 300;

// ---------------------------------------------------------------------------
// Paths

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Why `path` cannot be synced, or null when it can. A syncable path is a
 * normalized brain-relative markdown path: no leading `/`, no empty, `.` or
 * `..` segment, no segment starting with `.` (dot folders such as `.git` and
 * `.somememos` are never content), no backslash or control character, at
 * most `SYNC_LIMITS.maxPathBytes` bytes, ending in `.md`. Roles are checked
 * separately. The message never repeats the path.
 */
export function syncPathProblem(path: unknown): string | null {
  if (typeof path !== 'string' || path === '') return 'a path must be a non-empty string';
  if (new TextEncoder().encode(path).length > SYNC_LIMITS.maxPathBytes)
    return 'the path is too long';
  if (CONTROL.test(path) || path.includes('\\'))
    return 'the path has a control character or a backslash';
  if (path.startsWith('/')) return 'the path must be relative to the brain';
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return 'the path must be normalized (no empty, "." or ".." segments)';
  }
  if (segments.some((s) => s.startsWith('.'))) return 'no path segment may start with "."';
  if (!isMarkdownPath(path)) return 'the path must end in .md';
  if (normalizePath(path) !== path) return 'the path must be normalized';
  if (path.normalize('NFC') !== path) return 'the path must be in Unicode NFC form';
  return null;
}

/** True when `syncPathProblem(path)` is null. */
export function isSyncablePath(path: string): boolean {
  return syncPathProblem(path) === null;
}

/**
 * The path a conflicting local version is kept at (PLAN.md section 7):
 * `name.conflict-<client>-<date>.md` beside the note, with `-2`, `-3`, … added
 * until `taken` says the path is free. The client id is reduced to letters,
 * digits, `.`, `_` and `-`.
 */
export function conflictPath(
  path: string,
  client: string,
  date: string,
  taken: (candidate: string) => boolean,
): string {
  const stem = path.replace(/\.md$/i, '');
  const ext = path.slice(stem.length) || '.md';
  const who = client.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '') || 'client';
  const base = `${stem}.conflict-${who}-${date}`;
  let candidate = `${base}${ext}`;
  for (let n = 2; taken(candidate); n++) candidate = `${base}-${n}${ext}`;
  return candidate;
}
