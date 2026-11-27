// Storage, as operations rather than SQL (PLAN.md section 9): the interfaces
// every database implements, the folding logic over them, the in-memory
// reference implementation, and the brain config. Isomorphic: no Node
// built-ins. The conformance suite is a separate, test-only entry point:
// `@somememos/core/testing/storage`.

export type {
  AnalyzerMismatch,
  AppendOptions,
  AppendResult,
  Awaitable,
  BurstState,
  ChangeFilter,
  ChangeInput,
  ChangeRecord,
  DanglingCount,
  EventInput,
  EventLog,
  FoldBatch,
  FoldState,
  HalfLives,
  LogEntry,
  LogInput,
  LogKind,
  MetaStore,
  NoteLink,
  NoteRecord,
  NoteRole,
  NoteStore,
  RenameInput,
  ScoreOp,
  ScoreStore,
  SectionInput,
  StoredEvent,
  StoredRename,
  StoredSection,
  Stores,
  StoresOptions,
  TermIndex,
} from './types.js';
export {
  BurstWindowMismatchError,
  FoldConflictError,
  HalfLifeMismatchError,
  MigrationRequiredError,
} from './types.js';
export {
  DEFAULT_CHANGE_OPS,
  MAX_ID_LENGTH,
  analyzerFromJson,
  analyzerToJson,
  assertValidChangeInput,
  assertValidHalfLives,
  assertValidLogInput,
  assertValidNote,
  assertValidScoreOp,
  changeOp,
  compareAnalyzers,
  compareStrings,
  danglingCounts,
  foldBurstWindow,
  halfLivesToJson,
  linkDisplay,
  pickDanglingDisplay,
  newEvent,
  newId,
  newRename,
  normalizeChangePaths,
  parseSectionId,
  sameHalfLives,
  sectionId,
  unixNow,
} from './validate.js';
export { decodePositions, encodePositions } from './positions.js';
export {
  DEFAULT_FOLD_BATCH_SIZE,
  type FoldPendingOptions,
  type FoldResult,
  foldPending,
  rebuildScores,
} from './fold.js';
export {
  DEFAULT_BURST_WINDOW,
  type BurstEvent,
  assertValidBurstWindow,
  burstDecision,
  burstKey,
  countBursts,
} from './burst.js';
export { RenameIndex, type RenameLike } from './renames.js';
export {
  MemoryBrainData,
  type MemoryStores,
  type MemoryStoresOptions,
  createMemoryStores,
} from './memory.js';
export {
  type BrainConfig,
  CONFIG_VERSION,
  ConfigError,
  defaultBrainConfig,
  foldOptions,
  parseBrainConfig,
  serializeBrainConfig,
} from './config.js';
export {
  type ContentEntry,
  type ContentStore,
  type ContentWriteOptions,
  type MemoryContentStore,
  type MemoryContentStoreOptions,
  contentFingerprint,
  contentHash,
  createMemoryContentStore,
  sha256Hex,
  utf8Length,
} from './content.js';
