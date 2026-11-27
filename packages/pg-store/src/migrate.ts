// Applies the schema's migrations (./schema.ts). Safe when several server
// processes start at once: the runner holds a session advisory lock while it
// reads `schema_migrations` and applies what is missing, each migration in a
// transaction of its own, so each is applied exactly once.

import { storage } from '@somememos/core';
import type pg from 'pg';
import { query } from './db.js';
import { MIGRATIONS, type Migration } from './schema.js';

/** The advisory lock key the runner holds (an arbitrary constant: "somememo" in ASCII). */
export const MIGRATION_LOCK_KEY = 0x736f6d656d656d6fn;

export interface MigrateResult {
  /** Versions applied by this call, in order. */
  readonly applied: number[];
  /** The schema version afterwards. */
  readonly version: number;
}

/**
 * Brings the database's somememos tables up to date. Throws
 * `storage.MigrationRequiredError`, changing nothing, when the database has
 * a migration this code does not know (a newer somememos ran against it).
 */
export async function migrate(
  pool: pg.Pool,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<MigrateResult> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           version    integer PRIMARY KEY,
           name       text NOT NULL,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      const done = new Set(
        (
          await query<{ version: number }>(client, `SELECT version FROM schema_migrations`)
        ).rows.map((r) => r.version),
      );
      const known = new Set(migrations.map((m) => m.version));
      const unknown = [...done].filter((v) => !known.has(v)).sort((a, b) => a - b);
      if (unknown.length > 0) {
        throw new storage.MigrationRequiredError(
          `the database has somememos schema migration ${unknown.join(', ')}, which this version does not know. ` +
            `Upgrade somememos; nothing was changed.`,
        );
      }
      const applied: number[] = [];
      for (const m of migrations) {
        if (done.has(m.version)) continue;
        await client.query('BEGIN');
        try {
          await client.query(m.sql);
          await client.query(`INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`, [
            m.version,
            m.name,
          ]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
        applied.push(m.version);
      }
      return { applied, version: Math.max(0, ...migrations.map((m) => m.version)) };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()]);
    }
  } finally {
    client.release();
  }
}

const migrated = new WeakMap<pg.Pool, Promise<MigrateResult>>();

/** `migrate(pool)`, once per pool (a failed attempt is retried on the next call). */
export function ensureMigrated(pool: pg.Pool): Promise<MigrateResult> {
  let pending = migrated.get(pool);
  if (!pending) {
    pending = migrate(pool);
    migrated.set(pool, pending);
    pending.catch(() => migrated.delete(pool));
  }
  return pending;
}
