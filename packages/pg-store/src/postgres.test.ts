// Postgres-specific tests: migrations under concurrent start, the per-brain
// seq under concurrent appends (no reader can skip past a late commit),
// concurrent folds, brain isolation, the mutation counter, and a generated
// brain of ~1,000 notes indexed and searched exactly like the reference.
// All note text is invented.

import { engine, keyword, storage } from '@somememos/core';
import { expectScoresClose } from '@somememos/core/testing/storage';
import type pg from 'pg';
import { afterEach, expect, it } from 'vitest';
import { advanceMutationSeq, mutationSeq } from './brains.js';
import { query } from './db.js';
import { migrate } from './migrate.js';
import { MIGRATIONS } from './schema.js';
import { createPgContentStore, createPgStores, type PgStores } from './stores.js';
import {
  deleteBrain,
  describePg,
  newBrainId,
  newSchemaName,
  poolFor,
  testPool,
  warnIfSkipped,
} from './test-db.testing.js';

warnIfSkipped();

const NOW = 1_800_000_000;
const ITEMS = ['memos/a.md', 'memos/b.md', 'memos/c.md', 'some key'];

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** Stores for a fresh brain on `pool`, deleted after the test. */
async function freshStores(pool: pg.Pool, brainId = newBrainId()): Promise<PgStores> {
  const stores = await createPgStores({ pool, brainId, now: () => NOW });
  cleanup.push(async () => {
    await stores.close();
    await deleteBrain(pool, brainId);
  });
  return stores;
}

const ev = (id: string, i: number): storage.EventInput => ({
  id,
  kind: (['read', 'edit', 'mention'] as const)[i % 3] as storage.EventInput['kind'],
  item: ITEMS[i % ITEMS.length] as string,
  time: NOW - 1000 + (i % 997),
  client: 'test',
});

/**
 * Follows a log with a cursor, as a folder or a sync reader does, while
 * writers append. Every page must start right after the cursor and have no
 * holes; a page that skips a seq means an entry with a lower seq can still
 * commit, and a reader at this cursor would never see it.
 */
function cursorReader(read: (cursor: number) => Promise<{ seq: number; id: string }[]>) {
  let cursor = 0;
  const seen: string[] = [];
  const holes: string[] = [];
  return {
    async step(): Promise<number> {
      const page = await read(cursor);
      for (const e of page) {
        if (e.seq !== cursor + 1) holes.push(`expected seq ${cursor + 1}, got ${e.seq}`);
        cursor = e.seq;
        seen.push(e.id);
      }
      return page.length;
    },
    get seen() {
      return seen;
    },
    get holes() {
      return holes;
    },
  };
}

describePg('postgres store', () => {
  it('applies migrations once, safely under a concurrent start', { timeout: 60_000 }, async () => {
    const schema = newSchemaName();
    const pools = await Promise.all(Array.from({ length: 6 }, () => poolFor(schema, 2)));
    const results = await Promise.all(pools.map((p) => migrate(p)));
    const latest = MIGRATIONS.at(-1)?.version as number;
    expect(results.flatMap((r) => r.applied)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(results.every((r) => r.version === latest)).toBe(true);
    const pool = pools[0] as pg.Pool;
    const { rows } = await query<{ version: number }>(
      pool,
      `SELECT version FROM schema_migrations ORDER BY version`,
    );
    expect(rows.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));

    // Idempotent afterwards.
    expect((await migrate(pool)).applied).toEqual([]);

    // Stores work in the new schema, opened from several pools at once.
    const brainId = newBrainId();
    const opened = await Promise.all(
      pools.map((p) => createPgStores({ pool: p, brainId, now: () => NOW })),
    );
    await (opened[0] as PgStores).events.append([ev('x', 0)]);
    expect(await (opened[5] as PgStores).events.lastSeq()).toBe(1);

    // A migration this code does not know: refused, nothing changed.
    await pool.query(`INSERT INTO schema_migrations (version, name) VALUES (9999, 'future')`);
    await expect(migrate(pool)).rejects.toThrow(storage.MigrationRequiredError);
    expect(await (opened[1] as PgStores).events.lastSeq()).toBe(1);
  });

  it(
    'never lets a cursor reader skip an entry, with many concurrent appenders',
    { timeout: 120_000 },
    async () => {
      const pool = await testPool();
      const brainId = newBrainId();
      const writers = await Promise.all(
        Array.from({ length: 8 }, () => freshStores(pool, brainId)),
      );
      const reader = await freshStores(pool, brainId);
      const rounds = 40;
      const perRound = 4;

      let writing = true;
      const follower = cursorReader((cursor) => Promise.resolve(reader.events.readAfter(cursor)));
      const following = (async () => {
        while (writing) await follower.step();
        while ((await follower.step()) > 0);
      })();

      const appended = await Promise.all(
        writers.map(async (stores, w) => {
          let n = 0;
          for (let r = 0; r < rounds; r++) {
            const batch: storage.LogInput[] = [];
            for (let j = 0; j < perRound; j++) batch.push(ev(`w${w}-${r}-${j}`, r * perRound + j));
            // Every writer also sends the same shared ids, as sync retries would.
            batch.push(ev(`shared-${r}`, r));
            n += (await stores.events.append(batch)).appended;
          }
          return n;
        }),
      );
      writing = false;
      await following;

      const total = writers.length * rounds * perRound + rounds;
      expect(appended.reduce((a, b) => a + b, 0)).toBe(total);
      expect(follower.holes).toEqual([]);
      expect(follower.seen.length).toBe(total);
      expect(new Set(follower.seen).size).toBe(total);
      const log = await reader.events.readAfter(0);
      expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1));
      expect(await reader.events.lastSeq()).toBe(total);
    },
  );

  it('would catch the gap problem: a sequence column lets a reader skip', async () => {
    // The checker above, against the naive design (seq from a sequence,
    // taken at insert time): an earlier insert that commits late is skipped.
    const pool = await testPool();
    const table = `naive_${Math.random().toString(36).slice(2, 10)}`;
    await pool.query(`CREATE TABLE ${table} (seq bigserial PRIMARY KEY, id text NOT NULL)`);
    cleanup.push(async () => void (await pool.query(`DROP TABLE ${table}`)));
    const slow = await pool.connect();
    try {
      await slow.query('BEGIN');
      await slow.query(`INSERT INTO ${table} (id) VALUES ('slow')`); // takes seq 1
      await pool.query(`INSERT INTO ${table} (id) VALUES ('fast')`); // seq 2, commits first
      const follower = cursorReader(async (cursor) => {
        const { rows } = await query<{ seq: number; id: string }>(
          pool,
          `SELECT seq, id FROM ${table} WHERE seq > $1 ORDER BY seq`,
          [cursor],
        );
        return rows;
      });
      await follower.step();
      await slow.query('COMMIT');
      await follower.step();
      expect(follower.seen).toEqual(['fast']);
      expect(follower.holes.length).toBeGreaterThan(0);
    } finally {
      slow.release();
    }
  });

  it('holds a reader back while an append is in flight, instead of skipping', async () => {
    // The same race against the store: an append whose transaction is still
    // open blocks the next append, so nothing with a higher seq commits first.
    const pool = await testPool();
    const stores = await freshStores(pool);
    await stores.events.append([ev('first', 0)]);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT 1 FROM brains WHERE brain_id = $1 FOR NO KEY UPDATE`, [
        stores.brainId,
      ]);
      let done = false;
      const pending = Promise.resolve(stores.events.append([ev('second', 1)])).then(() => {
        done = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(done).toBe(false);
      expect((await stores.events.readAfter(1)).length).toBe(0);
      await blocker.query('COMMIT');
      await pending;
      expect((await stores.events.readAfter(1)).map((e) => [e.seq, e.id])).toEqual([[2, 'second']]);
    } finally {
      blocker.release();
    }
  });

  it(
    'folds concurrently from several connections without double counting',
    { timeout: 240_000 },
    async () => {
      const pool = await testPool();
      for (const window of [0, 3600]) {
        const brainId = newBrainId();
        const folders = await Promise.all(
          Array.from({ length: 5 }, () => freshStores(pool, brainId)),
        );
        let conflicts = 0;
        const rename = (id: string, item: string, to: string, time: number): storage.LogInput => ({
          id,
          kind: 'rename',
          item,
          to,
          time,
          client: 'test',
        });
        await Promise.all(
          folders.map(async (stores, w) => {
            for (let r = 0; r < 25; r++) {
              const batch: storage.LogInput[] = [];
              for (let j = 0; j < 5; j++) batch.push(ev(`f${w}-${r}-${j}`, w * 7 + r * 3 + j));
              batch.push(ev(`shared-${r}`, r));
              // One item renamed several times in one second (ids not in
              // arrival order), a cycle within one second, a chain over two.
              if (w === 0 && r % 5 === 4) {
                batch.push(rename(`rename-${r}`, 'some key', `memos/key-${r}.md`, NOW - 500));
              }
              if (w === 1 && r % 7 === 3) {
                batch.push(rename(`cycle-${r}-b`, 'memos/b.md', 'memos/c.md', NOW - 400));
                batch.push(rename(`cycle-${r}-a`, 'memos/c.md', 'memos/b.md', NOW - 400));
              }
              if (w === 2 && r % 6 === 2) {
                batch.push(rename(`chain-${r}-1`, 'memos/a.md', `memos/ch-${r}.md`, NOW - 300));
                batch.push(rename(`chain-${r}-0`, `memos/ch-${r}.md`, 'memos/a.md', NOW - 299));
              }
              await stores.events.append(batch);
              conflicts += (
                await storage.foldPending(stores.events, stores.scores, {
                  batchSize: 2 + w,
                  burstWindow: window,
                })
              ).conflicts;
            }
          }),
        );
        const s = folders[0] as PgStores;
        const log = await s.events.readAfter(0);
        expect((await s.scores.foldState()).cursor).toBe(log.length);
        const folded = await s.scores.getAll();
        const items = [...folded.keys()];
        const burst = await s.scores.burstState(items);

        const memory = storage.createMemoryStores();
        await memory.events.append(
          log.map(({ seq: _seq, ...input }) => input as storage.LogInput),
          { now: NOW },
        );
        await storage.rebuildScores(memory.events, memory.scores, { burstWindow: window });
        expectScoresClose(folded, await memory.scores.getAll());
        expect(burst).toEqual(await memory.scores.burstState(items));

        // And a rebuild in Postgres agrees too.
        await storage.rebuildScores(s.events, s.scores, { burstWindow: window });
        expectScoresClose(await s.scores.getAll(), folded);
        // Conflicts are expected but not guaranteed; the point is that none double-counted.
        expect(conflicts).toBeGreaterThanOrEqual(0);
      }
    },
  );

  it('reports an index built under older analyzer rules as stale, so it rebuilds', async () => {
    const pool = await testPool();
    const brainId = newBrainId();
    const s = await freshStores(pool, brainId);
    await s.terms.replaceSections('memos/a.md', 'Basalt', [{ heading: null, body: 'columns' }]);
    expect(s.terms.analyzerMismatch()).toBeNull();
    // As an index written before the analyzer format was recorded.
    await query(pool, `UPDATE index_state SET analyzer = '{"stem":true}' WHERE brain_id = $1`, [
      brainId,
    ]);
    const again = await createPgStores({ pool, brainId, now: () => NOW });
    try {
      expect(again.terms.analyzer).toEqual({ stem: true, format: 1 });
      expect(again.terms.analyzerMismatch()).toMatchObject({
        requested: { format: keyword.ANALYZER_FORMAT },
      });
      await again.resetIndex();
      expect(again.terms.analyzerMismatch()).toBeNull();
    } finally {
      await again.close();
    }
  });

  it('stores scores bit for bit as the memory store folds them', async () => {
    const pool = await testPool();
    const s = await freshStores(pool);
    const memory = storage.createMemoryStores({ now: () => NOW });
    const entries: storage.LogInput[] = Array.from({ length: 300 }, (_, i) => ev(`b${i}`, i * 13));
    for (let i = 0; i < entries.length; i += 37) {
      const batch = entries.slice(i, i + 37);
      await s.events.append(batch);
      await memory.events.append(batch);
      await storage.foldPending(s.events, s.scores, { batchSize: 11 });
      await storage.foldPending(memory.events, memory.scores, { batchSize: 11 });
    }
    expect(await s.scores.getAll()).toEqual(await memory.scores.getAll());
  });

  it('keeps brains apart', async () => {
    const pool = await testPool();
    const a = await freshStores(pool);
    const b = await freshStores(pool);
    // The same ids in both brains: each is new in each, and each brain counts from 1.
    expect(await a.events.append([ev('same', 0), ev('other', 1)])).toEqual({
      appended: 2,
      duplicates: 0,
    });
    expect(await b.events.append([ev('same', 2)])).toEqual({ appended: 1, duplicates: 0 });
    expect((await b.events.readAfter(0)).map((e) => [e.seq, e.id, e.kind])).toEqual([
      [1, 'same', 'mention'],
    ]);
    await a.events.appendChanges([
      { id: 'c', time: NOW, client: 't', message: null, op: null, paths: ['memos/a.md'] },
    ]);
    expect(await b.events.changes()).toEqual([]);

    await a.meta.set('k', 'a');
    await b.meta.set('k', 'b');
    expect(await a.meta.get('k')).toBe('a');
    await a.notes.upsertNote({
      path: 'memos/a.md',
      title: 'A',
      contentHash: 'h',
      mtime: NOW,
      role: 'memo',
      date: null,
    });
    await a.terms.replaceSections('memos/a.md', 'A', [{ heading: null, body: 'harbor lantern' }]);
    await b.terms.replaceSections('memos/a.md', 'B', [{ heading: null, body: 'harbor' }]);
    await storage.foldPending(a.events, a.scores);
    expect((await b.scores.foldState()).cursor).toBe(0);
    expect(await b.notes.listNotes()).toEqual([]);
    expect(await keyword.searchSource(b.terms, 'lantern')).toEqual([]);
    expect((await b.terms.statistics()).sectionCount).toBe(1);

    await b.resetIndex();
    expect((await a.terms.statistics()).sectionCount).toBe(1);
    expect((await a.scores.foldState()).cursor).toBe(2);
    expect((await a.notes.listNotes()).length).toBe(1);

    const ca = await createPgContentStore({ pool, brainId: a.brainId, now: () => NOW });
    const cb = await createPgContentStore({ pool, brainId: b.brainId, now: () => NOW });
    await ca.write('memos/a.md', 'one');
    expect(await cb.read('memos/a.md')).toBeUndefined();
    await cb.write('memos/a.md', 'two');
    await ca.rename('memos/a.md', 'memos/z.md');
    expect(await cb.read('memos/a.md')).toBe('two');
    expect(await ca.list()).toHaveLength(1);

    expect(await advanceMutationSeq(pool, a.brainId)).toBe(1);
    expect(await mutationSeq(pool, b.brainId)).toBe(0);
  });

  it('hands out mutation numbers in commit order, without gaps', async () => {
    const pool = await testPool();
    const s = await freshStores(pool);
    const got = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const n = await advanceMutationSeq(client, s.brainId, 2);
          await client.query('COMMIT');
          return n;
        } finally {
          client.release();
        }
      }),
    );
    expect(got.sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => 2 * (i + 1)));
    expect(await mutationSeq(pool, s.brainId)).toBe(40);
    await expect(advanceMutationSeq(pool, 'no such brain')).rejects.toThrow(RangeError);
  });

  it('lets events be appended during an index transaction, outside it', async () => {
    const pool = await testPool();
    const s = await freshStores(pool);
    await expect(
      s.indexTransaction(async () => {
        await s.notes.upsertNote({
          path: 'memos/a.md',
          title: 'A',
          contentHash: 'h',
          mtime: NOW,
          role: 'memo',
          date: null,
        });
        // On another connection; must not wait for this transaction (which
        // holds a key-share lock on the brain row through the note's foreign key).
        await s.events.append([ev('during', 0)]);
        await s.events.appendChanges([
          { id: 'c', time: NOW, client: 't', message: null, op: null, paths: [] },
        ]);
        await s.meta.set('durable', 'yes');
        throw new Error('abandon the pass');
      }),
    ).rejects.toThrow('abandon the pass');
    expect(await s.notes.listNotes()).toEqual([]);
    expect(await s.events.lastSeq()).toBe(1);
    expect(await s.events.changes()).toHaveLength(1);
    expect(await s.meta.get('durable')).toBe('yes');
  });

  it('refuses to commit an index transaction after a swallowed database error', async () => {
    const pool = await testPool();
    const s = await freshStores(pool);
    await expect(
      s.indexTransaction(async () => {
        await s.indexMeta.set('a', 'b');
        // Postgres text cannot hold NUL: the statement fails and aborts the transaction.
        await Promise.resolve(s.indexMeta.set('bad', 'x\u0000y')).catch(() => undefined);
        return 'ignored the error';
      }),
    ).rejects.toThrow(/aborted/);
    expect(await s.indexMeta.get('a')).toBeUndefined();
  });

  it(
    'indexes a generated brain of 1,000 notes and searches it exactly like the reference',
    { timeout: 300_000 },
    async () => {
      const pool = await testPool();
      const brainId = newBrainId();
      const stores = await freshStores(pool, brainId);
      const content = await createPgContentStore({ pool, brainId, now: () => NOW });
      const memoryStores = storage.createMemoryStores({ now: () => NOW });
      const memoryContent = storage.createMemoryContentStore({ now: () => NOW });
      const files = generatedNotes(1000);
      for (const [path, text] of files) {
        await content.write(path, text, { mtime: NOW - 100 });
        await memoryContent.write(path, text, { mtime: NOW - 100 });
      }
      const config = storage.parseBrainConfig({
        clientId: 'test-client',
        roles: { memo: ['memos/'], dated: [], source: [], excluded: [] },
      });
      const pgEngine = engine.createEngine({ stores, content, config, now: () => NOW });
      const memEngine = engine.createEngine({
        stores: memoryStores,
        content: memoryContent,
        config,
        now: () => NOW,
      });

      let t = performance.now();
      await pgEngine.index();
      const indexMs = performance.now() - t;
      t = performance.now();
      await memEngine.index();
      const memoryIndexMs = performance.now() - t;

      const stats = await stores.terms.statistics();
      expect(stats).toEqual(await memoryStores.terms.statistics());
      expect(stats.sectionCount).toBeGreaterThan(2000);
      expect(await stores.scores.getAll()).toEqual(await memoryStores.scores.getAll());

      // A fresh MemoryKeywordIndex over the stored sections.
      const reference = new keyword.MemoryKeywordIndex({ analyzer: stores.terms.analyzer });
      for (const note of await stores.notes.listNotes()) {
        for (const sec of await stores.terms.sectionsOf(note.path)) {
          reference.add(sec.id, { title: sec.title, heading: sec.heading ?? '', body: sec.body });
        }
      }
      const queries = [
        'valdor',
        'mirela quorn',
        '"tasso brindle"',
        'kelvar OR ostrin',
        'plume',
        'harbor lantern compost',
      ];
      const searchTimes: number[] = [];
      for (const q of queries) {
        t = performance.now();
        const hits = await keyword.searchSource(stores.terms, q);
        searchTimes.push(performance.now() - t);
        expect(hits).toEqual(reference.search(q));
        expect(hits).toEqual(await keyword.searchSource(memoryStores.terms, q));
      }
      t = performance.now();
      const response = await pgEngine.search('mirela quorn');
      const engineSearchMs = performance.now() - t;
      expect(response.results.length).toBeGreaterThan(0);

      t = performance.now();
      await pgEngine.index();
      const noopIndexMs = performance.now() - t;

      console.info(
        `[pg-store timing] ${files.length} notes, ${stats.sectionCount} sections, ` +
          `${stats.documentFrequencies.length} terms: index ${Math.round(indexMs)} ms ` +
          `(memory ${Math.round(memoryIndexMs)} ms), unchanged re-index ${Math.round(noopIndexMs)} ms; ` +
          `searchSource ${searchTimes.map((x) => x.toFixed(1)).join('/')} ms; ` +
          `engine.search ${engineSearchMs.toFixed(1)} ms`,
      );
    },
  );
});

/** ~1,000 invented notes from a seeded generator: made-up words, sections and links. */
function generatedNotes(count: number): [string, string][] {
  let state = 0x2545f491;
  const rand = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
  const syllables = ['val', 'dor', 'mir', 'ela', 'quo', 'rn', 'tas', 'so', 'brin', 'dle', 'kel'];
  const more = ['var', 'ost', 'rin', 'plu', 'me', 'har', 'bor', 'lan', 'tern', 'com', 'post'];
  const all = [...syllables, ...more];
  const vocabulary = new Set<string>([
    'valdor',
    'mirela',
    'quorn',
    'tasso',
    'brindle',
    'kelvar',
    'ostrin',
    'plume',
    'harbor',
    'lantern',
    'compost',
  ]);
  while (vocabulary.size < 3000)
    vocabulary.add(pick(all) + pick(all) + (rand() < 0.5 ? pick(all) : ''));
  const words = [...vocabulary];
  const sentence = (n: number) => Array.from({ length: n }, () => pick(words)).join(' ');
  const name = (i: number) => `note-${String(i).padStart(4, '0')}`;
  const out: [string, string][] = [];
  for (let i = 0; i < count; i++) {
    const parts = [
      `# ${sentence(3)}`,
      '',
      `${sentence(40)} [[${name(Math.floor(rand() * count))}]].`,
    ];
    const sections = 1 + Math.floor(rand() * 3);
    for (let s = 0; s < sections; s++) {
      parts.push('', `## ${sentence(2)}`, '', sentence(60 + Math.floor(rand() * 60)));
      if (rand() < 0.3) parts.push(`See [[${pick(words)} ${pick(words)}]].`);
    }
    out.push([`memos/${name(i)}.md`, parts.join('\n') + '\n']);
  }
  return out;
}
