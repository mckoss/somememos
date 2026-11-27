// The local-mode indexer: an incremental pass over a brain's working tree that
// keeps the derived stores current and logs the edits, mentions and renames it
// finds (IMPLEMENTATION.md tasks 1.7 to 1.10).

export {
  type IndexPassOptions,
  type IndexSummary,
  contentHash,
  derivedId,
  runIndexPass,
} from './pass.js';
export {
  META_BASELINE,
  META_FILES,
  META_FIRST_INDEXED,
  META_LINKS_PREFIX,
  META_UNCOMMITTED,
  firstIndexedAt,
  readLinkTargets,
  readUncommitted,
  writeUncommitted,
} from './state.js';
export { SKIPPED_DIRS, type WalkResult, type WalkedFile, fingerprint, walkBrain } from './walk.js';
