// Folding the event log into scores (PLAN.md section 4, "The event log";
// IMPLEMENTATION.md task 1.3). Pure logic over the storage interfaces.
//
// Each event adds value 1 to the log score of its (item, kind, half-life),
// unweighted. Rename records move an item's scores to its new name. Entries
// are folded in seq order, batch by batch; each batch is written together
// with the new cursor in one atomic `applyFold`, so a crash never counts an
// entry twice and the next fold resumes where the last one committed.
//
// Renames and late events. A rename record (item → to, at time r) applies to
// an event for `item` dated at or before r, whatever order they arrive in:
// an event that arrives after the rename (from sync, or an import) but
// happened before it lands on `to`, following chains of renames. An event
// dated after the rename stays on `item`, which then names a new note (a path
// reused after a rename, or a link that dangles again).
//
// Arrival order never matters. A rename record that arrives after an entry
// dated later than it (a rename that comes through sync, or an import) may
// apply to some events already folded under its old name and not to others,
// which one `move` cannot express. When a batch holds such a rename, the
// scores are cleared and the whole log is folded canonically instead: every
// event resolved through every rename record by time, renames applied as no
// moves. So an incremental fold, a rebuild and every synced copy holding the
// same entries agree, whatever order each received them in. A rename logged
// locally is dated now, after everything before it, and folds as a move.
//
// Within a batch, contributions to the same score are summed with
// `timescore.combineAll` before they are combined into the stored score with
// `timescore.combine`. So incremental folding and a full rebuild agree to
// rounding (a few ulps of the log score), not bit for bit.

import { HALF_LIVES } from '../timescore/halfLives.js';
import type { EventKind } from '../timescore/kinds.js';
import { combineAll, eventScore } from '../timescore/timescore.js';
import {
  FoldConflictError,
  HalfLifeMismatchError,
  type EventLog,
  type HalfLives,
  type ScoreOp,
  type ScoreStore,
  type StoredRename,
} from './types.js';
import { assertValidHalfLives, sameHalfLives } from './validate.js';

export interface FoldPendingOptions {
  /** Half-lives in seconds, by name. Default `timescore.HALF_LIVES`. */
  readonly halfLives?: HalfLives;
  /** Log entries per atomic batch. Default 5000. */
  readonly batchSize?: number;
  /**
   * When the stored scores were folded with other half-lives: `'rebuild'`
   * (default) clears them and refolds the whole log; `'throw'` throws
   * `HalfLifeMismatchError`.
   */
  readonly onHalfLifeMismatch?: 'rebuild' | 'throw';
  /**
   * How many times to retry after another folder committed first
   * (`FoldConflictError`). Default 1000.
   */
  readonly maxConflictRetries?: number;
  /**
   * Resolve every event through every rename record in the log (by time),
   * instead of only those folded before it, and apply rename records as no
   * moves. The result does not depend on the order entries arrived in, which
   * an incremental fold only guarantees when each rename arrives after every
   * event it applies to and before every later event for its old name (true
   * for renames logged locally, not for ones that arrive through sync).
   * `rebuildScores` folds this way. Use it from an empty score store only.
   */
  readonly canonical?: boolean;
}

export interface FoldResult {
  /** Events folded by this call. */
  readonly events: number;
  /** Rename records applied by this call. */
  readonly renames: number;
  /** The stored cursor afterwards: the seq of the last entry folded. */
  readonly cursor: number;
  /** Batches this call committed. */
  readonly batches: number;
  /** True when stored scores were cleared because the half-lives changed. */
  readonly rebuilt: boolean;
  /**
   * True when an out-of-order rename record made this call clear the scores
   * and fold the whole log canonically (see the top of this file).
   */
  readonly refolded?: boolean;
  /** How many batches were discarded because another folder got there first. */
  readonly conflicts: number;
}

export const DEFAULT_FOLD_BATCH_SIZE = 5000;

/** Renames known so far, indexed by old item, each list sorted by (time, seq). */
class RenameIndex {
  private readonly byFrom = new Map<string, StoredRename[]>();

  add(rename: StoredRename): void {
    let list = this.byFrom.get(rename.item);
    if (!list) this.byFrom.set(rename.item, (list = []));
    let i = list.length;
    while (
      i > 0 &&
      ((list[i - 1] as StoredRename).time > rename.time ||
        ((list[i - 1] as StoredRename).time === rename.time &&
          (list[i - 1] as StoredRename).seq > rename.seq))
    ) {
      i--;
    }
    list.splice(i, 0, rename);
  }

  /**
   * Where an event for `item` at `time` lands: follow the first rename of
   * `item` at or after `time`, then the first rename of the new name after
   * that one, and so on. Each step moves strictly forward in (time, seq), so
   * this always ends.
   */
  resolve(item: string, time: number): string {
    let current = item;
    let atTime = time;
    let atSeq = -Infinity;
    for (;;) {
      const list = this.byFrom.get(current);
      const next = list?.find((r) => r.time > atTime || (r.time === atTime && r.seq > atSeq));
      if (!next) return current;
      current = next.to;
      atTime = next.time;
      atSeq = next.seq;
    }
  }
}

/**
 * Folds every log entry after the stored cursor into the score store, in
 * batches, each committed atomically with the cursor. Safe to run from
 * several processes at once: a batch computed from a cursor that another
 * folder has since advanced is discarded and recomputed.
 */
export async function foldPending(
  log: EventLog,
  scores: ScoreStore,
  options: FoldPendingOptions = {},
): Promise<FoldResult> {
  const halfLives: HalfLives = options.halfLives ?? HALF_LIVES;
  assertValidHalfLives(halfLives);
  const batchSize = options.batchSize ?? DEFAULT_FOLD_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`batchSize must be a positive integer, not ${batchSize}`);
  }
  const maxRetries = options.maxConflictRetries ?? 1000;
  const names = Object.keys(halfLives);

  let events = 0;
  let renames = 0;
  let batches = 0;
  let conflicts = 0;
  let rebuilt = false;

  for (;;) {
    const state = await scores.foldState();
    if (state.halfLives && !sameHalfLives(state.halfLives, halfLives)) {
      if (options.onHalfLifeMismatch === 'throw') {
        throw new HalfLifeMismatchError(state.halfLives, halfLives);
      }
      await scores.clear();
      rebuilt = true;
      continue;
    }

    const entries = await log.readAfter(state.cursor, { limit: batchSize });
    if (entries.length === 0) {
      return { events, renames, cursor: state.cursor, batches, rebuilt, conflicts };
    }
    const canonical = options.canonical ?? false;
    if (!canonical && (await outOfOrderRename(log, state.cursor, entries))) {
      await scores.clear();
      const refold = await foldPending(log, scores, { ...options, canonical: true });
      return {
        events: refold.events,
        renames: refold.renames,
        cursor: refold.cursor,
        batches: batches + refold.batches,
        rebuilt: rebuilt || refold.rebuilt,
        refolded: true,
        conflicts: conflicts + refold.conflicts,
      };
    }

    const known = new RenameIndex();
    for (const r of await log.renames(canonical ? {} : { throughSeq: state.cursor })) known.add(r);

    const ops: ScoreOp[] = [];
    // item -> "kind\0halfLife" -> contributions, flushed before every move.
    let pending = new Map<string, Map<string, number[]>>();
    const flush = (): void => {
      for (const [item, byKey] of pending) {
        for (const [key, list] of byKey) {
          const [kind, halfLife] = key.split('\0') as [EventKind, string];
          ops.push({ type: 'add', item, kind, halfLife, logScore: combineAll(list) });
        }
      }
      pending = new Map();
    };

    let batchEvents = 0;
    let batchRenames = 0;
    for (const entry of entries) {
      if (entry.kind === 'rename') {
        if (!canonical) {
          flush();
          ops.push({ type: 'move', from: entry.item, to: entry.to });
          known.add(entry);
        }
        batchRenames++;
        continue;
      }
      const item = known.resolve(entry.item, entry.time);
      let byKey = pending.get(item);
      if (!byKey) pending.set(item, (byKey = new Map()));
      for (const name of names) {
        const key = `${entry.kind}\0${name}`;
        let list = byKey.get(key);
        if (!list) byKey.set(key, (list = []));
        list.push(eventScore(1, entry.time, halfLives[name] as number));
      }
      batchEvents++;
    }
    flush();

    const toCursor = (entries[entries.length - 1] as { seq: number }).seq;
    try {
      await scores.applyFold({ fromCursor: state.cursor, toCursor, halfLives, ops });
    } catch (error) {
      if (error instanceof FoldConflictError) {
        if (++conflicts > maxRetries) throw error;
        continue;
      }
      throw error;
    }
    events += batchEvents;
    renames += batchRenames;
    batches++;
  }
}

/**
 * True when a rename record among `entries` (the batch after `cursor`) is
 * dated before some entry that precedes it in the log, so folding it as a
 * move could count differently than its time says.
 */
async function outOfOrderRename(
  log: EventLog,
  cursor: number,
  entries: readonly { readonly kind: string; readonly time: number; readonly seq: number }[],
): Promise<boolean> {
  const firstRename = entries.findIndex((e) => e.kind === 'rename');
  if (firstRename < 0) return false;
  let latest = -Infinity;
  if (cursor > 0) {
    for (const e of await log.readAfter(0, { limit: cursor })) {
      if (e.seq <= cursor && e.time > latest) latest = e.time;
    }
  }
  for (const e of entries) {
    if (e.kind === 'rename' && e.time < latest) return true;
    if (e.time > latest) latest = e.time;
  }
  return false;
}

/**
 * Clears the stored scores and folds the whole log again, canonically: each
 * event lands where the rename records say by time, whatever order the log
 * holds them in, so every copy with the same entries gets the same scores.
 */
export async function rebuildScores(
  log: EventLog,
  scores: ScoreStore,
  options: FoldPendingOptions = {},
): Promise<FoldResult> {
  await scores.clear();
  const result = await foldPending(log, scores, { ...options, canonical: true });
  return { ...result, rebuilt: true };
}
