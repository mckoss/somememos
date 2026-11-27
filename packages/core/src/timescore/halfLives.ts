// The half-lives somememos keeps a log score for (PLAN.md section 3), in
// seconds. Changing one requires rebuilding scores from the event log.

const DAY = 86_400;

/** Half-life lengths in seconds, by name. */
export const HALF_LIVES = Object.freeze({
  /** What I'm doing right now. */
  day: DAY,
  /** Current focus. */
  week: 7 * DAY,
  /** Ongoing projects. */
  month: 30 * DAY,
  /** The long-term self. */
  year: 365 * DAY,
} as const);

/** The name of a half-life: `'day' | 'week' | 'month' | 'year'`. */
export type HalfLifeName = keyof typeof HALF_LIVES;

/** Every half-life name, shortest first. */
export const HALF_LIFE_NAMES: readonly HalfLifeName[] = Object.freeze([
  'day',
  'week',
  'month',
  'year',
]);

/** Every `[name, seconds]` pair, shortest first. */
export const HALF_LIFE_ENTRIES: readonly (readonly [HalfLifeName, number])[] = Object.freeze(
  HALF_LIFE_NAMES.map((name) => Object.freeze([name, HALF_LIVES[name]] as const)),
);

/** Whether `name` is one of the half-life names. */
export function isHalfLifeName(name: unknown): name is HalfLifeName {
  return typeof name === 'string' && Object.hasOwn(HALF_LIVES, name);
}
