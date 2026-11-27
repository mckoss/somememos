// One change set from a remote client (`POST /api/brains/{brain}/changes`):
// several writes, deletes and renames, each with the hash it was based on,
// applied all together or not at all, as one change record, one git commit
// and one range of mutation numbers. The CLI's remote `commit` sends one.
// Plain JSON shapes, shared by the server and its clients; the request's
// schema is in ./schema.ts.

import type * as v from 'valibot';
import type { ChangeRecord } from '../storage/types.js';
import type { BatchOpSchema, BatchRequestSchema } from './schema.js';

/** One op of a change set (`BatchOpSchema`, ./schema.ts). */
export type BatchOp = v.InferOutput<typeof BatchOpSchema>;

/** A change set (`BatchRequestSchema`). */
export type BatchRequest = v.InferOutput<typeof BatchRequestSchema>;

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
