// The engine conformance suite on SQLite with the node:sqlite driver: both
// databases as temp files, note text in the `content` table (as the web app
// will keep it), and the same on two in-memory databases.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storage } from '@somememos/core';
import { describeEngineConformance } from '@somememos/core/testing/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteContentStore, createSqliteStores } from '../stores.js';
import { open } from './database.js';

describeEngineConformance('sqlite files, content table', ({ now, analyzer }) => {
  const dir = mkdtempSync(join(tmpdir(), 'somememos-engine-'));
  const events = open(join(dir, 'events.sqlite'));
  const index = open(join(dir, 'index.sqlite'));
  const stores = createSqliteStores({ events, index, now, ...(analyzer ? { analyzer } : {}) });
  return {
    stores,
    content: createSqliteContentStore(events, { now }),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
});

describeEngineConformance(
  'sqlite in memory',
  ({ now }) => {
    const events = open(':memory:');
    const stores = createSqliteStores({ events, index: open(':memory:'), now });
    return { stores, content: createSqliteContentStore(events, { now }) };
  },
  { seeds: [3] },
);

describe('the content table', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('stores text byte for byte with size, mtime and hash, beside the event log', async () => {
    dir = mkdtempSync(join(tmpdir(), 'somememos-content-'));
    const path = join(dir, 'events.sqlite');
    let events = open(path);
    // Created before the stores: the event log's schema comes first.
    let content = createSqliteContentStore(events, { now: () => 1000 });
    const text = '# Café\r\n\r\nLine ✓\n';
    const entry = await content.write('memos/café.md', text);
    expect(entry).toEqual({
      path: 'memos/café.md',
      size: new TextEncoder().encode(text).length,
      mtime: 1000,
      hash: await storage.contentHash(text),
    });
    await content.write('memos/b.md', 'b', { mtime: 5 });
    expect(await content.list()).toEqual([
      { path: 'memos/b.md', size: 1, mtime: 5, hash: await storage.contentHash('b') },
      entry,
    ]);
    await content.rename('memos/b.md', 'memos/c.md');
    expect(() => content.rename('memos/b.md', 'memos/d.md')).toThrow(RangeError);
    expect(() => content.rename('memos/c.md', 'memos/café.md')).toThrow(RangeError);
    expect(await content.stat('memos/c.md')).toMatchObject({ mtime: 5 });
    expect(await content.remove('memos/c.md')).toBe(true);
    expect(await content.remove('memos/c.md')).toBe(false);
    events.close();

    events = open(path);
    const stores = createSqliteStores({ events, index: open(':memory:') });
    content = createSqliteContentStore(events);
    expect(await content.read('memos/café.md')).toBe(text);
    expect(await stores.events.lastSeq()).toBe(0);
    stores.close();
  });
});
