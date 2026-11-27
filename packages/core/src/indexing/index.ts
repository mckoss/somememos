// Indexing (IMPLEMENTATION.md tasks 1.7 to 1.10 and 2.0): the incremental
// pass that keeps the derived stores current with a `storage.ContentStore`
// and logs the edits, mentions and renames it finds, plus the link rules and
// indexer state it shares with `import-git`. Isomorphic: the CLI feeds it the
// file system, the web app a table in the browser.

export {
  type ContentListing,
  type IndexPassOptions,
  type IndexSummary,
  type ListedFile,
  derivedId,
  listContent,
  runIndexPass,
} from './pass.js';
export {
  ExcludedLinks,
  type RoleOf,
  countsAsLink,
  isAttachmentLink,
  linkItemsOf,
} from './links.js';
export {
  META_BASELINE,
  META_FILES,
  META_FIRST_INDEXED,
  META_LINKS_PREFIX,
  META_PENDING_REMOTE,
  META_UNCOMMITTED,
  type PendingRemote,
  addPendingRemote,
  clearPendingRemote,
  deleteLinkTargets,
  firstIndexedAt,
  readFingerprints,
  readLinkTargets,
  readPendingRemote,
  readUncommitted,
  writeFingerprints,
  writeLinkTargets,
  writeUncommitted,
} from './state.js';
