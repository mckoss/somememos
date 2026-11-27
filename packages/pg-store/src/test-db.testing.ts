// Test helpers: a pool on the test database, in a schema of its own per test
// file, and brain fixtures. Test-only (excluded from the build).
//
// The Postgres tests run only when SOMEMEMOS_TEST_DATABASE_URL is set (see
// scripts/dev-postgres.sh); otherwise they are skipped. Nothing here touches
// a database unless that variable is set.

import { randomUUID } from 'node:crypto';
import { storage } from '@somememos/core';
import pg from 'pg';
import { afterAll, describe, it } from 'vitest';
import { query } from './db.js';
import { createPgContentStore, createPgStores } from './stores.js';

export const TEST_DATABASE_URL = process.env.SOMEMEMOS_TEST_DATABASE_URL || undefined;

export const SKIP_MESSAGE =
  'Postgres tests skipped: SOMEMEMOS_TEST_DATABASE_URL is not set ' +
  '(start one with packages/pg-store/scripts/dev-postgres.sh)';

/** Registers `fn`'s tests when the test database is configured, else one skipped test saying why. */
export function describePg(name: string, fn: () => void): void {
  if (TEST_DATABASE_URL) {
    describe(name, fn);
  } else {
    describe(name, () => {
      it.skip(SKIP_MESSAGE, () => {});
    });
  }
}

let warned = false;
/** Logs the skip message once per test file when there is no test database. */
export function warnIfSkipped(): void {
  if (!TEST_DATABASE_URL && !warned) {
    warned = true;
    console.warn(SKIP_MESSAGE);
  }
}

const schemas: string[] = [];
const pools: pg.Pool[] = [];

/** A fresh schema name for this test file. */
export function newSchemaName(): string {
  const name = `somememos_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  schemas.push(name);
  return name;
}

/** A pool on the test database whose search_path is `schema` (created if missing). */
export async function poolFor(schema: string, max = 10): Promise<pg.Pool> {
  if (!TEST_DATABASE_URL) throw new Error(SKIP_MESSAGE);
  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL,
    max,
    options: `-c search_path=${schema}`,
  });
  pools.push(pool);
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  } catch (error) {
    // Postgres does not make CREATE SCHEMA IF NOT EXISTS safe against a
    // concurrent creator: the loser gets a duplicate-key (23505) or
    // duplicate-schema (42P06) error. Either way the schema now exists.
    const code = (error as { code?: string }).code;
    if (code !== '23505' && code !== '42P06') throw error;
  }
  return pool;
}

let shared: Promise<pg.Pool> | undefined;
/** The test file's shared pool, in its own schema. */
export function testPool(): Promise<pg.Pool> {
  shared ??= poolFor(newSchemaName(), 20);
  return shared;
}

if (TEST_DATABASE_URL) {
  afterAll(async () => {
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await Promise.allSettled(pools.splice(0).map((p) => p.end()));
    await admin.connect();
    try {
      for (const schema of schemas.splice(0)) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      }
    } finally {
      await admin.end();
    }
  });
}

/** A fresh brain id. */
export function newBrainId(prefix = 'brain'): string {
  return `${prefix}-${randomUUID()}`;
}

/** Every table with a brain id, in an order safe to delete from. */
export const BRAIN_TABLES = [
  'postings',
  'sections',
  'links',
  'notes',
  'scores',
  'index_meta',
  'index_state',
  'change_paths',
  'changes',
  'events',
  'brain_meta',
  'content',
  'brains',
];

/** Deletes every row of a brain. */
export async function deleteBrain(pool: pg.Pool, brainId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of BRAIN_TABLES) {
      await client.query(`DELETE FROM ${table} WHERE brain_id = $1`, [brainId]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Every row of a brain in every table, as text, for comparing before and
 * after. Generated section ids are left out (they are not part of the data).
 */
export async function snapshotBrain(pool: pg.Pool, brainId: string): Promise<string> {
  const out: Record<string, string[]> = {};
  for (const table of BRAIN_TABLES) {
    const { rows } = await query<{ r: string }>(
      pool,
      `SELECT (to_jsonb(t) - 'id' - 'section')::text AS r FROM ${table} t WHERE brain_id = $1 ORDER BY 1`,
      [brainId],
    );
    out[table] = rows.map((row) => row.r);
  }
  return JSON.stringify(out);
}

const NOW = 1_800_000_000;

/**
 * Fills a brain with data that overlaps what the conformance suites write
 * (the same event ids, paths, terms and meta keys), so a query that forgets
 * its brain id changes their results, and returns its snapshot.
 */
export async function populateNoiseBrain(pool: pg.Pool, brainId: string): Promise<string> {
  const s = await createPgStores({ pool, brainId, now: () => NOW });
  const ids = ['a', 'b', 'c', 'd', 'e', ...Array.from({ length: 30 }, (_, i) => `e${i}`)];
  await s.events.append(
    ids.map((id, i) =>
      i % 7 === 3
        ? {
            id,
            kind: 'rename',
            item: 'memos/x.md',
            to: `memos/noise-${i}.md`,
            time: NOW - i,
            client: 'noise',
          }
        : {
            id,
            kind: (['read', 'edit', 'mention'] as const)[i % 3] as 'read',
            item: i % 2 ? 'memos/x.md' : 'tundra',
            time: NOW - 100 - i,
            client: 'noise',
          },
    ),
  );
  await s.events.appendChanges(
    ['c1', 'c2', 'x'].map((id, i) => ({
      id,
      time: NOW - 10 * i,
      client: 'noise',
      message: 'update noise',
      op: 'update',
      paths: ['memos/x.md', 'memos/y.md'],
    })),
  );
  await s.meta.set('k', 'noise');
  await s.meta.set('client', 'noise');
  await s.indexMeta.set('k', 'noise');
  await s.indexMeta.set('scan', 'noise');
  for (const path of ['memos/x.md', 'memos/y.md', 'memos/one.md', 'memos/two.md']) {
    await s.notes.upsertNote({
      path,
      title: 'Noise',
      contentHash: 'noise',
      mtime: NOW,
      role: 'memo',
      date: null,
    });
    await s.notes.replaceLinks(path, [
      { target: 'ember plan', dangling: true },
      { target: 'saffron', dangling: true },
      { target: 'memos/x.md', dangling: false },
    ]);
    await s.terms.replaceSections(path, 'Harbor lantern', [
      { heading: null, body: 'maple compost harbor lantern planting quartz pebble tundra glacier' },
      { heading: 'Meadow', body: 'violin falcon maple compost planting' },
    ]);
  }
  await storage.foldPending(s.events, s.scores);
  await s.close();
  const content = await createPgContentStore({ pool, brainId, now: () => NOW });
  for (const path of ['memos/x.md', 'memos/a.md', 'diary/2027/01/2027-01-15.md']) {
    await content.write(path, `# Noise\n\nmaple compost [[ember plan]]\n`);
  }
  return snapshotBrain(pool, brainId);
}
