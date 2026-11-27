// Evaluation (PLAN.md section 5, "Evaluation: experiments decide the scoring";
// IMPLEMENTATION.md tasks 1.19–1.22): metrics, cases, replaying the event log
// with experimental settings, and aggregate reports. Isomorphic.
//
// Privacy: cases and per-case detail built from a real brain are private. Keep
// them inside the brain's `.somememos/` directory; only aggregate numbers may
// be recorded in this repository.

export {
  DEFAULT_KS,
  aggregate,
  meanReciprocalRank,
  recallAtK,
  reciprocalRank,
  type Aggregate,
  type ScoredCase,
} from './metrics.js';
export {
  collapseBursts,
  isRename,
  timeOrdered,
  type BurstOptions,
  type ReplayEntry,
  type ReplayEvent,
  type ReplayRename,
} from './log.js';
export {
  buildOrientationCases,
  seededRandom,
  type EvalCase,
  type OrientationOptions,
  type OrientationResult,
} from './cases.js';
export {
  runReplay,
  type CaseDetail,
  type EvalReport,
  type EvalSetting,
  type FoldSettings,
  type ReplayOptions,
  type SettingReport,
} from './replay.js';
export { expandGrid, type GridBase, type SettingsGrid } from './grid.js';
export { formatReportText, reportToJson, type FormatOptions, type JsonOptions } from './report.js';
