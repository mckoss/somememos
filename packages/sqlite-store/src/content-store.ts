// A `ContentStore` over a `content` table in the original-data database
// (PLAN.md section 6, "Web app": the browser keeps a full copy of the brain).
// Each row holds the text with its size, mtime and hash, so listing never
// reads text and the indexer never re-hashes an unchanged note.

import { storage } from '@somememos/core';
import type { Db } from './db.js';

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

export class SqliteContentStore implements storage.ContentStore {
  private readonly db: Db;
  private readonly clock: () => number;
  constructor(db: Db, clock: () => number) {
    this.db = db;
    this.clock = clock;
  }

  list(): storage.ContentEntry[] {
    return this.db
      .all<ContentRow>(`SELECT path, size, mtime, hash FROM content ORDER BY path`)
      .map(toEntry);
  }

  stat(path: string): storage.ContentEntry | undefined {
    const row = this.db.get<ContentRow>(
      `SELECT path, size, mtime, hash FROM content WHERE path = :path`,
      { path },
    );
    return row ? toEntry(row) : undefined;
  }

  read(path: string): string | undefined {
    return this.db.get<{ text: string }>(`SELECT text FROM content WHERE path = :path`, { path })
      ?.text;
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
    this.db.run(
      `INSERT INTO content (path, text, size, mtime, hash) VALUES (:path, :text, :size, :mtime, :hash)
       ON CONFLICT (path) DO UPDATE SET text = excluded.text, size = excluded.size,
         mtime = excluded.mtime, hash = excluded.hash`,
      { path, text, size: entry.size, mtime: entry.mtime, hash: entry.hash as string },
    );
    return entry;
  }

  remove(path: string): boolean {
    return this.db.run(`DELETE FROM content WHERE path = :path`, { path }).changes > 0;
  }

  rename(from: string, to: string): void {
    this.db.transaction(() => {
      if (!this.stat(from)) throw new RangeError(`no such file: ${from}`);
      if (this.stat(to)) throw new RangeError(`already exists: ${to}`);
      this.db.run(`UPDATE content SET path = :to WHERE path = :from`, { from, to });
    });
  }
}
