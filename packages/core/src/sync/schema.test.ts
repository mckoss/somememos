import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createEngine } from '../engine/index.js';
import { parseBrainConfig } from '../storage/config.js';
import { createMemoryContentStore } from '../storage/content.js';
import { createMemoryStores } from '../storage/memory.js';
import { SYNC_LIMITS, syncPathProblem } from './protocol.js';
import {
  CHECKS,
  SyncRequestSchema,
  SyncResponseSchema,
  fitsUtf8,
  issueMessage,
  parseWith,
} from './schema.js';

const edit = { id: 'e1', op: 'write', path: 'memos/a.md', baseHash: null, text: 'secret text' };
const refused = (input: unknown) => {
  const r = parseWith(SyncRequestSchema, input);
  if (r.ok) throw new Error('accepted');
  return r.issue;
};

describe('the sync request schema', () => {
  it('accepts a minimal request and fills in the lists', () => {
    expect(parseWith(SyncRequestSchema, { since: 0 })).toEqual({
      ok: true,
      value: { since: 0, events: [], changes: [], edits: [] },
    });
  });

  it('takes only JSON objects: never an array, never a prototype key', () => {
    expect(refused([]).path).toBeUndefined();
    expect(refused({ since: 0, edits: [[]] }).path?.map((p) => p.key)).toEqual(['edits', 0]);
    expect(refused({ since: 0, changes: [[]] }).path?.map((p) => p.key)).toEqual(['changes', 0]);
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const issue = refused(JSON.parse(`{"since":0,"${key}":{}}`));
      expect(issueMessage(issue)).toBe(`the request: unknown field "${key}"`);
    }
  });

  it('counts a list before looking at its entries', () => {
    const issue = refused({ since: 0, events: Array(SYNC_LIMITS.maxEvents + 1).fill('junk') });
    expect(issue.expected).toBe(CHECKS.count);
  });

  it('tags the checks that have their own error codes', () => {
    expect(refused({ since: 0, edits: [{ ...edit, path: '../x.md' }] }).expected).toBe(
      CHECKS.notePath,
    );
    const { path: _path, ...noPath } = edit;
    expect(refused({ since: 0, edits: [noPath] }).expected).toBe(CHECKS.notePath);
    const big = 'é'.repeat(SYNC_LIMITS.maxNoteBytes / 2 + 1);
    expect(refused({ since: 0, edits: [{ ...edit, text: big }] }).expected).toBe(CHECKS.noteSize);
  });

  it('never repeats a refused value in its message', () => {
    for (const bad of [
      { since: 0, client: 'secret token' },
      { since: 0, edits: [{ ...edit, baseHash: 'secret token' }] },
      { since: 0, edits: [{ ...edit, path: 'secret token.md/' }] },
      { since: 0, edits: [{ ...edit, op: 'secret token' }] },
      { since: 0, events: [{ id: 'x', kind: 'secret token', item: 'a', time: 1, client: 'c' }] },
      { since: 'secret token' },
    ]) {
      expect(issueMessage(refused(bad))).not.toContain('secret');
    }
  });

  it('refuses a path with a lone surrogate (it has no UTF-8 form)', () => {
    expect(syncPathProblem('memos/\ud800.md')).toMatch(/Unicode/);
    expect(syncPathProblem('memos/\udc00x.md')).toMatch(/Unicode/);
    expect(syncPathProblem('memos/🌱.md')).toBeNull();
  });
});

describe('fitsUtf8', () => {
  it('agrees with encoding the text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 40 }), fc.nat(120), (text, max) => {
        expect(fitsUtf8(text, max)).toBe(new TextEncoder().encode(text).length <= max);
      }),
    );
  });
});

describe('the sync response schema', () => {
  it('ignores fields a newer server adds, and fills in what an older one leaves out', () => {
    const parsed = parseWith(SyncResponseSchema, { mutation: 3, extra: true, results: [] });
    expect(parsed).toEqual({
      ok: true,
      value: { mutation: 3, more: false, results: [], notes: [], events: [], changes: [] },
    });
  });

  it('makes applySync refuse a malformed response without repeating its text', async () => {
    const now = () => 1_800_000_000;
    const engine = createEngine({
      stores: createMemoryStores({ now }),
      content: createMemoryContentStore({ now }),
      config: parseBrainConfig({ clientId: 'phone' }),
      now,
    });
    await engine.index();
    const prepared = await engine.prepareSync();
    const bad = {
      mutation: 1,
      more: false,
      results: [],
      notes: [{ path: 'memos/a.md', hash: 'nope', text: 'secret text' }],
      events: [],
      changes: [],
    };
    const error = await engine.applySync(prepared, bad).catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ code: 'invalid-argument' });
    expect((error as Error).message).toMatch(/malformed \(note 1: /);
    expect((error as Error).message).not.toContain('secret');
  });
});
