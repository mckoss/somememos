// The CLI's host for the engine: SQLite files in .somememos/ and the note
// text in the brain's directory. The engine conformance suite runs on it, plus
// a few file-system specifics.

import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeEngineConformance } from '@somememos/core/testing/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../brain/testing.js';
import { openBrainStores } from '../store/index.js';
import { createFsContentStore } from './fs-content.js';

describeEngineConformance(
  'cli (sqlite files, file system)',
  ({ now, analyzer }) => {
    const tmp = tempDir('somememos-cli-engine-');
    return {
      stores: openBrainStores(tmp.dir, { now, ...(analyzer ? { analyzer } : {}) }),
      content: createFsContentStore(tmp.dir),
      dispose: () => tmp.remove(),
    };
  },
  { seeds: [1] },
);

describe('createFsContentStore', () => {
  let tmp: ReturnType<typeof tempDir>;
  beforeEach(() => {
    tmp = tempDir();
  });
  afterEach(() => tmp.remove());

  it('lists markdown files only, skipping dot folders, node_modules and links', () => {
    for (const path of [
      'memos/a.md',
      'memos/B.MD',
      'memos/c.txt',
      '.hidden/d.md',
      'node_modules/e.md',
    ]) {
      mkdirSync(join(tmp.dir, path, '..'), { recursive: true });
      writeFileSync(join(tmp.dir, path), 'x');
    }
    symlinkSync(join(tmp.dir, 'memos/a.md'), join(tmp.dir, 'memos/link.md'));
    const content = createFsContentStore(tmp.dir);
    const listed = content.list() as { path: string; fingerprint?: string }[];
    expect(listed.map((e) => e.path)).toEqual(['memos/B.MD', 'memos/a.md']);
    const ns = statSync(join(tmp.dir, 'memos/a.md'), { bigint: true }).mtimeNs;
    expect(listed[1]?.fingerprint).toBe(`1:${ns}`);
  });

  it('writes with an mtime, creating folders, and refuses paths outside the brain', async () => {
    const content = createFsContentStore(tmp.dir);
    const entry = await content.write('memos/deep/n.md', 'café', { mtime: 1_700_000_000 });
    expect(entry).toMatchObject({ path: 'memos/deep/n.md', size: 5, mtime: 1_700_000_000 });
    expect(readFileSync(join(tmp.dir, 'memos/deep/n.md'), 'utf8')).toBe('café');
    expect(() => content.read('../x.md')).toThrow(RangeError);
    expect(() => content.write('/abs.md', 'x')).toThrow(RangeError);
    expect(await content.read('memos/none.md')).toBeUndefined();
    expect(await content.stat('memos/deep')).toBeUndefined();
  });
});
