// The brain repository and its working-tree content store. No database needed.

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { storage } from '@somememos/core';
import { describe, expect, it } from 'vitest';
import { createGitContentStore } from './git-content.js';
import { BrainRepo, ORPHAN_REF_PREFIX, commitMessage, runGit } from './git.js';
import { tempDir } from './test-env.testing.js';

const T = 1_800_000_000;

async function repo(): Promise<{ repo: BrainRepo; content: storage.ContentStore }> {
  const dir = join(tempDir(), 'brain');
  const r = new BrainRepo(dir);
  await r.init();
  return { repo: r, content: createGitContentStore(dir) };
}

describe('the git content store', () => {
  it('stores text byte for byte, with folders, mtimes, renames and removes', async () => {
    const { content, repo: r } = await repo();
    const text = '# Kiln\r\n\nCafé ✓ — firing log\n';
    const written = await content.write('memos/pottery/kiln.md', text, { mtime: T });
    expect(written).toMatchObject({
      path: 'memos/pottery/kiln.md',
      mtime: T,
      size: storage.utf8Length(text),
    });
    expect(await content.read('memos/pottery/kiln.md')).toBe(text);
    expect(await content.stat('memos/none.md')).toBeUndefined();
    expect(await content.read('memos/none.md')).toBeUndefined();
    await content.write('memos/b.md', '# B\n');
    writeFileSync(join(r.dir, 'memos', 'photo.png'), 'not a note');
    const listed = (await content.list()).map((e) => e.path).sort();
    expect(listed).toEqual(['memos/b.md', 'memos/pottery/kiln.md']);
    await content.rename('memos/pottery/kiln.md', 'memos/kiln.md');
    expect(await content.read('memos/kiln.md')).toBe(text);
    expect((await content.stat('memos/kiln.md'))?.mtime).toBe(T);
    expect(existsSync(join(r.dir, 'memos', 'pottery'))).toBe(false); // empty folder pruned
    await expect(async () => content.rename('memos/none.md', 'memos/x.md')).rejects.toThrow(
      RangeError,
    );
    await expect(async () => content.rename('memos/b.md', 'memos/kiln.md')).rejects.toThrow(
      RangeError,
    );
    expect(await content.remove('memos/b.md')).toBe(true);
    expect(await content.remove('memos/b.md')).toBe(false);
  });

  it('never lists or writes inside .git or any dot folder, or outside the tree', async () => {
    const { content } = await repo();
    for (const bad of [
      '.git/hooks/pre-commit.md',
      '.somememos/x.md',
      '../x.md',
      '/abs.md',
      'a/../b.md',
      'x.txt',
    ]) {
      await expect(async () => content.write(bad, 'x')).rejects.toThrow(RangeError);
    }
    expect(await content.list()).toEqual([]);
  });
});

describe('the brain repository', () => {
  it('makes one commit per change set, authored by the client, with the message and files', async () => {
    const { repo: r, content } = await repo();
    expect(await r.head()).toBeNull();
    expect(await r.stageAll()).toEqual([]);
    await content.write('memos/a.md', '# A\n');
    await content.write('memos/b.md', '# B\n');
    expect(await r.stageAll()).toEqual([
      { status: 'added', path: 'memos/a.md' },
      { status: 'added', path: 'memos/b.md' },
    ]);
    const first = await r.commit(
      { author: 'phone-1', time: T - 100, message: 'ingest two notes' },
      T,
    );
    expect(await r.head()).toBe(first);
    expect(await r.isClean()).toBe(true);

    await content.rename('memos/a.md', 'memos/alpha.md');
    await content.write('memos/b.md', '# B\n\nmore\n');
    await content.write('memos/c.md', '# C\n');
    await content.remove('memos/c.md');
    expect(await r.stageAll()).toEqual([
      { status: 'renamed', from: 'memos/a.md', to: 'memos/alpha.md' },
      { status: 'modified', path: 'memos/b.md' },
    ]);
    const second = await r.commit(
      { author: 'laptop', time: T, message: 'update b\n\nand rename a' },
      T + 5,
    );

    const info = await r.commitInfo([second, first]);
    expect(info.get(first)).toEqual({
      commit: first,
      author: 'phone-1',
      time: T - 100,
      committedAt: T,
      message: 'ingest two notes',
    });
    expect(info.get(second)).toMatchObject({
      author: 'laptop',
      time: T,
      message: 'update b\n\nand rename a',
    });
    const email = await runGit(r.dir, ['log', '-1', '--format=%ae|%cn|%ce', second]);
    expect(email.trim()).toBe(
      'laptop@clients.somememos.invalid|somememos server|server@somememos.invalid',
    );
    const files = await runGit(r.dir, ['show', '--name-status', '--format=', '-M', second]);
    expect(files.trim().split('\n').sort()).toEqual([
      'M\tmemos/b.md',
      'R100\tmemos/a.md\tmemos/alpha.md',
    ]);
    expect(Number((await runGit(r.dir, ['rev-list', '--count', 'HEAD'])).trim())).toBe(2);

    expect(
      await r.readAt([
        { commit: first, path: 'memos/a.md' },
        { commit: second, path: 'memos/a.md' },
        { commit: second, path: 'memos/b.md' },
      ]),
    ).toEqual(['# A\n', undefined, '# B\n\nmore\n']);
  });

  it('runs no hooks, even ones placed in the repository', async () => {
    const { repo: r, content } = await repo();
    const marker = join(r.dir, 'hook-ran');
    writeFileSync(join(r.dir, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch ${marker}\n`, {
      mode: 0o755,
    });
    writeFileSync(join(r.dir, '.git', 'hooks', 'post-commit'), `#!/bin/sh\ntouch ${marker}\n`, {
      mode: 0o755,
    });
    await content.write('memos/a.md', '# A\n');
    await r.stageAll();
    await r.commit({ author: 'x', time: T, message: 'm' }, T);
    expect(existsSync(marker)).toBe(false);
  });

  it('recovers to the recorded commit, keeping an unrecorded one under a ref', async () => {
    const { repo: r, content } = await repo();
    await content.write('memos/a.md', '# A\n');
    await r.stageAll();
    const recorded = await r.commit({ author: 'x', time: T, message: 'one' }, T);
    expect(await r.recover(recorded)).toEqual({ recovered: false, unrecorded: null });

    // A commit made, then the process died before the database recorded it.
    await content.write('memos/a.md', '# A\n\nchanged\n');
    await content.write('memos/new.md', '# New\n');
    await r.stageAll();
    const lost = await r.commit({ author: 'x', time: T, message: 'two' }, T);
    // And a half-written change on top.
    await content.write('memos/half.md', '# Half\n');

    expect(await r.recover(recorded)).toEqual({ recovered: true, unrecorded: lost });
    expect(await r.head()).toBe(recorded);
    expect(await r.isClean()).toBe(true);
    expect(await content.read('memos/a.md')).toBe('# A\n');
    expect(await content.read('memos/new.md')).toBeUndefined();
    expect(await content.read('memos/half.md')).toBeUndefined();
    const kept = await runGit(r.dir, ['rev-parse', `${ORPHAN_REF_PREFIX}${lost}`]);
    expect(kept.trim()).toBe(lost);

    // Back to no commit at all.
    await r.recover(null);
    expect(await r.head()).toBeNull();
    expect(await content.list()).toEqual([]);
    await expect(r.recover('0'.repeat(40))).rejects.toThrow(/does not contain/);
  });

  it('keeps commit messages to plain text', () => {
    expect(commitMessage('')).toBe('(no message)\n');
    expect(commitMessage('a\r\nb\u0001c')).toBe('a\nb c\n');
  });
});
