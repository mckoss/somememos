// The local-mode index pass: core's pass (`indexing.runIndexPass`) over the
// brain's directory. All the rules live in core; this only supplies the
// file-system content store.

import { indexing } from '@somememos/core';
import { createFsContentStore } from './fs-content.js';

export type IndexSummary = indexing.IndexSummary;

export interface IndexPassOptions extends Omit<indexing.IndexPassOptions, 'content'> {
  /** The brain's root directory. */
  readonly root: string;
}

/** Runs one index pass over the files under `opts.root` and folds the event log into scores. */
export function runIndexPass(opts: IndexPassOptions): Promise<IndexSummary> {
  const { root, ...rest } = opts;
  return indexing.runIndexPass({ ...rest, content: createFsContentStore(root) });
}
