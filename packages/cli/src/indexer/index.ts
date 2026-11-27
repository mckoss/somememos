// The local-mode indexer: the file walk and a file-system `ContentStore` that
// feed core's index pass (`indexing.runIndexPass`), which holds every rule
// (IMPLEMENTATION.md tasks 1.7 to 1.10 and 2.0).

export { createFsContentStore } from './fs-content.js';
export { type IndexPassOptions, type IndexSummary, runIndexPass } from './pass.js';
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
export { SKIPPED_DIRS, type WalkedFile, fingerprint, statFile, walkMarkdown } from './walk.js';
