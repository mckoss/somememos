// The sync protocol (PLAN.md section 7, "Sync protocol (first version)"): its
// request and response shapes, limits and path rule, and an offline copy's
// sync state. The engine implements a copy's side (`Engine.prepareSync`,
// `Engine.applySync`, `engine.runSync`) and the store-as-is step both sides
// use (`Engine.applyRemote`). The wire shapes are valibot schemas
// (./schema.ts) the types are inferred from. Isomorphic.

export {
  NAME_CLASH,
  SYNC_CLOCK_SKEW,
  SYNC_LIMITS,
  type SyncChange,
  type SyncEdit,
  type SyncEditOp,
  type SyncEditResult,
  type SyncEditStatus,
  type SyncEvent,
  type SyncNote,
  type SyncRequest,
  type SyncResponse,
  conflictCopyPath,
  conflictPath,
  isSyncablePath,
  syncPathProblem,
  truncateChangeMessage,
} from './protocol.js';
export {
  BatchOpSchema,
  BatchRequestSchema,
  CHECKS,
  ClientIdSchema,
  ConfigPutRequestSchema,
  HashSchema,
  type Issue,
  MessageSchema,
  NotePathSchema,
  NoteTextSchema,
  type Parsed,
  SyncChangeSchema,
  SyncEditResultSchema,
  SyncEditSchema,
  SyncEventSchema,
  SyncNoteSchema,
  SyncRequestSchema,
  SyncResponseSchema,
  fitsUtf8,
  issueLocation,
  jsonObject,
  issueMessage,
  parseWith,
} from './schema.js';
export {
  EMPTY_SYNC_STATE,
  META_SYNC_STATE,
  type SyncState,
  clearSyncState,
  recordConfigRevision,
  readSyncState,
  writeSyncState,
} from './state.js';
export {
  ConfigChangedError,
  ConfigConflictError,
  type ConfigPutRequest,
  type ConfigPutResult,
  type ConfigView,
  type SharedConfig,
  configWithClient,
  sharedConfigKey,
  sharedConfigOf,
} from './config.js';
export {
  MAX_BATCH_OPS,
  type BatchConflict,
  type BatchOp,
  type BatchOpResult,
  type BatchRequest,
  type BatchResult,
} from './batch.js';
