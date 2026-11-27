import { describe, expect, it } from 'vitest';
import {
  asidePath,
  danglingNotePath,
  encodeNotePath,
  folderOfPattern,
  initialNoteText,
  isBlogPath,
  localDateString,
  memoFolder,
  newBlogPath,
  newMemoPath,
  slugify,
  splitPath,
  titleFromPath,
  uniquePath,
} from './paths.ts';

const defaults = {
  memo: ['memos/'],
  dated: ['diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md'],
  source: ['sources/'],
  blog: ['blog/'],
};

describe('slugify', () => {
  it('makes kebab-case file names', () => {
    expect(slugify('Compost Tea: a Recipe!')).toBe('compost-tea-a-recipe');
    expect(slugify('  Crème brûlée  ')).toBe('creme-brulee');
    expect(slugify("Mike's notes")).toBe('mikes-notes');
    expect(slugify('Ünïcödé 日本')).toBe('unicode-日本');
  });

  it('never returns an empty name', () => {
    expect(slugify('!!!')).toBe('untitled');
    expect(slugify('')).toBe('untitled');
  });

  it('cuts long titles at a word boundary', () => {
    const slug = slugify('word '.repeat(40), 20);
    expect(slug.length).toBeLessThanOrEqual(20);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('folders and new paths', () => {
  it('takes the fixed folder of a pattern', () => {
    expect(folderOfPattern('memos/')).toBe('memos/');
    expect(folderOfPattern('./wiki/ideas/**/*.md')).toBe('wiki/ideas/');
    expect(folderOfPattern('**/*.md')).toBe('');
    expect(folderOfPattern('diary/{YYYY}/x.md')).toBe('diary/');
  });

  it('puts memos in the memo folder', () => {
    expect(memoFolder(defaults)).toBe('memos/');
    expect(memoFolder({})).toBe('');
    expect(memoFolder({ source: ['s/'] })).toBeNull();
    expect(newMemoPath('Quince Grafting', defaults)).toBe('memos/quince-grafting.md');
    expect(newMemoPath('Quince', {})).toBe('quince.md');
  });

  it('dates blog posts', () => {
    expect(newBlogPath('Why Memos?', '2026-11-27', defaults)).toBe(
      'blog/2026/2026-11-27-why-memos.md',
    );
    expect(newBlogPath('Why', '2026-01-02', { blog: ['posts/{YYYY}/{YYYY}-{MM}-{DD}-*.md'] })).toBe(
      'posts/2026/2026-01-02-why.md',
    );
    expect(newBlogPath('Why', '2026-01-02', { memo: ['m/'] })).toBeNull();
  });

  it('keeps the link text for a dangling link so it resolves', () => {
    expect(danglingNotePath('Compost Tea', defaults)).toBe('memos/Compost Tea.md');
    expect(danglingNotePath('garden/Compost.md', defaults)).toBe('memos/garden/Compost.md');
    expect(danglingNotePath('memos/x', defaults)).toBe('memos/x.md');
    expect(danglingNotePath('../a:b', defaults)).toBe('memos/a-b.md');
    expect(danglingNotePath('  ', defaults)).toBeNull();
  });

  it('finds a free path', () => {
    expect(uniquePath('a.md', new Set())).toBe('a.md');
    expect(uniquePath('a.md', new Set(['a.md', 'a-2.md']))).toBe('a-3.md');
  });

  it('names a set-aside copy after the original', () => {
    expect(asidePath('memos/a.md', new Date(2026, 10, 27, 9, 5))).toBe(
      'memos/a (my version 2026-11-27-0905).md',
    );
  });
});

describe('small helpers', () => {
  it('encodes note paths for URLs', () => {
    expect(encodeNotePath('memos/a b#c?.md')).toBe('memos/a%20b%23c%3F.md');
  });

  it('starts a note with its title as a heading', () => {
    expect(initialNoteText(' Quince ')).toBe('# Quince\n\n');
    expect(initialNoteText('')).toBe('');
  });

  it('formats local dates', () => {
    expect(localDateString(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('splits a path', () => {
    expect(splitPath('memos/a.md')).toEqual({ folder: 'memos/', name: 'a.md' });
    expect(splitPath('a.md')).toEqual({ folder: '', name: 'a.md' });
  });
});

describe('blog paths', () => {
  it('knows which paths are in the blog folder', () => {
    expect(isBlogPath('blog/2026/2026-11-27-why.md', defaults)).toBe(true);
    expect(isBlogPath('memos/why.md', defaults)).toBe(false);
    expect(isBlogPath('blog/x.md', { memo: ['memos/'] })).toBe(false);
  });

  it('titles a new note from its file name', () => {
    expect(titleFromPath('memos/compost tea.md')).toBe('Compost tea');
  });
});
