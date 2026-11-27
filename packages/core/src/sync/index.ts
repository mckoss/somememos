// The sync protocol (PLAN.md section 7, "Sync protocol (first version)"): its
// request and response shapes, limits and path rule, and an offline copy's
// sync state. The engine implements a copy's side (`Engine.prepareSync`,
// `Engine.applySync`, `engine.runSync`) and the store-as-is step both sides
// use (`Engine.applyRemote`). Isomorphic.

export {
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
  conflictPath,
  isSyncablePath,
  syncPathProblem,
} from './protocol.js';
export {
  EMPTY_SYNC_STATE,
  META_SYNC_STATE,
  type SyncState,
  clearSyncState,
  readSyncState,
  writeSyncState,
} from './state.js';
