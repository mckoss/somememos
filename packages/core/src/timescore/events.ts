// Recording guard and folding the event log into scores (PLAN.md section 4,
// "The event log"). Each event adds its value (1 unless given) to the log
// score for its (item, kind, half-life). Weights are applied at read time.

import { HALF_LIVES, type HalfLifeName } from './halfLives.js';
import { EVENT_KINDS, isEventKind, type EventKind } from './kinds.js';
import { combineAll, eventScore } from './timescore.js';
import type { ScoresByKind } from './weights.js';

/** One event as it is scored. `time` is in Unix seconds; `value` defaults to 1. */
export interface ScoreEvent {
  item: string;
  kind: EventKind;
  time: number;
  value?: number;
}

/** An event that is malformed: unknown kind, non-finite time, value not finite and > 0. */
export class InvalidEventError extends RangeError {
  override name = 'InvalidEventError';
}

/** An event dated after `now`. Events are dated when the interaction happens. */
export class FutureEventError extends RangeError {
  readonly time: number;
  readonly now: number;
  override name = 'FutureEventError';
  constructor(time: number, now: number) {
    super(`event time ${time} is later than now (${now})`);
    this.time = time;
    this.now = now;
  }
}

/**
 * The guard used when recording an event. Throws `InvalidEventError` for an
 * unknown kind, a non-finite time, or a value that is not finite and > 0, and
 * `FutureEventError` if `time > now`. `now` must be finite.
 */
export function assertValidEvent(
  event: Pick<ScoreEvent, 'kind' | 'time' | 'value'>,
  now: number,
): void {
  if (!Number.isFinite(now)) throw new InvalidEventError(`now must be finite, not ${now}`);
  if (!isEventKind(event.kind)) {
    throw new InvalidEventError(`unknown event kind ${String(event.kind)}`);
  }
  if (typeof event.time !== 'number' || !Number.isFinite(event.time)) {
    throw new InvalidEventError(`event time must be finite, not ${String(event.time)}`);
  }
  const value = event.value ?? 1;
  if (typeof value !== 'number' || !Number.isFinite(value) || !(value > 0)) {
    throw new InvalidEventError(`event value must be finite and > 0, not ${String(value)}`);
  }
  if (event.time > now) throw new FutureEventError(event.time, now);
}

/** Options for `foldEvents`. */
export interface FoldOptions<H extends string = HalfLifeName> {
  /** Half-lives in seconds, by name. Defaults to `HALF_LIVES`. */
  halfLives?: Readonly<Record<H, number>>;
  /** If given, an event later than `now` throws `FutureEventError`. */
  now?: number;
}

/** An item's log scores: per half-life, per kind (only kinds with events). */
export type ItemScores<H extends string = HalfLifeName> = Record<H, ScoresByKind>;

/**
 * Fold events into per-(item, kind, half-life) log scores, unweighted.
 *
 * The result is the same, bit for bit, for any order of `events`: each
 * (item, kind, half-life) score is `combineAll` of its events' scores, and the
 * map's keys are sorted (by UTF-16 code units). It can differ in the last bits
 * from adding the same events one at a time with `addEvent`.
 *
 * Every event is checked as by `assertValidEvent` (the future check only when
 * `options.now` is given). Items with no events do not appear.
 */
export function foldEvents<H extends string = HalfLifeName>(
  events: Iterable<ScoreEvent>,
  options: FoldOptions<H> = {},
): Map<string, ItemScores<H>> {
  const halfLives = (options.halfLives ?? HALF_LIVES) as Readonly<Record<H, number>>;
  const names = Object.keys(halfLives) as H[];
  for (const name of names) {
    const h = halfLives[name];
    if (!Number.isFinite(h) || !(h > 0)) {
      throw new RangeError(`half-life ${name} must be finite and > 0, not ${h}`);
    }
  }
  // Without `now`, no finite time is in the future.
  const now = options.now ?? Number.MAX_VALUE;

  // item -> kind -> [value, time] pairs
  const grouped = new Map<string, Map<EventKind, [number, number][]>>();
  for (const event of events) {
    assertValidEvent(event, now);
    let byKind = grouped.get(event.item);
    if (!byKind) grouped.set(event.item, (byKind = new Map()));
    let list = byKind.get(event.kind);
    if (!list) byKind.set(event.kind, (list = []));
    list.push([event.value ?? 1, event.time]);
  }

  const result = new Map<string, ItemScores<H>>();
  for (const item of [...grouped.keys()].sort()) {
    const byKind = grouped.get(item) as Map<EventKind, [number, number][]>;
    const scores = {} as ItemScores<H>;
    for (const name of names) {
      const h = halfLives[name];
      const perKind: ScoresByKind = {};
      for (const kind of EVENT_KINDS) {
        const list = byKind.get(kind);
        if (list) perKind[kind] = combineAll(list.map(([v, t]) => eventScore(v, t, h)));
      }
      scores[name] = perKind;
    }
    result.set(item, scores);
  }
  return result;
}
