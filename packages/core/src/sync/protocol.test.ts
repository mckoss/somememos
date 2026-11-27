import { describe, expect, it } from 'vitest';
import { MAX_SEGMENT_BYTES, syncPathProblem } from './protocol.js';

describe('syncPathProblem', () => {
  it('accepts ordinary note paths', () => {
    expect(syncPathProblem('memos/garden plans.md')).toBeNull();
    expect(syncPathProblem(`memos/${'a'.repeat(MAX_SEGMENT_BYTES - 3)}.md`)).toBeNull();
  });

  it('refuses a file or folder name longer than file systems allow', () => {
    // The server stores notes as files: a longer name failed there with an internal error.
    expect(syncPathProblem(`memos/${'a'.repeat(MAX_SEGMENT_BYTES - 2)}.md`)).toMatch(/longer than/);
    expect(syncPathProblem(`${'é'.repeat(128)}/note.md`)).toMatch(/longer than/);
  });

  it('refuses traversal, dot folders, separators and control characters', () => {
    for (const bad of [
      '../x.md',
      'memos/../x.md',
      '/etc/x.md',
      '.git/config.md',
      'memos/.somememos/x.md',
      'memos\\x.md',
      'memos/x\u0000.md',
      'memos//x.md',
      'memos/x.txt',
      'memos/é.md',
    ]) {
      expect(syncPathProblem(bad), bad).not.toBeNull();
    }
  });
});
