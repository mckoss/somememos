// One change set from a remote client (`POST /api/brains/{brain}/changes`):
// several writes, deletes and renames, each with the hash it was based on,
// applied all together or not at all, as one change record, one git commit
// and one range of mutation numbers. The CLI's remote `commit` sends one.
// Plain JSON shapes, shared by the server and its clients.

import type { ChangeRecord } from '../storage/types.js';

export type BatchOp =
  | {
      readonly op: 'write';
      readonly path: string;
      readonly text: string;
      /** The hash the edit was made against; null: a new note (none may exist). */
      readonly baseHash: string | null;
    }
  | { readonly op: 'delete'; readonly path: string; readonly baseHash: string }
  | {
      readonly op: 'rename';
      readonly path: string;
      readonly to: string;
      /** The hash of `path`; `to` must not exist. */
      readonly baseHash: string;
    };

export interface BatchRequest {
  /** The change record's message (the reason); optional. */
  readonly message?: string | null;
  readonly ops: readonly BatchOp[];
}

export interface BatchOpResult {
  readonly op: BatchOp['op'];
  readonly path: string;
  readonly to?: string;
  /** `unchanged`: the server already had exactly this result (a retry). */
  readonly status: 'applied' | 'unchanged';
  /** The note's hash afterwards (at `to` for a rename); null for a delete. */
  readonly hash: string | null;
}

/** A file whose base was stale: the server's current version of it. */
export interface BatchConflict {
  readonly path: string;
  /** The server's hash and text of `path`; null when it has no such note. */
  readonly currentHash: string | null;
  readonly currentText: string | null;
  /** For a rename whose target exists: that path. */
  readonly to?: string;
}

/**
 * The answer: `saved` (HTTP 200) with one change record (null when every op
 * was `unchanged`), or `conflict` (HTTP 409): nothing was applied, and every
 * stale file is listed with the server's version.
 */
export type BatchResult =
  | {
      readonly status: 'saved';
      readonly change: ChangeRecord | null;
      readonly results: readonly BatchOpResult[];
    }
  | { readonly status: 'conflict'; readonly conflicts: readonly BatchConflict[] };

/** The most ops one change set may carry. */
export const MAX_BATCH_OPS = 1000;
