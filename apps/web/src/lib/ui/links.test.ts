import { describe, expect, it } from 'vitest';
import { createResolver, linkCompletions, linkTextFor, openLinkBefore } from './links.ts';

const titles = [
  { path: 'memos/quince-grafting.md', title: 'Quince Grafting', role: 'memo' as const },
  { path: 'memos/orchard/frost.md', title: 'Frost Dates', role: 'memo' as const },
  { path: 'sources/frost.md', title: 'Frost (source)', role: 'source' as const },
  { path: 'memos/cider.md', title: 'Pressing Cider', role: 'memo' as const },
];

describe('linkTextFor', () => {
  it('uses the file name when it is unique', () => {
    expect(linkTextFor('memos/quince-grafting.md', titles)).toBe('quince-grafting');
  });

  it('uses the path when names clash', () => {
    expect(linkTextFor('memos/orchard/frost.md', titles)).toBe('memos/orchard/frost');
  });
});

describe('linkCompletions', () => {
  it('ranks prefix matches first', () => {
    const out = linkCompletions('fro', titles);
    expect(out.map((c) => c.detail).sort()).toEqual(['memos/orchard/frost.md', 'sources/frost.md']);
    expect(linkCompletions('cider', titles)[0]?.insert).toBe('cider');
    expect(linkCompletions('press', titles)[0]?.label).toBe('Pressing Cider');
  });

  it('lists everything for an empty query', () => {
    expect(linkCompletions('', titles)).toHaveLength(4);
  });
});

describe('openLinkBefore', () => {
  it('finds an unclosed link before the cursor', () => {
    expect(openLinkBefore('see [[qui')).toEqual({ typed: 'qui', from: 6 });
    expect(openLinkBefore('[[')).toEqual({ typed: '', from: 2 });
    expect(openLinkBefore('see [[done]] and')).toBeNull();
    expect(openLinkBefore('\\[[escaped')).toBeNull();
    expect(openLinkBefore('[[note#head')).toBeNull();
  });
});

describe('createResolver', () => {
  it('resolves with the engine rules', () => {
    const resolve = createResolver(
      titles.map((t) => t.path),
      'memos/a.md',
    );
    expect(resolve('Quince-Grafting')).toEqual({ kind: 'note', path: 'memos/quince-grafting.md' });
    expect(resolve('Compost Tea')).toEqual({ kind: 'missing', target: 'Compost Tea' });
  });
});

describe('completion order', () => {
  it('puts memos before diary entries', () => {
    const out = linkCompletions('', [
      { path: 'diary/2026/01/2026-01-01.md', title: '2026-01-01', role: 'dated' },
      { path: 'memos/z.md', title: 'Zebra', role: 'memo' },
    ]);
    expect(out[0]?.detail).toBe('memos/z.md');
  });
});
