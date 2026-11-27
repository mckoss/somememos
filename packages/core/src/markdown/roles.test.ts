import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FOLDER_ROLES,
  PathPatternError,
  classifyPath,
  compilePathPattern,
  createRoleClassifier,
  isValidCalendarDate,
  matchDatedPath,
  renderDatedPath,
} from './index.js';

const matches = (pattern: string, path: string) => compilePathPattern(pattern).match(path) !== null;

describe('path patterns', () => {
  it.each([
    ['memos/', 'memos/a.md', true],
    ['memos/', 'memos/sub/a.md', true],
    ['memos/', 'memos.md', false],
    ['memos/', 'other/memos/a.md', false],
    ['memos/*.md', 'memos/a.md', true],
    ['memos/*.md', 'memos/sub/a.md', false],
    ['memos/**/*.md', 'memos/a.md', true],
    ['memos/**/*.md', 'memos/x/y/a.md', true],
    ['**/drafts/**', 'a/drafts/b.md', true],
    ['**/drafts/**', 'drafts/b.md', true],
    ['**/drafts/**', 'drafts.md', false],
    ['**', 'any/thing.md', true],
    ['a?c.md', 'abc.md', true],
    ['a?c.md', 'a/c.md', false],
    ['notes/a.b+(c).md', 'notes/a.b+(c).md', true],
    ['notes/a.b+(c).md', 'notes/aXb+(c).md', false],
    ['/memos/x.md', 'memos/x.md', true],
    ['./memos/x.md', 'memos/x.md', true],
    ['Memos/', 'memos/x.md', false],
  ])('%s against %s is %s', (pattern, path, expected) => {
    expect(matches(pattern, path)).toBe(expected);
  });

  it('rejects unknown placeholders and empty patterns', () => {
    expect(() => compilePathPattern('diary/{YYY}.md')).toThrow(PathPatternError);
    expect(() => compilePathPattern('')).toThrow(PathPatternError);
  });
});

describe('dated patterns', () => {
  const pattern = 'diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md';

  it('extracts the date', () => {
    expect(matchDatedPath(pattern, 'diary/2026/03/2026-03-14.md')).toBe('2026-03-14');
    expect(matchDatedPath('log/{DD}.{MM}.{YYYY}.md', 'log/29.02.2024.md')).toBe('2024-02-29');
  });

  it('requires repeated placeholders to agree', () => {
    expect(matchDatedPath(pattern, 'diary/2026/03/2025-03-14.md')).toBeNull();
  });

  it('rejects impossible dates', () => {
    expect(matchDatedPath(pattern, 'diary/2026/02/2026-02-30.md')).toBeNull();
    expect(matchDatedPath(pattern, 'diary/2025/02/2025-02-29.md')).toBeNull();
    expect(matchDatedPath(pattern, 'diary/2026/13/2026-13-01.md')).toBeNull();
    expect(matchDatedPath(pattern, 'diary/0000/01/0000-01-01.md')).toBeNull();
  });

  it('renders a path for a date', () => {
    expect(renderDatedPath(pattern, '2026-11-27')).toBe('diary/2026/11/2026-11-27.md');
    expect(() => renderDatedPath(pattern, '2026-02-30')).toThrow(RangeError);
    expect(() => renderDatedPath('diary/*/{YYYY}-{MM}-{DD}.md', '2026-01-01')).toThrow(
      PathPatternError,
    );
    expect(() => renderDatedPath('diary/{YYYY}-{MM}.md', '2026-01-01')).toThrow(PathPatternError);
  });

  it('round-trips every valid date', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('0001-01-01'), max: new Date('9999-12-31'), noInvalidDate: true }),
        (d) => {
          const iso = d.toISOString().slice(0, 10);
          expect(matchDatedPath(pattern, renderDatedPath(pattern, iso))).toBe(iso);
        },
      ),
    );
  });

  it('validates calendar dates', () => {
    expect(isValidCalendarDate(2000, 2, 29)).toBe(true);
    expect(isValidCalendarDate(1900, 2, 29)).toBe(false);
    expect(isValidCalendarDate(2026, 4, 31)).toBe(false);
    expect(isValidCalendarDate(2026, 12, 31)).toBe(true);
  });
});

describe('role classification', () => {
  it('makes every .md file a memo when no roles are declared', () => {
    expect(classifyPath('anything/at/all.md')).toEqual({ role: 'memo' });
    expect(classifyPath('x.md', { memo: [], dated: [] })).toEqual({ role: 'memo' });
    expect(classifyPath('picture.png')).toBeNull();
  });

  it('applies precedence: excluded, source, dated, memo', () => {
    const c = createRoleClassifier({
      memo: ['**'],
      dated: ['diary/{YYYY}-{MM}-{DD}.md'],
      source: ['sources/', 'diary/clippings/'],
      excluded: ['**/private/**'],
    });
    expect(c.classify('memos/a.md')).toEqual({ role: 'memo', pattern: '**' });
    expect(c.classify('diary/2026-01-02.md')).toEqual({
      role: 'dated',
      pattern: 'diary/{YYYY}-{MM}-{DD}.md',
      date: '2026-01-02',
    });
    expect(c.classify('sources/paper.md')?.role).toBe('source');
    expect(c.classify('sources/private/paper.md')?.role).toBe('excluded');
    expect(c.classify('diary/private/2026-01-02.md')?.role).toBe('excluded');
    // An impossible date is not a dated entry; it falls through to memo.
    expect(c.classify('diary/2026-02-31.md')?.role).toBe('memo');
  });

  it('gives no role to a file matching nothing once roles are declared', () => {
    const c = createRoleClassifier(DEFAULT_FOLDER_ROLES);
    expect(c.declared).toBe(true);
    expect(c.classify('memos/a.md')?.role).toBe('memo');
    expect(c.classify('diary/2026/05/2026-05-06.md')).toMatchObject({
      role: 'dated',
      date: '2026-05-06',
    });
    expect(c.classify('diary/2026/05/notes.md')).toBeNull();
    expect(c.classify('README.md')).toBeNull();
    expect(c.datedPatterns).toEqual(['diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md']);
  });

  it('rejects a dated pattern without a full date', () => {
    expect(() => createRoleClassifier({ dated: ['diary/{YYYY}-{MM}.md'] })).toThrow(
      PathPatternError,
    );
  });
});
