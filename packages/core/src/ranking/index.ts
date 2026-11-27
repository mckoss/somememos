// Ranking (PLAN.md section 5; IMPLEMENTATION.md tasks 1.12–1.14): keyword
// relevance combined with TimeScore activation, the four modes, optional link
// spreading, and results that explain their rank. Every parameter is a
// placeholder until `somememos eval` measures it. Isomorphic.

export {
  DEFAULT_RANKING_PARAMS,
  RANK_MODES,
  isRankMode,
  rankingParamsFromConfig,
  resolveRankingParams,
  spreadingActive,
  validateRankingParams,
  type ActivationFloor,
  type KeywordCombination,
  type ModeHalfLives,
  type RankMode,
  type RankingParams,
  type RankingParamsInput,
  type SpreadDirection,
  type SpreadingParams,
} from './params.js';
export {
  NO_LINKS,
  itemActivation,
  linkGraphFromMaps,
  modeSignal,
  neighborsOf,
  weightedTotals,
  type Activation,
  type LinkGraph,
  type ScoreMap,
} from './activation.js';
export {
  classifyItem,
  groupHitsByNote,
  rank,
  rankByActivation,
  rankKeywordHits,
  type NoteMeta,
  type RankComponents,
  type RankContext,
  type RankedResult,
  type SectionHit,
} from './rank.js';
export { loadLinkGraph, rankActivation, rankSearch, type RankSearchOptions } from './stores.js';
export { decayed, type DecayedView } from './decayed.js';
