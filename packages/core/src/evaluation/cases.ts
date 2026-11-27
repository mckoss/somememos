// Evaluation cases (PLAN.md section 5; IMPLEMENTATION.md task 1.21), and the
// orientation case builder. Cases built from a real brain are private: keep
// them, and any per-case output, inside the brain's `.somememos/` directory.

import type { EventKind } from '../timescore/kinds.js';
import { isRename, timeOrdered, type ReplayEntry, type ReplayRename } from './log.js';

/**
 * One evaluation case. A null `query` is an orientation case: "what's on my
 * mind" at `time`, ranked by activation alone.
 */
export interface EvalCase {
  readonly id: string;
  /** Unix seconds. Only events strictly before it are folded. */
  readonly time: number;
  readonly query: string | null;
  /** The right items (note paths or dangling keys), as named at `time`. */
  readonly answers: readonly string[];
}

/** A small, fast, seeded PRNG (mulberry32): the same seed gives the same sequence. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface OrientationOptions {
  /** PRNG seed. Default 1. */
  readonly seed?: number;
  /** How many times to sample. Default 100. Times that fail a check are skipped, not replaced. */
  readonly samples?: number;
  /** The look-ahead window in seconds: answers are items with events in `[t, t + window)`. Default one week. */
  readonly window?: number;
  /** Skip a time with fewer events before it than this. Default 20. */
  readonly minHistory?: number;
  /** Skip a time with fewer answers than this. Default 1. */
  readonly minAnswers?: number;
  /** Sample times in `[start, end − window]`. Default: the first and last event times. */
  readonly start?: number;
  readonly end?: number;
  /** Event kinds that make an item an answer. Default: every kind. */
  readonly answerKinds?: readonly EventKind[];
  /** Keep only answers this accepts (for example memo notes), given the item's name at the case time. */
  readonly isAnswer?: (item: string, time: number) => boolean;
  /** Case id prefix. Default `'orientation'`. */
  readonly idPrefix?: string;
}

export interface OrientationResult {
  readonly cases: EvalCase[];
  /** Sampled times skipped for too little history, or too few answers. */
  readonly skipped: { readonly history: number; readonly answers: number };
}

/**
 * The name at time `t` of an item that is called `name` at a later time
 * `later`: undo the renames to `name` in `[t, later]`, latest first.
 */
function nameAt(name: string, t: number, later: number, renames: readonly ReplayRename[]): string {
  let current = name;
  let before = later;
  for (let i = renames.length - 1; i >= 0; i--) {
    const r = renames[i] as ReplayRename;
    if (r.time > before || r.time < t) continue;
    if (r.to === current) {
      current = r.item;
      before = r.time;
    }
  }
  return current;
}

/**
 * Orientation cases from the log: at seeded sample times `t` (whole seconds,
 * sorted, distinct), the answers are the items with events in
 * `[t, t + window)`, named as they were at `t`. History is the events before
 * `t`. Deterministic for a seed and a log, whatever the log's order.
 */
export function buildOrientationCases(
  log: readonly ReplayEntry[],
  options: OrientationOptions = {},
): OrientationResult {
  const seed = options.seed ?? 1;
  const samples = options.samples ?? 100;
  const window = options.window ?? 7 * 86_400;
  const minHistory = options.minHistory ?? 20;
  const minAnswers = options.minAnswers ?? 1;
  const kinds = options.answerKinds ? new Set<string>(options.answerKinds) : null;
  const prefix = options.idPrefix ?? 'orientation';
  if (!(window > 0)) throw new RangeError(`window must be > 0, not ${window}`);

  const ordered = timeOrdered(log);
  const events = ordered.filter((e) => !isRename(e));
  const renames = ordered.filter(isRename);
  if (events.length === 0) return { cases: [], skipped: { history: 0, answers: 0 } };

  const start = options.start ?? (events[0] as ReplayEntry).time;
  const end = (options.end ?? (events[events.length - 1] as ReplayEntry).time) - window;
  const random = seededRandom(seed);
  const times = new Set<number>();
  if (end >= start) {
    for (let i = 0; i < samples; i++) times.add(Math.floor(start + random() * (end - start + 1)));
  }

  // First index with time >= t.
  const lowerBound = (t: number): number => {
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((events[mid] as ReplayEntry).time < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const cases: EvalCase[] = [];
  let skippedHistory = 0;
  let skippedAnswers = 0;
  for (const t of [...times].sort((a, b) => a - b)) {
    const from = lowerBound(t);
    if (from < minHistory) {
      skippedHistory++;
      continue;
    }
    const to = lowerBound(t + window);
    const answers = new Set<string>();
    for (let i = from; i < to; i++) {
      const e = events[i] as ReplayEntry;
      if (isRename(e) || (kinds && !kinds.has(e.kind))) continue;
      const name = nameAt(e.item, t, e.time, renames);
      if (!options.isAnswer || options.isAnswer(name, t)) answers.add(name);
    }
    if (answers.size < minAnswers || answers.size === 0) {
      skippedAnswers++;
      continue;
    }
    cases.push({ id: `${prefix}-${t}`, time: t, query: null, answers: [...answers].sort() });
  }
  return { cases, skipped: { history: skippedHistory, answers: skippedAnswers } };
}
