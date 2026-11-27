// The event log, change records and durable meta over `events.sqlite`.
// Synchronous: every method returns its value directly (the interfaces allow
// promises, so callers always `await`).

import { storage, type timescore } from '@somememos/core';
import type { Database } from '../sqlite/database.js';
import { atomic } from './schema.js';

type LogEntry = storage.LogEntry;

interface EventRow {
  seq: number;
  id: string;
  kind: string;
  item: string;
  time: number;
  client: string;
  target: string | null;
}

function toEntry(row: EventRow): LogEntry {
  return row.kind === 'rename'
    ? {
        seq: row.seq,
        id: row.id,
        kind: 'rename',
        item: row.item,
        to: row.target as string,
        time: row.time,
        client: row.client,
      }
    : {
        seq: row.seq,
        id: row.id,
        kind: row.kind as timescore.EventKind,
        item: row.item,
        time: row.time,
        client: row.client,
      };
}

const COLUMNS = 'seq, id, kind, item, time, client, target';

export class SqliteEventLog implements storage.EventLog {
  constructor(
    private readonly db: Database,
    private readonly clock: () => number,
  ) {}

  append(
    entries: readonly storage.LogInput[],
    options?: storage.AppendOptions,
  ): storage.AppendResult {
    const now = options?.now ?? this.clock();
    for (const entry of entries) storage.assertValidLogInput(entry, now);
    return atomic(this.db, () => {
      let appended = 0;
      const insert = this.db.prepare(
        `INSERT INTO events (id, kind, item, time, client, target)
         VALUES (:id, :kind, :item, :time, :client, :target)
         ON CONFLICT (id) DO NOTHING`,
      );
      for (const e of entries) {
        appended += insert.run({
          id: e.id,
          kind: e.kind,
          item: e.item,
          time: e.time,
          client: e.client,
          target: e.kind === 'rename' ? e.to : null,
        }).changes;
      }
      return { appended, duplicates: entries.length - appended };
    });
  }

  readAfter(cursor: number, options?: { readonly limit?: number }): LogEntry[] {
    const limit = options?.limit === undefined ? -1 : Math.max(0, Math.floor(options.limit));
    return this.db
      .all<EventRow>(
        `SELECT ${COLUMNS} FROM events WHERE seq > :cursor ORDER BY seq LIMIT :limit`,
        {
          cursor: Math.floor(cursor),
          limit,
        },
      )
      .map(toEntry);
  }

  renames(options?: { readonly throughSeq?: number }): storage.StoredRename[] {
    const through = options?.throughSeq ?? Number.MAX_SAFE_INTEGER;
    return this.db
      .all<EventRow>(
        `SELECT ${COLUMNS} FROM events WHERE kind = 'rename' AND seq <= :through ORDER BY seq`,
        { through: Math.floor(through) },
      )
      .map(toEntry) as storage.StoredRename[];
  }

  lastSeq(): number {
    return this.db.get<{ seq: number | null }>(`SELECT max(seq) AS seq FROM events`)?.seq ?? 0;
  }

  countByKind(): Record<storage.LogKind, number> {
    const counts: Record<storage.LogKind, number> = { read: 0, edit: 0, mention: 0, rename: 0 };
    for (const row of this.db.all<{ kind: storage.LogKind; n: number }>(
      `SELECT kind, count(*) AS n FROM events GROUP BY kind`,
    )) {
      counts[row.kind] = row.n;
    }
    return counts;
  }

  appendChanges(
    changes: readonly storage.ChangeInput[],
    options?: storage.AppendOptions,
  ): storage.AppendResult {
    const now = options?.now ?? this.clock();
    for (const change of changes) storage.assertValidChangeInput(change, now);
    return atomic(this.db, () => {
      let appended = 0;
      for (const c of changes) {
        const result = this.db.run(
          `INSERT INTO changes (id, time, client, message, op)
           VALUES (:id, :time, :client, :message, :op)
           ON CONFLICT (id) DO NOTHING`,
          { id: c.id, time: c.time, client: c.client, message: c.message, op: c.op },
        );
        if (result.changes === 0) continue;
        appended++;
        for (const path of storage.normalizeChangePaths(c.paths)) {
          this.db.run(`INSERT INTO change_paths (change_seq, path) VALUES (:seq, :path)`, {
            seq: result.lastInsertRowid,
            path,
          });
        }
      }
      return { appended, duplicates: changes.length - appended };
    });
  }

  changes(filter: storage.ChangeFilter = {}): storage.ChangeRecord[] {
    const where: string[] = [];
    const params: Record<string, string | number> = {};
    if (filter.path !== undefined) {
      where.push(
        `EXISTS (SELECT 1 FROM change_paths p WHERE p.change_seq = c.seq AND p.path = :path)`,
      );
      params.path = filter.path;
    }
    if (filter.op !== undefined) {
      where.push(`c.op = :op`);
      params.op = filter.op;
    }
    if (filter.since !== undefined) {
      where.push(`c.time >= :since`);
      params.since = filter.since;
    }
    if (filter.until !== undefined) {
      where.push(`c.time < :until`);
      params.until = filter.until;
    }
    params.limit = filter.limit === undefined ? -1 : Math.max(0, Math.floor(filter.limit));
    const rows = this.db.all<{
      seq: number;
      id: string;
      time: number;
      client: string;
      message: string | null;
      op: string | null;
    }>(
      `SELECT c.seq, c.id, c.time, c.client, c.message, c.op FROM changes c
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY c.time DESC, c.seq DESC LIMIT :limit`,
      params,
    );
    const pathsOf = this.db.prepare(
      `SELECT path FROM change_paths WHERE change_seq = :seq ORDER BY path`,
    );
    return rows.map((r) => ({
      seq: r.seq,
      id: r.id,
      time: r.time,
      client: r.client,
      message: r.message,
      op: r.op,
      paths: storage.normalizeChangePaths(
        pathsOf.all<{ path: string }>({ seq: r.seq }).map((p) => p.path),
      ),
    }));
  }
}

/** A `user_meta` table as a `MetaStore`. */
export class SqliteMeta implements storage.MetaStore {
  constructor(private readonly db: Database) {}

  get(key: string): string | undefined {
    return this.db.get<{ value: string }>(`SELECT value FROM user_meta WHERE key = :key`, { key })
      ?.value;
  }

  set(key: string, value: string): void {
    if (typeof value !== 'string') throw new TypeError('meta values must be strings');
    this.db.run(
      `INSERT INTO user_meta (key, value) VALUES (:key, :value)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      { key, value },
    );
  }

  delete(key: string): void {
    this.db.run(`DELETE FROM user_meta WHERE key = :key`, { key });
  }
}
