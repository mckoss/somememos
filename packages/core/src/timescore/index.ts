// TimeScore for somememos. TimeScore algorithm courtesy Mike Koss
// (https://mckoss.com/posts/timescore/).
export { EMPTY, addEvent, combine, combineAll, eventScore, scoreAt } from './timescore.js';
export type { LogScore } from './timescore.js';
export { HALF_LIFE_ENTRIES, HALF_LIFE_NAMES, HALF_LIVES, isHalfLifeName } from './halfLives.js';
export type { HalfLifeName } from './halfLives.js';
export { EVENT_KINDS, isEventKind } from './kinds.js';
export type { EventKind } from './kinds.js';
export { UNIT_WEIGHTS, assertValidWeights, weightedTotal } from './weights.js';
export type { ScoresByKind, Weights } from './weights.js';
export {
  STEADY_TRENDING_RATIO,
  logScoreDifference,
  neglected,
  ratioAt,
  steadyRatio,
  trending,
} from './signals.js';
export { FutureEventError, InvalidEventError, assertValidEvent, foldEvents } from './events.js';
export type { FoldOptions, ItemScores, ScoreEvent } from './events.js';
