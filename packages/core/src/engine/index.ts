// The brain engine (IMPLEMENTATION.md tasks 2.0 and 2.2): `createEngine` over
// a brain's stores, content and config, with plain-data requests and results
// that every host (the CLI, the web app's worker, later the server) calls.
// The engine conformance suite is a separate, test-only entry point:
// `@somememos/core/testing/engine`.

export {
  DEFAULT_RESULT_LIMIT,
  type EngineOptions,
  createEngine,
  finite,
  localDate,
  normalizeNotePath,
  parseExport,
  pathCovers,
} from './engine.js';
export {
  EngineError,
  isEngineError,
  type ChangeOptions,
  type CommitOptions,
  type CommitResult,
  type DeleteResult,
  type DiaryEntry,
  type DiaryPath,
  type Engine,
  type EngineErrorCode,
  type EngineStatus,
  type ExportRecord,
  type Finite,
  type ImportResult,
  type IndexOptions,
  type ListOptions,
  type LogOptions,
  type NoteTitle,
  type NoteView,
  type ReadNoteOptions,
  type RenameResult,
  type ResultView,
  type SaveNoteOptions,
  type SaveResult,
  type SearchOptions,
  type SearchResponse,
  type SectionView,
} from './types.js';
