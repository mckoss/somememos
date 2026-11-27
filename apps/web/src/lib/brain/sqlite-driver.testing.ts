// Direct tests of the guarantees in packages/sqlite-store/src/driver.ts, for
// any `SqlDriver`. Test-only (imports vitest): `sqlite-driver.test.ts` runs
// them in Node on an in-memory database, and the browser storage tests
// (apps/web/e2e-storage) run them in a worker on OPFS, with `vitest` replaced
// by a small shim. All data here is invented.

import { afterEach, describe, expect, it } from 'vitest';
import type { SqlDriver } from '@somememos/sqlite-store';

/** Opens a new, empty database; `reopen` opens the same one again after `close()`. */
export interface DriverHarness {
  open(): SqlDriver | Promise<SqlDriver>;
  reopen?(driver: SqlDriver): SqlDriver | Promise<SqlDriver>;
  dispose?(): void | Promise<void>;
}

export function describeDriverConformance(name: string, harness: DriverHarness): void {
  describe(`sqlite driver: ${name}`, () => {
    const opened: SqlDriver[] = [];
    const open = async (): Promise<SqlDriver> => {
      const db = await harness.open();
      opened.push(db);
      return db;
    };
    afterEach(async () => {
      for (const db of opened.splice(0)) db.close();
      await harness.dispose?.();
    });

    it('binds named parameters and reports changes and row ids', async () => {
      const db = await open();
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, n INTEGER)');
      const insert = db.prepare('INSERT INTO t (name, n) VALUES (:name, :n)');
      expect(insert.run({ name: 'alpha', n: 1 })).toEqual({ changes: 1, lastInsertRowid: 1 });
      expect(insert.run({ name: 'beta', n: 2 })).toEqual({ changes: 1, lastInsertRowid: 2 });
      const update = db.prepare('UPDATE t SET n = n + :by WHERE n >= :min');
      expect(update.run({ by: 10, min: 0 }).changes).toBe(2);
      expect(db.prepare('SELECT name, n FROM t WHERE name = :name').get({ name: 'beta' })).toEqual({
        name: 'beta',
        n: 12,
      });
      expect(db.prepare('SELECT name FROM t WHERE name = :name').get({ name: 'none' })).toBe(
        undefined,
      );
      expect(db.prepare('SELECT name AS label FROM t ORDER BY id').all()).toEqual([
        { label: 'alpha' },
        { label: 'beta' },
      ]);
    });

    it('never keeps a parameter from a previous run', async () => {
      const db = await open();
      const stmt = db.prepare('SELECT :a AS a, :b AS b');
      expect(stmt.get({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
      expect(stmt.get({ a: 3 })).toEqual({ a: 3, b: null });
    });

    it('stores integer-valued numbers as INTEGER and others as REAL', async () => {
      const db = await open();
      db.exec('CREATE TABLE v (x)');
      const insert = db.prepare('INSERT INTO v (x) VALUES (:x)');
      const values = [0, -1, 2 ** 31, 2 ** 40 + 7, Number.MAX_SAFE_INTEGER, 0.5, 1e-300, -2.25];
      for (const x of values) insert.run({ x });
      const rows = db
        .prepare('SELECT x, typeof(x) AS type FROM v ORDER BY rowid')
        .all<{ x: number; type: string }>();
      expect(rows.map((r) => r.x)).toEqual(values);
      expect(rows.map((r) => r.type)).toEqual([
        'integer',
        'integer',
        'integer',
        'integer',
        'integer',
        'real',
        'real',
        'real',
      ]);
      for (const r of rows) expect(typeof r.x).toBe('number');
    });

    it('round-trips TEXT, NULL, bigint and BLOB values', async () => {
      const db = await open();
      db.exec('CREATE TABLE v (t TEXT, z, big INTEGER, b BLOB)');
      const bytes = new Uint8Array([0, 1, 2, 250, 255]);
      const text = 'Café ✓ \u{1F600}\r\n';
      db.prepare('INSERT INTO v (t, z, big, b) VALUES (:t, :z, :big, :b)').run({
        t: text,
        z: null,
        big: 2n ** 60n + 1n,
        b: bytes,
      });
      const row = db.prepare('SELECT t, z, big, b FROM v').get<Record<string, unknown>>();
      expect(row?.t).toBe(text);
      expect(row?.z).toBe(null);
      // Beyond 2^53: a bigint, never a rounded number.
      expect(row?.big).toBe(2n ** 60n + 1n);
      const blob = row?.b as Uint8Array;
      expect(blob).toBeInstanceOf(Uint8Array);
      expect([...blob]).toEqual([...bytes]);
      // A copy the caller may keep: later reads don't change it.
      db.prepare('UPDATE v SET b = :b').run({ b: new Uint8Array([9, 9]) });
      db.prepare('SELECT b FROM v').get();
      expect([...blob]).toEqual([...bytes]);
      const small = db.prepare('SELECT :n AS n').get<{ n: unknown }>({ n: 5n });
      expect(small?.n).toBe(5);
    });

    it('commits on return and rolls back on a throw', async () => {
      const db = await open();
      db.exec('CREATE TABLE t (x INTEGER)');
      const insert = db.prepare('INSERT INTO t (x) VALUES (:x)');
      const count = () => db.prepare('SELECT count(*) AS n FROM t').get<{ n: number }>()?.n;
      expect(db.inTransaction).toBe(false);
      expect(
        db.transaction(() => {
          expect(db.inTransaction).toBe(true);
          insert.run({ x: 1 });
          return 'done';
        }),
      ).toBe('done');
      expect(db.inTransaction).toBe(false);
      expect(() =>
        db.transaction(() => {
          insert.run({ x: 2 });
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(db.inTransaction).toBe(false);
      expect(count()).toBe(1);
    });

    it('nests as savepoints: an inner rollback keeps the outer transaction', async () => {
      const db = await open();
      db.exec('CREATE TABLE t (x INTEGER)');
      const insert = db.prepare('INSERT INTO t (x) VALUES (:x)');
      db.transaction(() => {
        insert.run({ x: 1 });
        expect(() =>
          db.transaction(() => {
            insert.run({ x: 2 });
            db.transaction(() => insert.run({ x: 3 }));
            throw new Error('inner');
          }),
        ).toThrow('inner');
        expect(db.inTransaction).toBe(true);
        db.transaction(() => insert.run({ x: 4 }));
      });
      expect(db.prepare('SELECT x FROM t ORDER BY x').all()).toEqual([{ x: 1 }, { x: 4 }]);
    });

    it('joins a transaction opened with exec, which commits or rolls back as a whole', async () => {
      const db = await open();
      db.exec('CREATE TABLE t (x INTEGER)');
      const insert = db.prepare('INSERT INTO t (x) VALUES (:x)');
      db.exec('BEGIN IMMEDIATE');
      expect(db.inTransaction).toBe(true);
      db.transaction(() => insert.run({ x: 1 }));
      expect(db.inTransaction).toBe(true);
      db.exec('ROLLBACK');
      expect(db.inTransaction).toBe(false);
      db.exec('BEGIN IMMEDIATE');
      db.transaction(() => insert.run({ x: 2 }));
      db.exec('COMMIT');
      expect(db.prepare('SELECT x FROM t').all()).toEqual([{ x: 2 }]);
      db.exec('SAVEPOINT outer_sp');
      expect(db.inTransaction).toBe(true);
      db.exec('RELEASE outer_sp');
      expect(db.inTransaction).toBe(false);
    });

    it('refuses an async fn and rolls it back', async () => {
      const db = await open();
      db.exec('CREATE TABLE t (x INTEGER)');
      expect(() =>
        db.transaction(() => {
          db.prepare('INSERT INTO t (x) VALUES (1)').run();
          return Promise.resolve(1);
        }),
      ).toThrow(TypeError);
      expect(db.inTransaction).toBe(false);
      expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
    });

    it('keeps a statement usable after an error', async () => {
      const db = await open();
      db.exec('CREATE TABLE t (x INTEGER PRIMARY KEY)');
      const insert = db.prepare('INSERT INTO t (x) VALUES (:x)');
      insert.run({ x: 1 });
      expect(() => insert.run({ x: 1 })).toThrow();
      expect(insert.run({ x: 2 }).changes).toBe(1);
    });

    it('has WITHOUT ROWID tables', async () => {
      const db = await open();
      db.exec('CREATE TABLE w (a TEXT, b INTEGER, PRIMARY KEY (a, b)) WITHOUT ROWID');
      db.prepare('INSERT INTO w VALUES (:a, :b)').run({ a: 'k', b: 2 });
      expect(db.prepare('SELECT a, b FROM w').all()).toEqual([{ a: 'k', b: 2 }]);
    });

    it('keeps its data across a reopen', async () => {
      if (!harness.reopen) return;
      let db = await open();
      db.exec('CREATE TABLE t (x TEXT)');
      db.prepare('INSERT INTO t VALUES (:x)').run({ x: 'kept' });
      db.close();
      opened.pop();
      db = await harness.reopen(db);
      opened.push(db);
      expect(db.prepare('SELECT x FROM t').all()).toEqual([{ x: 'kept' }]);
    });
  });
}
