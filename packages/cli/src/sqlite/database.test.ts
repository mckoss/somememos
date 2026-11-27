// Spike for IMPLEMENTATION.md task 0.7: confirm that the built-in `node:sqlite`
// module does everything the CLI's local store relies on.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { close, open } from './database.js';
import type { Database } from './database.js';

const NODE = process.execPath;
const QUIET = '--disable-warning=ExperimentalWarning';

let dir: string;
const opened: Database[] = [];

function openDb(name: string, options?: Parameters<typeof open>[1]): Database {
  const db = open(name === ':memory:' ? name : join(dir, name), options);
  opened.push(db);
  return db;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'somememos-sqlite-'));
});

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Run a CommonJS script in a child `node` process; resolves with its exit code and output. */
function runChild(
  code: string,
  args: string[],
  onStdout?: (text: string) => void,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [QUIET, '-e', code, '--', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      onStdout?.(stdout);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ code: exitCode, stdout, stderr }));
  });
}

describe('node:sqlite basics', () => {
  it('reports the SQLite library version', () => {
    const db = openDb(':memory:');
    const row = db.get<{ v: string }>('select sqlite_version() as v');
    expect(row?.v).toMatch(/^3\.\d+\.\d+$/);
    console.info(`SQLite ${row?.v} (Node ${process.version})`);
  });

  it('opens an in-memory database', () => {
    const db = openDb(':memory:');
    db.exec('create table t (x)');
    db.run('insert into t values (:x)', { x: 1 });
    expect(db.get<{ n: number }>('select count(*) as n from t')?.n).toBe(1);
    // WAL does not apply in memory.
    expect(db.get<{ journal_mode: string }>('pragma journal_mode')?.journal_mode).toBe('memory');
  });

  it('opens a file database, and the data survives reopening', () => {
    const db = openDb('a.sqlite');
    db.exec('create table t (x)');
    db.run('insert into t values (:x)', { x: 'kept' });
    close(db);
    const again = openDb('a.sqlite');
    expect(again.all('select x from t')).toEqual([{ x: 'kept' }]);
  });

  it('binds named parameters and reports changes and row ids', () => {
    const db = openDb(':memory:');
    db.exec('create table t (id integer primary key, a text, b integer)');
    const insert = db.prepare('insert into t (a, b) values (:a, :b)');
    expect(insert.run({ a: 'one', b: 1 })).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(insert.run({ a: 'two', b: 2 })).toEqual({ changes: 1, lastInsertRowid: 2 });
    expect(db.prepare('insert into t (a, b) values (:a, :b)')).toBe(insert); // cached
    expect(db.run('update t set b = b + :d', { d: 10 }).changes).toBe(2);
    expect(db.all('select a, b from t where b > :min order by b', { min: 11 })).toEqual([
      { a: 'two', b: 12 },
    ]);
  });

  it('round-trips INTEGER, REAL, TEXT and NULL, including large integers and precise reals', () => {
    const db = openDb(':memory:');
    db.exec('create table v (id integer primary key, i integer, r real, s text, n)');
    const unixTime = 4_102_444_800; // 2100-01-01, above 2^31
    const bigRowid = 2 ** 40 + 7;
    // TimeScore log scores for a one-day half-life: about 14,000, all 17 digits significant.
    const reals = [1_780_000_000, 1_780_000_017, 1_712_345_678].map((t) => (t * Math.LN2) / 86_400);
    reals.forEach((r, k) =>
      db.run('insert into v values (:id, :i, :r, :s, :n)', {
        id: bigRowid + k,
        i: unixTime + k,
        r,
        s: `text ${k} — ünïcode`,
        n: null,
      }),
    );
    const rows = db.all<{ id: number; i: number; r: number; s: string; n: null }>(
      'select id, i, r, s, n, typeof(i) as ti, typeof(r) as tr from v order by id',
    );
    rows.forEach((row, k) => {
      expect(row).toMatchObject({ id: bigRowid + k, i: unixTime + k, s: `text ${k} — ünïcode` });
      expect(row.r).toBe(reals[k]); // exact: stored as an 8-byte IEEE double
      expect(row.n).toBeNull();
      expect(row).toMatchObject({ ti: 'integer', tr: 'real' });
    });
    expect(unixTime).toBeGreaterThan(2 ** 31);
  });
});

describe('transactions', () => {
  it('commits on return and rolls back on error', () => {
    const db = openDb('tx.sqlite');
    db.exec('create table t (x integer)');
    db.transaction((tx) => {
      tx.run('insert into t values (1)');
      tx.run('insert into t values (2)');
    });
    expect(() =>
      db.transaction((tx) => {
        tx.run('insert into t values (3)');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.all('select x from t order by x')).toEqual([{ x: 1 }, { x: 2 }]);
    expect(db.raw.isTransaction).toBe(false);
  });

  it('rolls back a nested transaction on its own', () => {
    const db = openDb(':memory:');
    db.exec('create table t (x integer)');
    db.transaction((tx) => {
      tx.run('insert into t values (1)');
      expect(() =>
        tx.transaction((inner) => {
          inner.run('insert into t values (2)');
          throw new Error('inner');
        }),
      ).toThrow('inner');
      tx.run('insert into t values (3)');
    });
    expect(db.all('select x from t order by x')).toEqual([{ x: 1 }, { x: 3 }]);
  });

  it('returns the value of fn', () => {
    const db = openDb(':memory:');
    expect(db.transaction(() => 42)).toBe(42);
  });
});

describe('TimeScore event fold (PLAN.md section 4)', () => {
  const HALF_LIVES = { day: 86_400, week: 7 * 86_400, month: 30 * 86_400, year: 365 * 86_400 };
  // The exact statement from PLAN.md section 4.
  const FOLD = `INSERT INTO scores (item, kind, half_life, log_score)
VALUES (:item, :kind, :hl, :e)
ON CONFLICT (item, kind, half_life) DO UPDATE SET
  log_score = max(log_score, :e) + ln(1 + exp(-abs(log_score - :e)));`;

  const eventScore = (time: number, halfLife: number) => (time * Math.LN2) / halfLife;
  const combineSql = (a: number, b: number) =>
    Math.max(a, b) + Math.log(1 + Math.exp(-Math.abs(a - b)));
  const combine = (a: number, b: number) => {
    const high = Math.max(a, b);
    const low = Math.min(a, b);
    return low === -Infinity ? high : high + Math.log1p(Math.exp(low - high));
  };

  it('has the math functions ln and exp', () => {
    const db = openDb(':memory:');
    expect(db.get('select ln(1) as a, exp(0) as b, max(1, 2) as c, abs(-3) as d')).toEqual({
      a: 0,
      b: 1,
      c: 2,
      d: 3,
    });
  });

  it('folds events with the upsert and matches the same computation in JavaScript', () => {
    const db = openDb(':memory:');
    db.exec(`CREATE TABLE scores (
      item TEXT NOT NULL, kind TEXT NOT NULL, half_life TEXT NOT NULL, log_score REAL NOT NULL,
      PRIMARY KEY (item, kind, half_life))`);
    const fold = db.prepare(FOLD);

    // Invented events: a burst within minutes, then days and weeks apart, one old event.
    const start = 1_780_000_000;
    const times = [0, 60, 120, 600, 86_400, 3 * 86_400, 20 * 86_400, -200 * 86_400, 21 * 86_400];
    const expectedSql = new Map<string, number>();
    const expectedRef = new Map<string, number>();
    db.transaction(() => {
      for (const offset of times) {
        for (const [hl, seconds] of Object.entries(HALF_LIVES)) {
          for (const item of ['memos/alpha.md', 'memos/beta.md']) {
            if (item === 'memos/beta.md' && offset < 0) continue;
            const e = eventScore(start + offset, seconds);
            fold.run({ item, kind: 'edit', hl, e });
            const key = `${item}|${hl}`;
            const old = expectedSql.get(key);
            expectedSql.set(key, old === undefined ? e : combineSql(old, e));
            expectedRef.set(key, combine(expectedRef.get(key) ?? -Infinity, e));
          }
        }
      }
    });

    const rows = db.all<{ item: string; half_life: string; log_score: number }>(
      'select item, half_life, log_score from scores',
    );
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      const key = `${row.item}|${row.half_life}`;
      // Same formula in JS: identical, or within an ulp or two.
      expect(Math.abs(row.log_score - expectedSql.get(key)!)).toBeLessThanOrEqual(
        4 * Number.EPSILON * Math.abs(row.log_score),
      );
      // Against the reference log1p form: well within the ~11 digits TimeScore keeps.
      expect(Math.abs(row.log_score - expectedRef.get(key)!)).toBeLessThan(1e-9);
    }
    const day = rows.find((r) => r.item === 'memos/alpha.md' && r.half_life === 'day')!;
    expect(day.log_score).toBeGreaterThan(14_000);
    expect(day.log_score).toBeLessThan(15_000);
  });

  it('two simultaneous events add exactly ln 2', () => {
    const db = openDb(':memory:');
    db.exec(`CREATE TABLE scores (item TEXT, kind TEXT, half_life TEXT, log_score REAL NOT NULL,
      PRIMARY KEY (item, kind, half_life)) WITHOUT ROWID`);
    const e = eventScore(1_780_000_000, HALF_LIVES.day);
    db.run(FOLD, { item: 'x', kind: 'read', hl: 'day', e });
    db.run(FOLD, { item: 'x', kind: 'read', hl: 'day', e });
    const L = db.get<{ log_score: number }>('select log_score from scores')!.log_score;
    expect(L - e).toBeCloseTo(Math.LN2, 9);
  });
});

describe('concurrency', () => {
  it('uses WAL on a file database', () => {
    const db = openDb('wal.sqlite');
    expect(db.get<{ journal_mode: string }>('pragma journal_mode')?.journal_mode).toBe('wal');
    expect(db.get<{ timeout: number }>('pragma busy_timeout')?.timeout).toBe(5000);
  });

  it('a reader sees the last commit while a writer holds a transaction (WAL)', () => {
    const writer = openDb('rw.sqlite');
    writer.exec('create table t (x integer); insert into t values (1)');
    const reader = openDb('rw.sqlite');
    writer.exec('BEGIN IMMEDIATE; insert into t values (2)');
    expect(reader.all('select x from t')).toEqual([{ x: 1 }]);
    writer.exec('COMMIT');
    expect(reader.all('select x from t order by x')).toEqual([{ x: 1 }, { x: 2 }]);
  });

  it('a second connection waits for the busy timeout instead of failing at once', () => {
    const holder = openDb('busy.sqlite');
    holder.exec('create table t (x integer)');
    holder.exec('BEGIN IMMEDIATE; insert into t values (1)');

    const impatient = openDb('busy.sqlite', { busyTimeoutMs: 0 });
    let t0 = performance.now();
    expect(() => impatient.run('insert into t values (2)')).toThrow(/locked|busy/i);
    expect(performance.now() - t0).toBeLessThan(100);

    const patient = openDb('busy.sqlite', { busyTimeoutMs: 400 });
    t0 = performance.now();
    expect(() => patient.transaction((tx) => tx.run('insert into t values (3)'))).toThrow(
      /locked|busy/i,
    );
    expect(performance.now() - t0).toBeGreaterThanOrEqual(350);
    holder.exec('COMMIT');
  });

  it('a waiting writer succeeds once another process releases its lock', async () => {
    const db = openDb('handoff.sqlite');
    db.exec('create table t (who text)');
    const file = join(dir, 'handoff.sqlite');
    const child = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1], { timeout: 5000 });
      db.exec("BEGIN IMMEDIATE; insert into t values ('child')");
      console.log('locked');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 400);
    `;
    let resolveLocked!: () => void;
    const locked = new Promise<void>((r) => (resolveLocked = r));
    const done = runChild(child, [file], (out) => out.includes('locked') && resolveLocked());
    await locked;
    const t0 = performance.now();
    db.transaction((tx) => tx.run("insert into t values ('parent')")); // blocks until the child commits
    const waited = performance.now() - t0;
    expect((await done).code).toBe(0);
    expect(waited).toBeGreaterThan(200);
    expect(db.all('select who from t order by rowid')).toEqual([
      { who: 'child' },
      { who: 'parent' },
    ]);
  });

  it('several processes append to the same file concurrently without losing rows', async () => {
    const file = join(dir, 'append.sqlite');
    const db = openDb('append.sqlite');
    db.exec(`create table events (seq integer primary key, proc integer not null, n integer not null,
      unique (proc, n))`);
    const PROCESSES = 4;
    const ROWS = 150;
    const child = `
      const { DatabaseSync } = require('node:sqlite');
      const [file, proc, rows] = process.argv.slice(1);
      const db = new DatabaseSync(file, { timeout: 10000 });
      db.exec('PRAGMA journal_mode = WAL');
      const insert = db.prepare('insert into events (proc, n) values (?, ?)');
      for (let n = 0; n < Number(rows); n++) {
        db.exec('BEGIN IMMEDIATE');
        insert.run(Number(proc), n);
        db.exec('COMMIT');
      }
      db.close();
    `;
    const results = await Promise.all(
      Array.from({ length: PROCESSES }, (_, p) => runChild(child, [file, String(p), String(ROWS)])),
    );
    for (const result of results) {
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
    }
    expect(db.get('select count(*) as n, count(distinct proc) as p from events')).toEqual({
      n: PROCESSES * ROWS,
      p: PROCESSES,
    });
    const perProc = db.all<{ c: number; lo: number; hi: number }>(
      'select count(*) as c, min(n) as lo, max(n) as hi from events group by proc',
    );
    expect(perProc).toEqual(Array(PROCESSES).fill({ c: ROWS, lo: 0, hi: ROWS - 1 }));
  }, 30_000);
});

describe('schema features', () => {
  it('supports WITHOUT ROWID tables with a composite primary key, used for range scans', () => {
    const db = openDb(':memory:');
    db.exec(`create table scores (
      item text not null, kind text not null, half_life text not null, log_score real not null,
      primary key (item, kind, half_life)) without rowid`);
    db.run("insert into scores values ('memos/a.md', 'edit', 'day', 1.5)");
    expect(() => db.run("insert into scores values ('memos/a.md', 'edit', 'day', 2)")).toThrow(
      /UNIQUE|PRIMARY KEY/,
    );
    const plan = db
      .all<{ detail: string }>(
        `explain query plan select * from scores where item = :i and kind >= :lo and kind < :hi`,
        { i: 'memos/a.md', lo: 'a', hi: 'z' },
      )
      .map((r) => r.detail)
      .join('\n');
    expect(plan).toMatch(/SEARCH scores USING PRIMARY KEY \(item=\? AND kind>\? AND kind<\?\)/);
  });

  it('uses a secondary index for a time-range scan', () => {
    const db = openDb(':memory:');
    db.exec(`create table events (seq integer primary key, id text not null unique,
      item text not null, kind text not null, time integer not null);
      create index events_time on events (time);`);
    const plan = db
      .all<{ detail: string }>(
        'explain query plan select seq from events where time >= :from and time < :to',
        { from: 1_780_000_000, to: 1_790_000_000 },
      )
      .map((r) => r.detail)
      .join('\n');
    expect(plan).toMatch(
      /SEARCH events USING (COVERING )?INDEX events_time \(time>\? AND time<\?\)/,
    );
  });
});

describe('optional extensions (reported, not required)', () => {
  it('reports whether FTS5 is available', () => {
    const db = openDb(':memory:');
    let fts5: boolean;
    try {
      db.exec("create virtual table probe using fts5(body, tokenize = 'porter unicode61')");
      db.run('insert into probe values (:b)', { b: 'running foxes' });
      fts5 = db.all("select * from probe where probe match 'run'").length === 1;
    } catch {
      fts5 = false;
    }
    console.info(`FTS5 available: ${fts5}`);
    expect(typeof fts5).toBe('boolean');
  });

  it('reports whether the JSON functions are available', () => {
    const db = openDb(':memory:');
    let json: boolean;
    try {
      const row = db.get<{ v: number }>(`select json_extract('{"a":[1,2,3]}', '$.a[2]') as v`);
      json = row?.v === 3;
    } catch {
      json = false;
    }
    console.info(`JSON functions available: ${json}`);
    expect(typeof json).toBe('boolean');
  });
});

describe('the experimental warning', () => {
  it('reports whether importing node:sqlite prints an ExperimentalWarning', () => {
    const plain = spawnSync(NODE, ['-e', "require('node:sqlite')"], { encoding: 'utf8' });
    const warns = /ExperimentalWarning: SQLite/.test(plain.stderr);
    console.info(`node:sqlite prints an ExperimentalWarning on ${process.version}: ${warns}`);
    const quiet = spawnSync(NODE, [QUIET, '-e', "require('node:sqlite')"], { encoding: 'utf8' });
    expect(quiet.stderr).toBe('');
  });

  it.skipIf(!process.features.typescript)(
    'the wrapper loads node:sqlite without printing the warning, and keeps other warnings',
    () => {
      const wrapper = fileURLToPath(new URL('./database.ts', import.meta.url));
      const code = `
        const { open } = await import(${JSON.stringify(wrapper)});
        const db = open(':memory:');
        console.log(db.get('select 1 as one').one);
        process.emitWarning('still shown', 'ExperimentalWarning');
      `;
      const result = spawnSync(NODE, ['--input-type=module', '-e', code], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('1');
      expect(result.stderr).not.toMatch(/SQLite/);
      expect(result.stderr).toMatch(/still shown/);
    },
  );
});
