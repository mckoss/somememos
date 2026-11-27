import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addedLinkItems,
  createLinkResolver,
  normalizeDanglingKey,
  parseLinks,
  resolveLink,
} from './index.js';

const brain = [
  'index.md',
  'memos/Alpha.md',
  'memos/beta.md',
  'memos/deep/Gamma.md',
  'memos/deep/Shared.md',
  'archive/Shared.md',
  'projects/x/Shared.md',
  'diary/2026/01/2026-01-05.md',
  'Café.md',
  'notes/Idea.md',
  'Idea.md',
];
const resolver = createLinkResolver(brain);

describe('link resolution', () => {
  it('matches an exact brain path with or without .md, and a leading /', () => {
    expect(resolver.resolve('memos/Alpha', 'index.md')).toEqual({
      kind: 'resolved',
      path: 'memos/Alpha.md',
      rule: 'exact',
      ambiguous: false,
    });
    expect(resolver.resolve('memos/deep/Gamma.md', 'x/y.md')).toMatchObject({
      path: 'memos/deep/Gamma.md',
      rule: 'exact',
    });
    expect(resolver.resolve('/memos/beta', 'memos/deep/Gamma.md')).toMatchObject({ rule: 'exact' });
  });

  it('prefers an exact root path over a same-named note in the source folder', () => {
    expect(resolver.resolve('Idea', 'notes/Other.md')).toMatchObject({
      path: 'Idea.md',
      rule: 'exact',
    });
  });

  it('resolves relative to the source folder, with ./ and ../', () => {
    expect(resolver.resolve('deep/Gamma', 'memos/Alpha.md')).toMatchObject({
      path: 'memos/deep/Gamma.md',
      rule: 'relative',
    });
    expect(resolver.resolve('./Gamma.md', 'memos/deep/Shared.md')).toMatchObject({
      rule: 'relative',
    });
    expect(resolver.resolve('../Alpha', 'memos/deep/Gamma.md')).toMatchObject({
      path: 'memos/Alpha.md',
      rule: 'relative',
    });
    expect(resolver.resolve('../../../Alpha', 'memos/deep/Gamma.md').kind).toBe('dangling');
  });

  it('matches a base name case-insensitively', () => {
    expect(resolver.resolve('gamma', 'index.md')).toEqual({
      kind: 'resolved',
      path: 'memos/deep/Gamma.md',
      rule: 'name',
      ambiguous: false,
    });
    expect(resolver.resolve('BETA.md', 'index.md')).toMatchObject({ path: 'memos/beta.md' });
  });

  it('matches Unicode names regardless of normalization form', () => {
    expect(resolver.resolve('café', 'memos/Alpha.md')).toMatchObject({ path: 'Café.md' });
  });

  it('matches a folder-qualified target on a path suffix', () => {
    expect(resolver.resolve('deep/shared', 'index.md')).toMatchObject({
      path: 'memos/deep/Shared.md',
      rule: 'name',
      ambiguous: false,
    });
    expect(resolver.resolve('eep/Shared', 'index.md').kind).toBe('dangling');
  });

  it('breaks base-name ties by source folder, then length, then name, and flags them', () => {
    const candidates = ['archive/Shared.md', 'memos/deep/Shared.md', 'projects/x/Shared.md'];
    // A case-different target misses the relative rule, so the name rule picks the local note.
    expect(resolver.resolve('shared', 'projects/x/Other.md')).toEqual({
      kind: 'resolved',
      path: 'projects/x/Shared.md',
      rule: 'name',
      ambiguous: true,
      candidates,
    });
    expect(resolver.resolve('shared', 'index.md')).toMatchObject({
      path: 'archive/Shared.md',
      ambiguous: true,
    });
    const tie = createLinkResolver(['b/Same.md', 'a/Same.md', 'longer/Same.md']);
    expect(tie.resolve('Same', 'root.md')).toMatchObject({ path: 'a/Same.md', ambiguous: true });
  });

  it('keys dangling links by normalized text', () => {
    expect(resolver.resolve('  New   Big\tIdea.MD ', 'index.md')).toEqual({
      kind: 'dangling',
      key: 'new big idea',
    });
    expect(normalizeDanglingKey('Ünïcode  Thing.md')).toBe('ünïcode thing');
    expect(normalizeDanglingKey('café')).toBe(normalizeDanglingKey('Café'));
  });

  it('resolveLink is the one-off form', () => {
    expect(resolveLink('alpha', 'index.md', brain)).toMatchObject({ path: 'memos/Alpha.md' });
  });

  it('always resolves an exact path to itself', () => {
    const segment = fc
      .stringMatching(/^[A-Za-z0-9 _-]{1,6}$/)
      .filter((s) => s.trim() === s && s !== '');
    const path = fc.array(segment, { minLength: 1, maxLength: 4 }).map((s) => `${s.join('/')}.md`);
    fc.assert(
      fc.property(
        fc.uniqueArray(path, { minLength: 1, maxLength: 20 }),
        fc.nat(),
        fc.boolean(),
        (paths, pick, withMd) => {
          const target = paths[pick % paths.length] as string;
          const r = createLinkResolver(paths).resolve(
            withMd ? target : target.slice(0, -3),
            paths[0] as string,
          );
          expect(r).toMatchObject({ kind: 'resolved', path: target });
        },
      ),
    );
  });
});

describe('addedLinkItems', () => {
  const from = 'memos/Alpha.md';
  const added = (oldText: string, newText: string) =>
    addedLinkItems(parseLinks(oldText), parseLinks(newText), from, resolver);

  it('returns targets new in this version, each once, in order', () => {
    expect(
      added('[[beta]]', '[[Gamma]] [[beta]] [[gamma|again]] [[New one]] ![[new ONE]]'),
    ).toEqual(['memos/deep/Gamma.md', 'new one']);
  });

  it('treats differently written links to one note as the same target', () => {
    expect(added('[[beta]]', '[[memos/beta|B]] [[./beta#Part]]')).toEqual([]);
  });

  it('counts every link of a new note and ignores self-links', () => {
    expect(addedLinkItems([], parseLinks('[[Alpha]] [[index]]'), from, resolver)).toEqual([
      'index.md',
    ]);
  });

  it('returns nothing for removed links', () => {
    expect(added('[[beta]] [[Gamma]]', '[[beta]]')).toEqual([]);
  });
});
