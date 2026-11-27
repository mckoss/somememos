// The event log, change records and durable meta of one brain.
//
// Sequence numbers. A brain's `seq` is 1, 2, 3, … with no gaps, and a reader
// at cursor N never misses an entry that commits later with seq <= N. An
// append takes the brain's row in `brains` FOR UPDATE first, assigns the next
// numbers from its `event_seq` counter, inserts, bumps the counter and
// commits; the row lock is held until the commit. A second appender to the
// same brain waits on that lock, then reads the committed counter, so its
// numbers are all higher and it commits after the first: seqs become visible
// in order. (A Postgres sequence or identity column would not do: numbers are
// taken at insert time, and a transaction holding a lower one can commit
// after one holding a higher one, which a cursor reader would skip past.)
// Appends to different brains never wait for each other. Duplicate ids are
// checked under the same lock, so the check is exact. The lock is FOR NO KEY
// UPDATE, which does not conflict with the KEY SHARE locks that inserting a
// row referencing `brains` takes: a pending index transaction (which has
// inserted notes or sections) must not block an append made while it runs.

import { storage, timescore } from '@somememos/core';
import { type BrainDb, type Queryable, query } from './db.js';

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

/** `limit` as SQL: NULL is no limit. */
function sqlLimit(limit: number | undefined): number | null {
  return limit === undefined ? null : Math.max(0, Math.floor(limit));
}

/** Locks the brain's row and returns its counters. */
async function lockBrain(
  q: Queryable,
  brainId: string,
): Promise<{ event_seq: number; change_seq: number }> {
  const { rows } = await query<{ event_seq: number; change_seq: number }>(
    q,
    `SELECT event_seq, change_seq FROM brains WHERE brain_id = $1 FOR NO KEY UPDATE`,
    [brainId],
  );
  if (!rows[0]) throw new Error(`no such brain: ${brainId}`);
  return rows[0];
}

/** The ids of `entries` not yet seen, first copy of each, in order. */
function firstCopies<T extends { readonly id: string }>(entries: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of entries) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

async function existingIds(
  q: Queryable,
  table: 'events' | 'changes',
  brainId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  const { rows } = await query<{ id: string }>(
    q,
    `SELECT id FROM ${table} WHERE brain_id = $1 AND id = ANY($2::text[])`,
    [brainId, ids],
  );
  return new Set(rows.map((r) => r.id));
}

export class PgEventLog implements storage.EventLog {
  private readonly db: BrainDb;
  private readonly clock: () => number;
  constructor(db: BrainDb, clock: () => number) {
    this.db = db;
    this.clock = clock;
  }

  async append(
    entries: readonly storage.LogInput[],
    options?: storage.AppendOptions,
  ): Promise<storage.AppendResult> {
    const now = options?.now ?? this.clock();
    for (const entry of entries) storage.assertValidLogInput(entry, now);
    const candidates = firstCopies(entries);
    const brainId = this.db.brainId;
    if (candidates.length === 0) return { appended: 0, duplicates: entries.length };
    return this.db.originalAtomic(async (client) => {
      const { event_seq: last } = await lockBrain(client, brainId);
      const known = await existingIds(
        client,
        'events',
        brainId,
        candidates.map((e) => e.id),
      );
      const fresh = candidates.filter((e) => !known.has(e.id));
      if (fresh.length > 0) {
        await query(
          client,
          `INSERT INTO events (brain_id, seq, id, kind, item, time, client, target)
           SELECT $1, u.* FROM unnest($2::int8[], $3::text[], $4::text[], $5::text[],
                                      $6::int8[], $7::text[], $8::text[])
             AS u(seq, id, kind, item, time, client, target)`,
          [
            brainId,
            fresh.map((_, i) => last + 1 + i),
            fresh.map((e) => e.id),
            fresh.map((e) => e.kind),
            fresh.map((e) => e.item),
            fresh.map((e) => e.time),
            fresh.map((e) => e.client),
            fresh.map((e) => (e.kind === 'rename' ? e.to : null)),
          ],
        );
        await query(client, `UPDATE brains SET event_seq = $2 WHERE brain_id = $1`, [
          brainId,
          last + fresh.length,
        ]);
      }
      return { appended: fresh.length, duplicates: entries.length - fresh.length };
    });
  }

  async readAfter(cursor: number, options?: { readonly limit?: number }): Promise<LogEntry[]> {
    const { rows } = await this.db.original<EventRow>(
      `SELECT ${COLUMNS} FROM events WHERE brain_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [this.db.brainId, Math.floor(cursor), sqlLimit(options?.limit)],
    );
    return rows.map(toEntry);
  }

  async renames(options?: { readonly throughSeq?: number }): Promise<storage.StoredRename[]> {
    const through = options?.throughSeq ?? Number.MAX_SAFE_INTEGER;
    const { rows } = await this.db.original<EventRow>(
      `SELECT ${COLUMNS} FROM events WHERE brain_id = $1 AND kind = 'rename' AND seq <= $2
       ORDER BY seq`,
      [this.db.brainId, Math.floor(through)],
    );
    return rows.map(toEntry) as storage.StoredRename[];
  }

  async lastSeq(): Promise<number> {
    const { rows } = await this.db.original<{ seq: number | null }>(
      `SELECT max(seq) AS seq FROM events WHERE brain_id = $1`,
      [this.db.brainId],
    );
    return rows[0]?.seq ?? 0;
  }

  async countByKind(): Promise<Record<storage.LogKind, number>> {
    const counts = { rename: 0 } as Record<storage.LogKind, number>;
    for (const kind of timescore.EVENT_KINDS) counts[kind] = 0;
    const { rows } = await this.db.original<{ kind: storage.LogKind; n: number }>(
      `SELECT kind, count(*) AS n FROM events WHERE brain_id = $1 GROUP BY kind`,
      [this.db.brainId],
    );
    for (const row of rows) counts[row.kind] = row.n;
    return counts;
  }

  async appendChanges(
    changes: readonly storage.ChangeInput[],
    options?: storage.AppendOptions,
  ): Promise<storage.AppendResult> {
    const now = options?.now ?? this.clock();
    for (const change of changes) storage.assertValidChangeInput(change, now);
    const candidates = firstCopies(changes);
    const brainId = this.db.brainId;
    if (candidates.length === 0) return { appended: 0, duplicates: changes.length };
    return this.db.originalAtomic(async (client) => {
      const { change_seq: last } = await lockBrain(client, brainId);
      const known = await existingIds(
        client,
        'changes',
        brainId,
        candidates.map((c) => c.id),
      );
      const fresh = candidates.filter((c) => !known.has(c.id));
      if (fresh.length > 0) {
        const seqs = fresh.map((_, i) => last + 1 + i);
        await query(
          client,
          `INSERT INTO changes (brain_id, seq, id, time, client, message, op)
           SELECT $1, u.* FROM unnest($2::int8[], $3::text[], $4::int8[], $5::text[],
                                      $6::text[], $7::text[])
             AS u(seq, id, time, client, message, op)`,
          [
            brainId,
            seqs,
            fresh.map((c) => c.id),
            fresh.map((c) => c.time),
            fresh.map((c) => c.client),
            fresh.map((c) => c.message),
            fresh.map((c) => c.op),
          ],
        );
        const pathSeqs: number[] = [];
        const paths: string[] = [];
        fresh.forEach((c, i) => {
          for (const path of storage.normalizeChangePaths(c.paths)) {
            pathSeqs.push(seqs[i] as number);
            paths.push(path);
          }
        });
        if (paths.length > 0) {
          await query(
            client,
            `INSERT INTO change_paths (brain_id, change_seq, path)
             SELECT $1, u.* FROM unnest($2::int8[], $3::text[]) AS u(change_seq, path)`,
            [brainId, pathSeqs, paths],
          );
        }
        await query(client, `UPDATE brains SET change_seq = $2 WHERE brain_id = $1`, [
          brainId,
          last + fresh.length,
        ]);
      }
      return { appended: fresh.length, duplicates: changes.length - fresh.length };
    });
  }

  async changes(filter: storage.ChangeFilter = {}): Promise<storage.ChangeRecord[]> {
    const params: unknown[] = [this.db.brainId];
    const where: string[] = ['c.brain_id = $1'];
    const param = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (filter.path !== undefined) {
      where.push(
        `EXISTS (SELECT 1 FROM change_paths p
                 WHERE p.brain_id = c.brain_id AND p.change_seq = c.seq AND p.path = ${param(filter.path)})`,
      );
    }
    if (filter.op !== undefined) where.push(`c.op = ${param(filter.op)}`);
    if (filter.since !== undefined) where.push(`c.time >= ${param(filter.since)}`);
    if (filter.until !== undefined) where.push(`c.time < ${param(filter.until)}`);
    const limit = param(sqlLimit(filter.limit));
    const { rows } = await this.db.original<{
      seq: number;
      id: string;
      time: number;
      client: string;
      message: string | null;
      op: string | null;
    }>(
      `SELECT c.seq, c.id, c.time, c.client, c.message, c.op FROM changes c
       WHERE ${where.join(' AND ')}
       ORDER BY c.time DESC, c.seq DESC LIMIT ${limit}`,
      params,
    );
    if (rows.length === 0) return [];
    const { rows: pathRows } = await this.db.original<{ change_seq: number; path: string }>(
      `SELECT change_seq, path FROM change_paths WHERE brain_id = $1 AND change_seq = ANY($2::int8[])`,
      [this.db.brainId, rows.map((r) => r.seq)],
    );
    const pathsOf = new Map<number, string[]>();
    for (const p of pathRows) {
      let list = pathsOf.get(p.change_seq);
      if (!list) pathsOf.set(p.change_seq, (list = []));
      list.push(p.path);
    }
    return rows.map((r) => ({
      seq: r.seq,
      id: r.id,
      time: r.time,
      client: r.client,
      message: r.message,
      op: r.op,
      paths: storage.normalizeChangePaths(pathsOf.get(r.seq) ?? []),
    }));
  }
}

/** A per-brain key-value table as a `MetaStore`: durable (`brain_meta`) or derived (`index_meta`). */
export class PgMeta implements storage.MetaStore {
  private readonly db: BrainDb;
  private readonly table: 'brain_meta' | 'index_meta';
  constructor(db: BrainDb, table: 'brain_meta' | 'index_meta') {
    this.db = db;
    this.table = table;
  }

  private run<R extends Record<string, unknown>>(text: string, values: unknown[]) {
    return this.table === 'brain_meta'
      ? this.db.original<R>(text, values)
      : this.db.derived<R>(text, values);
  }

  async get(key: string): Promise<string | undefined> {
    const { rows } = await this.run<{ value: string }>(
      `SELECT value FROM ${this.table} WHERE brain_id = $1 AND key = $2`,
      [this.db.brainId, key],
    );
    return rows[0]?.value;
  }

  async set(key: string, value: string): Promise<void> {
    if (typeof value !== 'string') throw new TypeError('meta values must be strings');
    await this.run(
      `INSERT INTO ${this.table} (brain_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (brain_id, key) DO UPDATE SET value = excluded.value`,
      [this.db.brainId, key, value],
    );
  }

  async delete(key: string): Promise<void> {
    await this.run(`DELETE FROM ${this.table} WHERE brain_id = $1 AND key = $2`, [
      this.db.brainId,
      key,
    ]);
  }
}
