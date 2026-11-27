// The event log as the evaluation harness reads it, time-ordered, and the
// fold-time rules an experiment can switch on (PLAN.md section 4: rules such
// as counting a burst of saves as one edit are applied when the log is folded,
// so they stay tunable).

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
  /** Seconds. An event of the same kind on the same item less than this after the burst's first kept event is dropped. */
  readonly window: number;
  /** Kinds the rule applies to. Default: every kind. */
  readonly kinds?: readonly EventKind[];
}

/**
 * Collapses bursts: of the events of one kind on one item, keep an event
 * when it is at least `window` seconds after the last kept one; drop it
 * otherwise. So a burst is counted once, at its first event, and a long
 * session of saves counts once per `window`. Causal (each decision uses only
 * earlier events), so replaying up to any time sees the same kept events.
 * Items are matched by name as logged; renames pass through unchanged.
 * Expects time-ordered input (`timeOrdered`).
 */
export function collapseBursts<E extends ReplayEntry>(
  entries: readonly E[],
  options: BurstOptions,
): E[] {
  const { window } = options;
  if (!Number.isFinite(window) || window < 0) {
    throw new RangeError(`burst window must be a finite number >= 0, not ${window}`);
  }
  if (window === 0) return [...entries];
  const kinds = options.kinds ? new Set<string>(options.kinds) : null;
  const lastKept = new Map<string, number>();
  const out: E[] = [];
  for (const entry of entries) {
    if (isRename(entry) || (kinds && !kinds.has(entry.kind))) {
      out.push(entry);
      continue;
    }
    const key = `${entry.kind}\0${entry.item}`;
    const last = lastKept.get(key);
    if (last !== undefined && entry.time - last < window) continue;
    lastKept.set(key, entry.time);
    out.push(entry);
  }
  return out;
}
