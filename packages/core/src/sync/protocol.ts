// The sync protocol (PLAN.md section 7, "Sync protocol (first version)"): the
// request and response shapes of `POST /api/brains/{brain}/sync`, the limits
// both sides enforce, and the path rule both sides share. Isomorphic: the
// server validates with it, and every offline copy (the web app, a later
// `somememos clone`) builds its requests with it through the engine
// (`Engine.prepareSync` / `Engine.applySync`).
//
// Everything here is plain JSON data; the schemas that check it are in
// ./schema.ts.

import { baseName, isMarkdownPath, normalizePath } from '../markdown/paths.js';
import type { FolderRolesConfig } from '../markdown/roles.js';
import type * as v from 'valibot';
import type {
  SyncChangeSchema,
  SyncEditResultSchema,
  SyncEditSchema,
  SyncEventSchema,
  SyncNoteSchema,
  SyncRequestSchema,
  SyncResponseSchema,
} from './schema.js';

// ---------------------------------------------------------------------------
// The shapes on the wire, inferred from their schemas (./schema.ts), which
// document each field.

/** An event or rename record as sync sends it: `storage.LogInput` without `seq`. */
export type SyncEvent = v.InferOutput<typeof SyncEventSchema>;

/** A change record as sync sends it: `storage.ChangeInput`. */
export type SyncChange = v.InferOutput<typeof SyncChangeSchema>;

/** One note change pushed by an offline copy (`SyncEditSchema`). */
export type SyncEdit = v.InferOutput<typeof SyncEditSchema>;
export type SyncEditOp = SyncEdit['op'];

/** `POST /api/brains/{brain}/sync` (`SyncRequestSchema`). */
export type SyncRequest = v.InferOutput<typeof SyncRequestSchema>;

/** One result per pushed edit (`SyncEditResultSchema`). */
export type SyncEditResult = v.InferOutput<typeof SyncEditResultSchema>;
export type SyncEditStatus = SyncEditResult['status'];

/** A note's state after the response's window (`SyncNoteSchema`). */
export type SyncNote = v.InferOutput<typeof SyncNoteSchema>;

/** The answer to a sync request (`SyncResponseSchema`). */
export type SyncResponse = v.InferOutput<typeof SyncResponseSchema>;

/**
 * The `refused` code for a note the server cannot store because a note and a
 * folder would share a name (`a.md` beside `a.md/b.md`): the server keeps
 * notes as files. A copy that gets it keeps the note on that copy only and
 * does not send it again until its path changes (no conflict copy, which
 * would clash the same way).
 */
export const NAME_CLASH = 'name-clash';

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
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** The longest file or folder name in a syncable path, in UTF-8 bytes (common file systems' limit). */
export const MAX_SEGMENT_BYTES = 255;

/**
 * Why `path` cannot be synced, or null when it can. A syncable path is a
 * normalized brain-relative markdown path: no leading `/`, no empty, `.` or
 * `..` segment, no segment starting with `.` (dot folders such as `.git` and
 * `.somememos` are never content), no backslash or control character, no
 * lone surrogate, at
 * most `SYNC_LIMITS.maxPathBytes` bytes, ending in `.md`. Roles are checked
 * separately. The message never repeats the path.
 */
export function syncPathProblem(path: unknown): string | null {
  if (typeof path !== 'string' || path === '') return 'a path must be a non-empty string';
  const encoder = new TextEncoder();
  if (encoder.encode(path).length > SYNC_LIMITS.maxPathBytes) return 'the path is too long';
  // File systems refuse a longer file or folder name (and the server stores notes as files).
  if (path.split('/').some((s) => encoder.encode(s).length > MAX_SEGMENT_BYTES)) {
    return `a file or folder name in the path is longer than ${MAX_SEGMENT_BYTES} bytes`;
  }
  if (CONTROL.test(path) || path.includes('\\'))
    return 'the path has a control character or a backslash';
  // A lone surrogate has no UTF-8 form: the file would get another name.
  if (LONE_SURROGATE.test(path)) return 'the path is not valid Unicode';
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

/**
 * The literal folder a role pattern starts with (`memos/` → `memos`,
 * `notes/**\/*.md` → `notes`, `*.md` → ``), or null when even its first
 * segment has a wildcard or placeholder.
 */
function patternFolder(pattern: string): string | null {
  const p = pattern.trim().replace(/^(?:\.\/|\/)+/, '');
  const segments = p.split('/');
  const literal: string[] = [];
  // Every segment but the last is a folder; stop at the first wildcard or placeholder.
  for (const segment of segments.slice(0, -1)) {
    if (/[*?{]/.test(segment) || segment === '') break;
    literal.push(segment);
  }
  if (literal.length === 0 && /[*?{]/.test(segments[0] ?? '') && segments.length > 1) return null;
  return literal.join('/');
}

/**
 * Where a conflicting local version is kept so that it syncs: the
 * `conflictPath` beside the note when `accepts` it (it has a role there, not
 * `excluded`, and is syncable), otherwise the same file name in the first
 * folder of a `memo` pattern that accepts it (then of a `blog` or `source`
 * pattern), otherwise the brain's root. A conflict copy of a dated entry in
 * a strictly patterned diary folder (`diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md`)
 * matches no pattern there, so it goes to the first memo folder. Falls back
 * to the path beside the note when nothing accepts one (it then stays on
 * this copy only, still never lost).
 */
export function conflictCopyPath(
  path: string,
  client: string,
  date: string,
  taken: (candidate: string) => boolean,
  accepts: (candidate: string) => boolean,
  roles: FolderRolesConfig,
): string {
  const beside = conflictPath(path, client, date, taken);
  if (accepts(beside)) return beside;
  const folders: string[] = [];
  for (const role of ['memo', 'blog', 'source'] as const) {
    for (const pattern of roles[role] ?? []) {
      const folder = patternFolder(pattern);
      if (folder !== null && !folders.includes(folder)) folders.push(folder);
    }
  }
  if (!folders.includes('')) folders.push('');
  const name = baseName(path);
  for (const folder of folders) {
    const candidate = conflictPath(folder === '' ? name : `${folder}/${name}`, client, date, taken);
    if (accepts(candidate)) return candidate;
  }
  return beside;
}

/**
 * A change record with its message cut to `SYNC_LIMITS.maxMessageLength`
 * UTF-16 code units (the server's check), ending in `…` when cut, and never
 * splitting a surrogate pair. Applied when a request is prepared, so an
 * over-long message never makes the server refuse the whole batch.
 */
export function truncateChangeMessage<C extends { readonly message: string | null }>(change: C): C {
  const max = SYNC_LIMITS.maxMessageLength;
  const message = change.message;
  if (typeof message !== 'string' || message.length <= max) return change;
  let cut = message.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { ...change, message: `${cut}…` };
}
