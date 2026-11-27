// The event log as the evaluation harness reads it, time-ordered, and the
// fold-time rules an experiment can switch on (PLAN.md section 4: rules such
// as counting a burst of saves as one edit are applied when the log is folded,
// so they stay tunable).

import { assertValidBurstWindow, burstKey, countBursts } from '../storage/burst.js';
import { RenameIndex } from '../storage/renames.js';
import type { EventKind } from '../timescore/kinds.js';

/** An event. `storage.StoredEvent` and `storage.EventInput` fit. */
export interface ReplayEvent {
  readonly kind: EventKind;
  readonly item: string;
  readonly time: number;
  readonly seq?: number;
}

/** A rename record: from `time` on, `item` is called `to`. `storage.StoredRename` fits. */
export interface ReplayRename {
  readonly kind: 'rename';
  readonly item: string;
  readonly to: string;
  readonly time: number;
  readonly seq?: number;
  /**
   * The record's id: the tie-break between renames of one item at one second
   * (`storage.RenameIndex`). Give it whenever the log has it; without one,
   * ties go to the rename that comes first in `timeOrdered` order.
   */
  readonly id?: string;
}

export type ReplayEntry = ReplayEvent | ReplayRename;

export function isRename(entry: ReplayEntry): entry is ReplayRename {
  return entry.kind === 'rename';
}

/**
 * The entries in replay order: by time; at equal times events before renames
 * (an event dated at a rename's time counts toward the new name, as in
 * `storage.foldPending`), then by `seq` when given, then in input order.
 */
export function timeOrdered<E extends ReplayEntry>(entries: readonly E[]): E[] {
  return entries
    .map((entry, i) => ({ entry, i }))
    .sort(
      (a, b) =>
        a.entry.time - b.entry.time ||
        Number(isRename(a.entry)) - Number(isRename(b.entry)) ||
        (a.entry.seq ?? 0) - (b.entry.seq ?? 0) ||
        a.i - b.i,
    )
    .map(({ entry }) => entry);
}

/** The burst rule. `window = 0` turns it off. */
export interface BurstOptions {
  /**
   * Seconds. Of one item's events of one kind, an event less than this after
   * the last counted one is dropped (`storage.countBursts`).
   */
  readonly window: number;
  /** Kinds the rule applies to. Default: every kind (as the live fold does). */
  readonly kinds?: readonly EventKind[];
}

/**
 * Collapses bursts with the same rule, and the same code, as the live fold
 * (`storage.countBursts`, `BrainConfig.burstWindow`): of the events of one
 * kind on one item, keep an event when it is at least `window` seconds after
 * the last kept one; drop it otherwise. So a burst is counted once, at its
 * first event, and a long session of saves counts once per `window`. The
 * item is the one an event lands on after every rename record in `entries`
 * (`storage.RenameIndex`), so a renamed note's bursts continue across the
 * rename, exactly as a rebuild of the live scores counts them. Each decision
 * uses only earlier events of the group; which events form a group can
 * depend on a later rename only when that rename merges two items that both
 * had events of one kind (rare). Renames pass through unchanged. Accepts
 * entries in any order and returns the kept ones in input order.
 */
export function collapseBursts<E extends ReplayEntry>(
  entries: readonly E[],
  options: BurstOptions,
): E[] {
  const { window } = options;
  assertValidBurstWindow(window);
  if (window === 0) return [...entries];
  const kinds = options.kinds ? new Set<string>(options.kinds) : null;
  const known = new RenameIndex();
  entries.forEach((e) => {
    if (isRename(e)) known.add({ item: e.item, to: e.to, time: e.time, id: e.id ?? '' });
  });
  const subject: number[] = [];
  entries.forEach((e, i) => {
    if (!isRename(e) && (!kinds || kinds.has(e.kind))) subject.push(i);
  });
  const { counted } = countBursts(
    subject.map((i) => {
      const e = entries[i] as ReplayEvent;
      return { key: burstKey(e.kind, known.resolve(e.item, e.time)), time: e.time };
    }),
    window,
  );
  const dropped = new Set<number>();
  subject.forEach((i, j) => {
    if (!counted[j]) dropped.add(i);
  });
  return entries.filter((_, i) => !dropped.has(i));
}
