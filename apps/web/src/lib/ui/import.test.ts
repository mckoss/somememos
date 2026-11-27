import { describe, expect, it } from 'vitest';
import {
  classifyForImport,
  isHiddenPath,
  roleProblems,
  rolesFromText,
  stripTopFolder,
} from './import.ts';

describe('import helpers', () => {
  it('drops the picked folder name from paths', () => {
    expect(stripTopFolder(['brain/memos/a.md', 'brain/b.md'])).toEqual(['memos/a.md', 'b.md']);
    expect(stripTopFolder(['a.md', 'memos/b.md'])).toEqual(['a.md', 'memos/b.md']);
  });

  it('skips tool folders', () => {
    expect(isHiddenPath('.git/config')).toBe(true);
    expect(isHiddenPath('memos/.obsidian/x.md')).toBe(true);
    expect(isHiddenPath('memos/a.md')).toBe(false);
  });

  it('classifies paths the way the brain will', () => {
    const roles = {
      memo: ['memos/'],
      dated: ['diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md'],
      source: ['sources/'],
      blog: ['blog/'],
      excluded: ['memos/private/'],
    };
    const out = classifyForImport(
      [
        'memos/a.md',
        'memos/private/secret.md',
        'diary/2026/01/2026-01-02.md',
        'sources/s.md',
        'blog/2026/2026-01-02-post.md',
        'other/x.md',
        'memos/img.png',
      ],
      roles,
    );
    expect([...out.values()]).toEqual([
      'memo',
      'excluded',
      'dated',
      'source',
      'blog',
      'none',
      'none',
    ]);
  });

  it('treats every markdown file as a memo when no roles are declared', () => {
    expect([...classifyForImport(['a.md', 'x/b.md'], {}).values()]).toEqual(['memo', 'memo']);
  });

  it('reads roles from the editor text', () => {
    expect(rolesFromText({ memo: ' memos/ \n\n wiki/ ', excluded: '' })).toEqual({
      memo: ['memos/', 'wiki/'],
    });
  });

  it('reports bad patterns', () => {
    expect(roleProblems({ dated: ['diary/'] }).dated).toMatch(/YYYY/);
    expect(roleProblems({ memo: ['m/{X}.md'] }).memo).toMatch(/placeholder/);
    expect(roleProblems({ memo: ['memos/'] })).toEqual({});
  });
});
