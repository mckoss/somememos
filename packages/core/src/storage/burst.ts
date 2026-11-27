// The burst rule (PLAN.md section 4, "The event log": rules that treat events
// differently are applied when the log is folded; section 5, "First
// experiment results": a one-hour window, measured on 2026-11-27).
//
// Of one item's events of one kind, taken in time order, an event counts only
// if it is at least `window` seconds after the last *counted* one. So a burst
// of saves counts once, at its first event, and a long session of saves
// counts once per window. `window = 0` turns the rule off (every event
// counts). "One item" is the item an event lands on after rename records
// (`RenameIndex.resolve`), so a renamed note's history, and its last counted
// time, follow it.
//
// This file is the one implementation: the live fold (./fold.ts, every store)
// and the evaluation harness (evaluation/log.ts) both call it. The decision
// for an event depends only on earlier events of its (item, kind), so the
// counted set is a function of the set of events, never of the order they
// arrived in. Events at the same second count once whichever arrived first,
// and so give the same scores.

import type { EventKind } from '../timescore/kinds.js';

/**
 * The default burst window in seconds: one hour, chosen by experiment on
 * 2026-11-27 (PLAN.md section 5, "First experiment results"). A brain's
 * config (`BrainConfig.burstWindow`) can change it; changing it rebuilds the
 * scores from the event log.
 */
export const DEFAULT_BURST_WINDOW = 3600;

/** Throws a RangeError unless `window` is a finite number of seconds >= 0. */
export function assertValidBurstWindow(window: number): void {
  if (typeof window !== 'number' || !Number.isFinite(window) || window < 0) {
    throw new RangeError(`burst window must be a finite number of seconds >= 0, not ${window}`);
  }
}

/**
 * What the rule does with an event at `time`, given the last counted time of
 * its (item, kind) so far (`undefined`: none yet):
 *
 * - `'count'`: it counts, and `time` becomes the last counted time;
 * - `'drop'`: it is within `window` of the last counted one;
 * - `'late'`: it is dated before the last counted one, so it may change which
 *   later events count; only a fold over the whole group in time order can
 *   decide (`countBursts`).
 *
 * With every event of the group dated at or after `last`, deciding in arrival
 * order this way gives exactly what `countBursts` gives.
 */
export function burstDecision(
  last: number | undefined,
  time: number,
  window: number,
): 'count' | 'drop' | 'late' {
  if (last === undefined || window === 0) return 'count';
  if (time < last) return 'late';
  return time - last >= window ? 'count' : 'drop';
}

/** One event for `countBursts`: its group key (item and kind) and time. */
export interface BurstEvent {
  /** Identifies the (item, kind) group, e.g. `burstKey(kind, item)`. */
  readonly key: string;
  readonly time: number;
}

/** The group key `countBursts` and the fold use: `kind\0item`. */
export function burstKey(kind: EventKind, item: string): string {
  return `${kind}\0${item}`;
}

/**
 * Applies the burst rule to a whole set of events, in any order: within each
 * group, in time order (ties in input order), an event counts when
 * `burstDecision` says so. Returns, per input index, whether it counts, and
 * each group's last counted time.
 */
export function countBursts(
  events: readonly BurstEvent[],
  window: number,
): { readonly counted: boolean[]; readonly last: Map<string, number> } {
  assertValidBurstWindow(window);
  const groups = new Map<string, number[]>();
  events.forEach((e, i) => {
    let list = groups.get(e.key);
    if (!list) groups.set(e.key, (list = []));
    list.push(i);
  });
  const counted = new Array<boolean>(events.length).fill(false);
  const last = new Map<string, number>();
  for (const [key, list] of groups) {
    list.sort((a, b) => (events[a] as BurstEvent).time - (events[b] as BurstEvent).time || a - b);
    let at: number | undefined;
    for (const i of list) {
      const time = (events[i] as BurstEvent).time;
      if (burstDecision(at, time, window) === 'count') {
        counted[i] = true;
        at = time;
      }
    }
    if (at !== undefined) last.set(key, at);
  }
  return { counted, last };
}
