// The indexer's state between passes lives in core (`indexing`); re-exported
// here for the CLI's commands and tests.

import { indexing } from '@somememos/core';

export const {
  META_BASELINE,
  META_FILES,
  META_FIRST_INDEXED,
  META_LINKS_PREFIX,
  META_UNCOMMITTED,
  firstIndexedAt,
  readLinkTargets,
  readUncommitted,
  writeUncommitted,
} = indexing;
