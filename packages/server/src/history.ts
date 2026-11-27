// A note's version history (IMPLEMENTATION.md task 3.6): every version the
// server stored, newest first, following renames back to the old path, with
// each version's commit, time, author, message and content hash; and the
// text of one past version, read from git. Restoring a version is an
// ordinary save of its text (a new commit): history is never rewritten.

import { HttpError } from './errors.js';
import type { BrainContext } from './brains.js';

export interface NoteVersion {
  /** The path the note had in this version. */
  readonly path: string;
  readonly mutation: number;
  readonly commit: string;
  /** The content hash (`NoteView.hash`), or null for the version that deleted or renamed it away. */
  readonly hash: string | null;
  /** Set on the version that renamed the note away from `path`. */
  readonly renamedTo: string | null;
  /**
   * Set on the version that renamed the note to `path`, from this older
   * path. A rename is listed once, at its new path.
   */
  readonly renamedFrom: string | null;
  /** Author time (when the change was made), Unix seconds. */
  readonly time: number;
  /** The client that made the change. */
  readonly client: string;
  readonly message: string;
}

export interface NoteHistory {
  readonly path: string;
  readonly versions: NoteVersion[];
}

interface Row {
  path: string;
  mutation: string;
  hash: string | null;
  renamed_to: string | null;
  commit: string;
}

/** The versions of `path`, newest first, at most `limit`. */
export async function noteHistory(
  ctx: BrainContext,
  path: string,
  limit = 200,
): Promise<NoteHistory> {
  const rows: Row[] = [];
  let current = path;
  let before = Number.MAX_SAFE_INTEGER;
  const seen = new Set<string>();
  const renamedFrom = new Map<Row, string>();
  while (rows.length < limit && !seen.has(`${current}\0${before}`)) {
    seen.add(`${current}\0${before}`);
    const found = await ctx.query<Row>(
      `SELECT path, mutation, hash, renamed_to, commit FROM note_versions
       WHERE brain_id = $1 AND path = $2 AND mutation < $3 ORDER BY mutation DESC LIMIT $4`,
      [ctx.brainId, current, before, limit - rows.length],
    );
    rows.push(...found);
    const oldest = found.at(-1);
    if (!oldest || oldest.hash === null) break;
    // Did this path begin as a rename? Then continue with the old path.
    const from = await ctx.query<{ path: string }>(
      `SELECT path FROM note_versions WHERE brain_id = $1 AND mutation = $2 AND renamed_to = $3`,
      [ctx.brainId, oldest.mutation, current],
    );
    if (!from[0]) break;
    // The rename is one version, the one at the new path: the old path's
    // record of the same mutation (renamed away) is not listed again.
    renamedFrom.set(oldest, from[0].path);
    before = Number(oldest.mutation);
    current = from[0].path;
  }
  // A folder accepted again after being excluded re-records its notes'
  // versions (./config-sync.ts): the same commit and path, shown once.
  const seenVersion = new Set<string>();
  for (let i = rows.length - 1; i >= 0; i--) {
    const key = `${(rows[i] as Row).commit}\0${(rows[i] as Row).path}`;
    if (seenVersion.has(key)) rows.splice(i, 1);
    else seenVersion.add(key);
  }
  const info = await ctx.repo.commitInfo(rows.map((r) => r.commit));
  return {
    path,
    versions: rows.map((r) => {
      const c = info.get(r.commit);
      return {
        path: r.path,
        mutation: Number(r.mutation),
        commit: r.commit,
        hash: r.hash,
        renamedTo: r.renamed_to,
        renamedFrom: renamedFrom.get(r) ?? null,
        time: c?.time ?? 0,
        client: c?.author ?? '',
        message: c?.message ?? '',
      };
    }),
  };
}

export interface PastVersion {
  readonly path: string;
  readonly commit: string;
  readonly hash: string;
  readonly text: string;
}

/**
 * The text of `path` as `commit` stored it; 404 unless that commit made a
 * version of it. The caller has checked `commit` (`CommitIdSchema`).
 */
export async function pastVersion(
  ctx: BrainContext,
  path: string,
  commit: string,
): Promise<PastVersion> {
  const rows = await ctx.query<{ hash: string | null }>(
    `SELECT hash FROM note_versions WHERE brain_id = $1 AND path = $2 AND commit = $3`,
    [ctx.brainId, path, commit],
  );
  const hash = rows.find((r) => r.hash !== null)?.hash;
  if (!hash) throw new HttpError(404, 'not-found', 'no such version of that note');
  const [text] = await ctx.repo.readAt([{ commit, path }]);
  if (text === undefined) throw new HttpError(404, 'not-found', 'no such version of that note');
  return { path, commit, hash, text };
}
