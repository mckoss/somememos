import { describe, expect, it } from 'vitest';
import { createMemoryContentStore } from '../storage/content.js';
import { createMemoryStores } from '../storage/memory.js';
import { describeEngineConformance } from './conformance.testing.js';
import { finite, normalizeNotePath, pathCovers } from './engine.js';
import { EngineError, isEngineError } from './types.js';

describeEngineConformance('memory', ({ now, analyzer }) => ({
  stores: createMemoryStores({ now, ...(analyzer ? { analyzer } : {}) }),
  content: createMemoryContentStore({ now }),
}));

describe('engine helpers', () => {
  it('normalizes note paths and refuses ones outside the brain', () => {
    expect(normalizeNotePath('memos/./a/../b.md')).toBe('memos/b.md');
    for (const bad of ['', '/memos/a.md', '../a.md', 'memos', 'memos/a.txt']) {
      expect(() => normalizeNotePath(bad)).toThrow(EngineError);
    }
  });

  it('matches paths and folders', () => {
    expect(pathCovers('', 'memos/a.md')).toBe(true);
    expect(pathCovers('memos/', 'memos/a.md')).toBe(true);
    expect(pathCovers('memos', 'memos2/a.md')).toBe(false);
    expect(pathCovers('memos/a.md', 'memos/a.md')).toBe(true);
  });

  it('replaces non-finite numbers with null, deeply', () => {
    expect(finite({ a: -Infinity, b: [1, NaN, { c: Infinity }], d: 'x', e: null })).toEqual({
      a: null,
      b: [1, null, { c: null }],
      d: 'x',
      e: null,
    });
  });

  it('recognizes engine errors after a JSON round trip', () => {
    const error = new EngineError('not-found', 'no note', 'memos/a.md');
    expect(isEngineError(error)).toBe(true);
    expect(isEngineError(JSON.parse(JSON.stringify(error.toJSON())))).toBe(true);
    expect(isEngineError(new Error('x'))).toBe(false);
  });
});
