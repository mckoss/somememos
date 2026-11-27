// A `ContentStore` over the `content` table: a brain's note text, with each
// file's size, mtime and hash, so listing never reads text and the indexer
// never re-hashes an unchanged note. Original data: always on the pool.

import { storage } from '@somememos/core';
import type { BrainDb } from './db.js';
import { query } from './db.js';

interface ContentRow {
  path: string;
  size: number;
  mtime: number;
  hash: string;
}

const toEntry = (r: ContentRow): storage.ContentEntry => ({
  path: r.path,
  size: r.size,
  mtime: r.mtime,
  hash: r.hash,
});

const UNIQUE_VIOLATION = '23505';

export class PgContentStore implements storage.ContentStore {
  constructor(
    private readonly db: BrainDb,
    private readonly clock: () => number,
  ) {}

  async list(): Promise<storage.ContentEntry[]> {
    const { rows } = await this.db.original<ContentRow>(
      `SELECT path, size, mtime, hash FROM content WHERE brain_id = $1 ORDER BY path`,
      [this.db.brainId],
    );
    return rows.map(toEntry);
  }

  async stat(path: string): Promise<storage.ContentEntry | undefined> {
    const { rows } = await this.db.original<ContentRow>(
      `SELECT path, size, mtime, hash FROM content WHERE brain_id = $1 AND path = $2`,
      [this.db.brainId, path],
    );
    return rows[0] ? toEntry(rows[0]) : undefined;
  }

  async read(path: string): Promise<string | undefined> {
    const { rows } = await this.db.original<{ text: string }>(
      `SELECT text FROM content WHERE brain_id = $1 AND path = $2`,
      [this.db.brainId, path],
    );
    return rows[0]?.text;
  }

  async write(
    path: string,
    text: string,
    options?: storage.ContentWriteOptions,
  ): Promise<storage.ContentEntry> {
    if (typeof path !== 'string' || path === '') throw new RangeError('path must be non-empty');
    if (typeof text !== 'string') throw new TypeError('text must be a string');
    const entry: storage.ContentEntry = {
      path,
      size: storage.utf8Length(text),
      mtime: options?.mtime ?? this.clock(),
      hash: await storage.contentHash(text),
    };
    await this.db.original(
      `INSERT INTO content (brain_id, path, text, size, mtime, hash) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (brain_id, path) DO UPDATE SET text = excluded.text, size = excluded.size,
         mtime = excluded.mtime, hash = excluded.hash`,
      [this.db.brainId, path, text, entry.size, entry.mtime, entry.hash],
    );
    return entry;
  }

  async remove(path: string): Promise<boolean> {
    const r = await this.db.original(`DELETE FROM content WHERE brain_id = $1 AND path = $2`, [
      this.db.brainId,
      path,
    ]);
    return (r.rowCount ?? 0) > 0;
  }

  async rename(from: string, to: string): Promise<void> {
    const brainId = this.db.brainId;
    await this.db.originalAtomic(async (client) => {
      const source = await query(
        client,
        `SELECT 1 FROM content WHERE brain_id = $1 AND path = $2 FOR UPDATE`,
        [brainId, from],
      );
      if (source.rowCount === 0) throw new RangeError(`no such file: ${from}`);
      const target = await query(
        client,
        `SELECT 1 FROM content WHERE brain_id = $1 AND path = $2`,
        [brainId, to],
      );
      if ((target.rowCount ?? 0) > 0) throw new RangeError(`already exists: ${to}`);
      try {
        await query(client, `UPDATE content SET path = $3 WHERE brain_id = $1 AND path = $2`, [
          brainId,
          from,
          to,
        ]);
      } catch (error) {
        // A concurrent write created `to` after the check.
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new RangeError(`already exists: ${to}`, { cause: error });
        }
        throw error;
      }
    });
  }
}
