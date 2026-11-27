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
// stored scores are replaced, in one atomic batch checked against the
// cursor, by the whole log folded canonically instead: every
// event resolved through every rename record by time, renames applied as no
// moves. So an incremental fold, a rebuild and every synced copy holding the
// same entries agree, whatever order each received them in. A rename logged
// locally is dated now, after everything before it, and folds as a move.
//
// Ties are part of the rule (./renames.ts): renames at the same second are
// simultaneous and never chain into each other, and of several renames of
// one item at one second the smallest id applies. Moves applied one by one
// are not simultaneous, so a rename that interacts with an earlier rename of
// the same second (it starts where that one ends, or it renames the same
// item and has the smaller id) also refolds (`outOfOrderRename`). Nothing
// here uses `seq`, which differs on every copy, to decide where an event
// lands.
//
// The burst rule (`burstWindow`, ./burst.ts). Of one item's events of one
// kind, an event counts only if it is at least the window after the last
// counted one; the item is the one the event lands on after renames. The
// canonical fold decides this over the whole log at once (`countBursts`). An
// incremental fold decides each event from the last counted time of its
// (item, kind), which the score store keeps beside the scores (`'last'` ops,
// `ScoreStore.burstState`; moved by a rename's `move`). That is exact as long
// as each group's events arrive in time order, which they do for events
// logged locally. Two things can break it, and each makes the fold replace
// the scores with a canonical refold, exactly as an out-of-order rename does: an
// event dated before its group's last counted one (a late event from sync or
// an import), and a rename onto an item that already has events of a kind
// the old item has too (the two histories interleave in time). So the
// result is still a function of the set of entries, never of their arrival
// order. The cost of a refold is one pass over the whole log; at personal
// scale that is a fraction of a second, and it happens only when a late
// event lands on a note that has a later counted event of the same kind.
// With a window of 0 none of this runs and folding is exactly as without
// the rule.
//
// Within a batch, contributions to the same score are summed with
// `timescore.combineAll` before they are combined into the stored score with
// `timescore.combine`. So incremental folding and a full rebuild agree to
// rounding (a few ulps of the log score), not bit for bit.

import { HALF_LIVES } from '../timescore/halfLives.js';
import { EVENT_KINDS, type EventKind } from '../timescore/kinds.js';
import { combineAll, eventScore } from '../timescore/timescore.js';
import { assertValidBurstWindow, burstDecision, burstKey, countBursts } from './burst.js';
import { RenameIndex } from './renames.js';
import {
  BurstWindowMismatchError,
  FoldConflictError,
  HalfLifeMismatchError,
  type EventLog,
  type HalfLives,
  type LogEntry,
  type ScoreOp,
  type ScoreStore,
  type StoredEvent,
  type StoredRename,
} from './types.js';
import {
  assertValidHalfLives,
  compareStrings,
  foldBurstWindow,
  sameHalfLives,
} from './validate.js';

export interface FoldPendingOptions {
  /** Half-lives in seconds, by name. Default `timescore.HALF_LIVES`. */
  readonly halfLives?: HalfLives;
  /** Log entries per atomic batch. Default 5000. */
  readonly batchSize?: number;
  /**
   * The burst rule's window in seconds (./burst.ts): of one item's events of
   * one kind, an event counts only if it is at least this long after the
   * last counted one. Default 0: off, every event counts. A brain's config
   * sets it (`BrainConfig.burstWindow`, default `DEFAULT_BURST_WINDOW`); pass
   * `foldOptions(config)`. It is recorded with the scores like the
   * half-lives, and a different value rebuilds them.
   */
  readonly burstWindow?: number;
  /**
   * When the stored scores were folded with other half-lives or another
   * burst window: `'rebuild'` (default) replaces them with a refold of the whole
   * log; `'throw'` throws `HalfLifeMismatchError` or `BurstWindowMismatchError`.
   */
  readonly onHalfLifeMismatch?: 'rebuild' | 'throw';
  /**
   * How many times to retry after another folder committed first
   * (`FoldConflictError`). Default 1000.
   */
  readonly maxConflictRetries?: number;
  /**
   * Start by replacing the stored scores with the canonical fold of the
   * whole log, in one atomic batch: every event resolved through every
   * rename record by time, renames as no moves. `rebuildScores` folds this
   * way. Entries appended meanwhile then fold incrementally. `batchSize`
   * does not apply to the canonical batch (its ops are per item, not per
   * event).
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
  /** True when stored scores were refolded because the half-lives or the burst window changed. */
  readonly rebuilt: boolean;
  /**
   * True when an out-of-order rename record, or (with the burst rule) a late
   * event, made this call replace the scores with the whole log folded canonically
   * (see the top of this file).
   */
  readonly refolded?: boolean;
  /** How many batches were discarded because another folder got there first. */
  readonly conflicts: number;
  /**
   * Of `events`, how many the burst rule dropped (counted nothing). Present
   * only when folding with a burst window > 0.
   */
  readonly collapsed?: number;
}

export const DEFAULT_FOLD_BATCH_SIZE = 5000;

/** One batch's ops, ready for `applyFold`, and what it counted. */
interface BatchPlan {
  readonly ops: ScoreOp[];
  readonly toCursor: number;
  readonly events: number;
  readonly renames: number;
  /** Events the burst rule dropped. */
  readonly collapsed: number;
}

/** Collects `add` contributions per (item, kind, half-life) until flushed. */
class Contributions {
  private readonly halfLives: HalfLives;
  private readonly names: readonly string[];
  // item -> "kind\0halfLife" -> contributions
  private pending = new Map<string, Map<string, number[]>>();

  constructor(halfLives: HalfLives, names: readonly string[]) {
    this.halfLives = halfLives;
    this.names = names;
  }

  add(item: string, kind: EventKind, time: number): void {
    let byKey = this.pending.get(item);
    if (!byKey) this.pending.set(item, (byKey = new Map()));
    for (const name of this.names) {
      const key = `${kind}\0${name}`;
      let list = byKey.get(key);
      if (!list) byKey.set(key, (list = []));
      list.push(eventScore(1, time, this.halfLives[name] as number));
    }
  }

  flush(ops: ScoreOp[]): void {
    for (const [item, byKey] of this.pending) {
      for (const [key, list] of byKey) {
        const [kind, halfLife] = key.split('\0') as [EventKind, string];
        ops.push({ type: 'add', item, kind, halfLife, logScore: combineAll(list) });
      }
    }
    this.pending = new Map();
  }
}

/**
 * A batch without the burst rule: every event counts. With `canonical`,
 * `known` holds every rename and renames are no moves; otherwise it holds
 * the renames folded before this batch, and each rename is a move.
 */
function plainBatch(
  entries: readonly LogEntry[],
  known: RenameIndex,
  canonical: boolean,
  halfLives: HalfLives,
  names: readonly string[],
): BatchPlan {
  const ops: ScoreOp[] = [];
  const pending = new Contributions(halfLives, names);
  let events = 0;
  let renames = 0;
  for (const entry of entries) {
    if (entry.kind === 'rename') {
      if (!canonical) {
        pending.flush(ops);
        ops.push({ type: 'move', from: entry.item, to: entry.to });
        known.add(entry);
      }
      renames++;
      continue;
    }
    pending.add(known.resolve(entry.item, entry.time), entry.kind, entry.time);
    events++;
  }
  pending.flush(ops);
  const toCursor = (entries[entries.length - 1] as LogEntry).seq;
  return { ops, toCursor, events, renames, collapsed: 0 };
}

/**
 * The canonical fold of the whole log as one batch (`reset`): every event
 * resolved through every rename record by time (./renames.ts), renames as no
 * moves, and, with a burst window, only the events `countBursts` counts,
 * with each group's last counted time. Applied atomically in place of the
 * stored scores, so no other folder ever sees, or builds on, a partial
 * refold. The ops are one per (item, kind, half-life), however long the log.
 */
async function canonicalBatch(
  log: EventLog,
  window: number,
  halfLives: HalfLives,
  names: readonly string[],
): Promise<BatchPlan> {
  const all = await log.readAfter(0);
  const known = new RenameIndex();
  for (const e of all) if (e.kind === 'rename') known.add(e);
  const events = all.filter((e): e is StoredEvent => e.kind !== 'rename');
  const items = events.map((e) => known.resolve(e.item, e.time));
  const counted =
    window > 0
      ? countBursts(
          events.map((e, i) => ({ key: burstKey(e.kind, items[i] as string), time: e.time })),
          window,
        ).counted
      : null;
  const ops: ScoreOp[] = [];
  const pending = new Contributions(halfLives, names);
  const last = new Map<string, { item: string; kind: EventKind; time: number }>();
  let collapsed = 0;
  events.forEach((e, i) => {
    if (counted && !counted[i]) {
      collapsed++;
      return;
    }
    const item = items[i] as string;
    pending.add(item, e.kind, e.time);
    if (counted) {
      const key = burstKey(e.kind, item);
      const was = last.get(key);
      if (!was || was.time < e.time) last.set(key, { item, kind: e.kind, time: e.time });
    }
  });
  pending.flush(ops);
  for (const { item, kind, time } of last.values()) ops.push({ type: 'last', item, kind, time });
  return {
    ops,
    toCursor: all.at(-1)?.seq ?? 0,
    events: events.length,
    renames: all.length - events.length,
    collapsed,
  };
}

/**
 * An incremental batch with the burst rule, deciding each event from the
 * stored last counted time of its (item, kind) (`burstDecision`). Returns
 * `'refold'` when that cannot be exact: an event dated before its group's
 * last counted event (it arrived late, through sync or an import), or a
 * rename that merges two items that both have events of one kind.
 */
async function incrementalBurstBatch(
  entries: readonly LogEntry[],
  known: RenameIndex,
  scores: ScoreStore,
  window: number,
  halfLives: HalfLives,
  names: readonly string[],
): Promise<BatchPlan | 'refold'> {
  const state = new Map<string, number>(); // burstKey -> last counted time
  const loaded = new Set<string>();
  const load = async (items: Iterable<string>): Promise<void> => {
    const want = [...new Set(items)].filter((i) => !loaded.has(i));
    if (want.length === 0) return;
    for (const item of want) loaded.add(item);
    for (const [item, kinds] of await scores.burstState(want)) {
      for (const kind of EVENT_KINDS) {
        const t = kinds[kind];
        if (t !== undefined) state.set(burstKey(kind, item), t);
      }
    }
  };
  // Prefetch what the batch most likely touches; anything else loads on demand.
  const guess: string[] = [];
  for (const e of entries) {
    guess.push(e.item);
    if (e.kind === 'rename') guess.push(e.to);
    else guess.push(known.resolve(e.item, e.time));
  }
  await load(guess);

  const ops: ScoreOp[] = [];
  const pending = new Contributions(halfLives, names);
  const dirty = new Map<string, { item: string; kind: EventKind }>();
  const flush = (): void => {
    pending.flush(ops);
    for (const [key, { item, kind }] of dirty) {
      ops.push({ type: 'last', item, kind, time: state.get(key) as number });
    }
    dirty.clear();
  };
  let events = 0;
  let renames = 0;
  let collapsed = 0;
  for (const entry of entries) {
    if (entry.kind === 'rename') {
      flush();
      await load([entry.item, entry.to]);
      for (const kind of EVENT_KINDS) {
        const from = burstKey(kind, entry.item);
        const to = burstKey(kind, entry.to);
        const lf = state.get(from);
        if (lf === undefined) continue;
        if (state.has(to)) return 'refold';
        state.set(to, lf);
        state.delete(from);
      }
      ops.push({ type: 'move', from: entry.item, to: entry.to });
      known.add(entry);
      renames++;
      continue;
    }
    const item = known.resolve(entry.item, entry.time);
    await load([item]);
    const key = burstKey(entry.kind, item);
    const decision = burstDecision(state.get(key), entry.time, window);
    if (decision === 'late') return 'refold';
    events++;
    if (decision === 'drop') {
      collapsed++;
      continue;
    }
    state.set(key, entry.time);
    dirty.set(key, { item, kind: entry.kind });
    pending.add(item, entry.kind, entry.time);
  }
  flush();
  const toCursor = (entries[entries.length - 1] as LogEntry).seq;
  return { ops, toCursor, events, renames, collapsed };
}

/**
 * Folds every log entry after the stored cursor into the score store, in
 * batches, each committed atomically with the cursor. Safe to run from
 * several processes at once: a batch computed from a cursor that another
 * folder has since advanced is discarded and recomputed.
 *
 * The invariant every committed state keeps: the stored scores at cursor `c`
 * are the canonical fold of the log's entries through seq `c`. An
 * incremental batch keeps it only when its renames can fold as moves
 * (`outOfOrderRename`) and its events can be decided from the burst state;
 * otherwise, and when the half-lives or burst window changed, the fold
 * replaces the scores with the canonical fold of the whole log in one
 * atomic batch (`canonicalBatch`), checked against the cursor like any
 * other. A refold is never split into batches, and never follows a separate
 * `clear()`, so a concurrent folder's batch cannot land between its steps.
 */
export async function foldPending(
  log: EventLog,
  scores: ScoreStore,
  options: FoldPendingOptions = {},
): Promise<FoldResult> {
  const halfLives: HalfLives = options.halfLives ?? HALF_LIVES;
  assertValidHalfLives(halfLives);
  const window = options.burstWindow ?? 0;
  assertValidBurstWindow(window);
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
  let collapsed = 0;
  let rebuilt = false;
  let refolded = false;
  /** The next batch must be the canonical fold of the whole log. */
  let canonical = options.canonical ?? false;

  for (;;) {
    const state = await scores.foldState();
    if (state.halfLives && !sameHalfLives(state.halfLives, halfLives)) {
      if (options.onHalfLifeMismatch === 'throw') {
        throw new HalfLifeMismatchError(state.halfLives, halfLives);
      }
      canonical = true;
      rebuilt = true;
    } else if (state.halfLives && foldBurstWindow(state) !== window) {
      if (options.onHalfLifeMismatch === 'throw') {
        throw new BurstWindowMismatchError(foldBurstWindow(state), window);
      }
      canonical = true;
      rebuilt = true;
    }

    let batch: BatchPlan | 'refold';
    let reset = false;
    if (canonical) {
      batch = await canonicalBatch(log, window, halfLives, names);
      reset = true;
    } else {
      const entries = await log.readAfter(state.cursor, { limit: batchSize });
      if (entries.length === 0) {
        return {
          events,
          renames,
          cursor: state.cursor,
          batches,
          rebuilt,
          ...(refolded ? { refolded } : {}),
          conflicts,
          ...(window > 0 ? { collapsed } : {}),
        };
      }
      if (await outOfOrderRename(log, state.cursor, entries)) {
        batch = 'refold';
      } else {
        const known = new RenameIndex();
        for (const r of await log.renames({ throughSeq: state.cursor })) known.add(r);
        batch =
          window > 0
            ? await incrementalBurstBatch(entries, known, scores, window, halfLives, names)
            : plainBatch(entries, known, false, halfLives, names);
      }
    }
    if (batch === 'refold') {
      canonical = true;
      refolded = true;
      continue;
    }

    try {
      await scores.applyFold({
        fromCursor: state.cursor,
        toCursor: batch.toCursor,
        halfLives,
        ...(window > 0 ? { burstWindow: window } : {}),
        ...(reset ? { reset: true } : {}),
        ops: batch.ops,
      });
    } catch (error) {
      if (error instanceof FoldConflictError) {
        if (++conflicts > maxRetries) throw error;
        continue;
      }
      throw error;
    }
    if (reset) {
      // The canonical fold replaced everything: it counts the whole log.
      events = batch.events;
      renames = batch.renames;
      collapsed = batch.collapsed;
      canonical = false;
    } else {
      events += batch.events;
      renames += batch.renames;
      collapsed += batch.collapsed;
    }
    batches++;
  }
}

/**
 * True when folding the renames among `entries` (the batch after `cursor`)
 * as moves, in arrival order, could give other scores than the canonical
 * rule (./renames.ts). A move is exact when the rename is dated at or after
 * every entry before it, and no rename before it at the same second
 * interacts with it, since renames at one second are simultaneous while
 * moves are not. Two such renames interact when this one starts where the
 * earlier one ends (moving it would carry the earlier one's history
 * further), or when both rename one item and this one has the smaller id
 * (it, not the earlier one, is the rename that applies). Renames at one
 * second that touch other items commute, so their arrival order never matters.
 */
async function outOfOrderRename(
  log: EventLog,
  cursor: number,
  entries: readonly LogEntry[],
): Promise<boolean> {
  const firstRename = entries.findIndex((e) => e.kind === 'rename');
  if (firstRename < 0) return false;
  let latest = -Infinity;
  /** Renames dated `latest`, in arrival order. */
  let sameSecond: StoredRename[] = [];
  const see = (e: LogEntry): void => {
    if (e.time > latest) {
      latest = e.time;
      sameSecond = [];
    }
    if (e.kind === 'rename' && e.time === latest) sameSecond.push(e);
  };
  if (cursor > 0) {
    for (const e of await log.readAfter(0, { limit: cursor })) if (e.seq <= cursor) see(e);
  }
  for (const e of entries) {
    if (e.kind === 'rename') {
      if (e.time < latest) return true;
      if (e.time === latest) {
        for (const r of sameSecond) {
          if (r.to === e.item) return true;
          if (r.item === e.item && compareStrings(e.id, r.id) < 0) return true;
        }
      }
    }
    see(e);
  }
  return false;
}

/**
 * Replaces the stored scores with the whole log folded again, canonically
 * and atomically: each event lands where the rename records say by time,
 * whatever order the log holds them in, so every copy with the same entries
 * gets the same scores. Entries appended meanwhile are folded after it.
 */
export async function rebuildScores(
  log: EventLog,
  scores: ScoreStore,
  options: FoldPendingOptions = {},
): Promise<FoldResult> {
  const result = await foldPending(log, scores, { ...options, canonical: true });
  return { ...result, rebuilt: true };
}
