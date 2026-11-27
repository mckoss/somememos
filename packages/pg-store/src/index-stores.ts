// The derived stores of one brain: scores and the fold cursor, notes and
// links, and the term index. Every statement goes through `BrainDb.derived`,
// so inside `Stores.indexTransaction` it runs on that transaction's
// connection.

import { keyword, storage, timescore } from '@somememos/core';
import { type BrainDb, type Queryable, query } from './db.js';

const { compareStrings } = storage;

// ---------------------------------------------------------------------------
// Scores

interface ScoreRow {
  item: string;
  kind: timescore.EventKind;
  half_life: string;
  log_score: number;
}

function addRow(out: timescore.ItemScores<string>, row: ScoreRow): void {
  (out[row.half_life] ??= {})[row.kind] = row.log_score;
}

/** Kinds in canonical order, as the memory store returns them. */
function ordered(scores: timescore.ItemScores<string>): timescore.ItemScores<string> {
  const out: timescore.ItemScores<string> = {};
  for (const hl of Object.keys(scores)) {
    const byKind = scores[hl] as timescore.ScoresByKind;
    const o: timescore.ScoresByKind = {};
    for (const k of timescore.EVENT_KINDS) if (byKind[k] !== undefined) o[k] = byKind[k];
    out[hl] = o;
  }
  return out;
}

interface IndexStateRow {
  fold_cursor: number;
  half_lives: string | null;
  burst_window: number | null;
}

/** Locks the brain's `index_state` row (the fold cursor) until the transaction ends. */
async function lockIndexState(q: Queryable, brainId: string): Promise<IndexStateRow> {
  const { rows } = await query<IndexStateRow>(
    q,
    `SELECT fold_cursor, half_lives, burst_window FROM index_state WHERE brain_id = $1 FOR UPDATE`,
    [brainId],
  );
  if (!rows[0]) throw new Error(`no such brain: ${brainId}`);
  return rows[0];
}

const SCORE_KEY_SEPARATOR = '\0';

/**
 * Applies a batch's `last` ops and the burst state half of its `move` ops,
 * in op order, to the current state of the items they touch, and writes
 * those items' state back. Runs inside `applyFold`'s transaction.
 */
async function applyBurstOps(
  q: Queryable,
  brainId: string,
  items: string[],
  ops: readonly storage.ScoreOp[],
): Promise<void> {
  // item -> kind -> last counted time
  const current = new Map<string, Map<string, number>>();
  for (const item of items) current.set(item, new Map());
  const { rows } = await query<{ item: string; kind: string; time: number }>(
    q,
    `SELECT item, kind, time FROM burst_last WHERE brain_id = $1 AND item = ANY($2::text[])`,
    [brainId, items],
  );
  for (const r of rows) (current.get(r.item) as Map<string, number>).set(r.kind, Number(r.time));
  const put = (item: string, kind: string, time: number): void => {
    const state = current.get(item) as Map<string, number>;
    state.set(kind, Math.max(state.get(kind) ?? -Infinity, time));
  };
  for (const op of ops) {
    if (op.type === 'last') put(op.item, op.kind, op.time);
    else if (op.type === 'move' && op.from !== op.to) {
      const from = current.get(op.from) as Map<string, number>;
      for (const [kind, time] of from) put(op.to, kind, time);
      from.clear();
    }
  }
  const outItems: string[] = [];
  const outKinds: string[] = [];
  const outTimes: number[] = [];
  for (const [item, state] of current) {
    for (const [kind, time] of state) {
      outItems.push(item);
      outKinds.push(kind);
      outTimes.push(time);
    }
  }
  await query(q, `DELETE FROM burst_last WHERE brain_id = $1 AND item = ANY($2::text[])`, [
    brainId,
    items,
  ]);
  if (outItems.length > 0) {
    await query(
      q,
      `INSERT INTO burst_last (brain_id, item, kind, time)
       SELECT $1, u.* FROM unnest($2::text[], $3::text[], $4::bigint[]) AS u(item, kind, time)`,
      [brainId, outItems, outKinds, outTimes],
    );
  }
}

export class PgScoreStore implements storage.ScoreStore {
  private readonly db: BrainDb;
  constructor(db: BrainDb) {
    this.db = db;
  }

  async foldState(): Promise<storage.FoldState> {
    const { rows } = await this.db.derived<IndexStateRow>(
      `SELECT fold_cursor, half_lives, burst_window FROM index_state WHERE brain_id = $1`,
      [this.db.brainId],
    );
    const row = rows[0];
    const cursor = row?.fold_cursor ?? 0;
    const halfLives =
      row?.half_lives === null || row?.half_lives === undefined
        ? null
        : (JSON.parse(row.half_lives) as storage.HalfLives);
    const window = halfLives === null ? 0 : (row?.burst_window ?? 0);
    return window > 0 ? { cursor, halfLives, burstWindow: window } : { cursor, halfLives };
  }

  async burstState(items: readonly string[]): Promise<storage.BurstState> {
    const out: storage.BurstState = new Map();
    const wanted = [...new Set(items)];
    if (wanted.length === 0) return out;
    const { rows } = await this.db.derived<{
      item: string;
      kind: timescore.EventKind;
      time: number;
    }>(`SELECT item, kind, time FROM burst_last WHERE brain_id = $1 AND item = ANY($2::text[])`, [
      this.db.brainId,
      wanted,
    ]);
    const byItem = new Map<string, Partial<Record<timescore.EventKind, number>>>();
    for (const r of rows) {
      let kinds = byItem.get(r.item);
      if (!kinds) byItem.set(r.item, (kinds = {}));
      kinds[r.kind] = Number(r.time);
    }
    for (const item of wanted) {
      const kinds = byItem.get(item);
      if (!kinds) continue;
      const ordered: Partial<Record<timescore.EventKind, number>> = {};
      for (const k of timescore.EVENT_KINDS) if (kinds[k] !== undefined) ordered[k] = kinds[k];
      out.set(item, ordered);
    }
    return out;
  }

  async getItem(item: string): Promise<timescore.ItemScores<string> | undefined> {
    const { rows } = await this.db.derived<ScoreRow>(
      `SELECT item, kind, half_life, log_score FROM scores WHERE brain_id = $1 AND item = $2
       ORDER BY half_life, kind`,
      [this.db.brainId, item],
    );
    if (rows.length === 0) return undefined;
    const out: timescore.ItemScores<string> = {};
    for (const row of rows) addRow(out, row);
    return ordered(out);
  }

  async getAll(): Promise<Map<string, timescore.ItemScores<string>>> {
    const { rows } = await this.db.derived<ScoreRow>(
      `SELECT item, kind, half_life, log_score FROM scores WHERE brain_id = $1
       ORDER BY item, half_life, kind`,
      [this.db.brainId],
    );
    const byItem = new Map<string, timescore.ItemScores<string>>();
    for (const row of rows) {
      let scores = byItem.get(row.item);
      if (!scores) byItem.set(row.item, (scores = {}));
      addRow(scores, row);
    }
    const out = new Map<string, timescore.ItemScores<string>>();
    for (const item of [...byItem.keys()].sort(compareStrings)) {
      out.set(item, ordered(byItem.get(item) as timescore.ItemScores<string>));
    }
    return out;
  }

  /**
   * Locks the fold state, checks the cursor and half-lives, then applies the
   * ops in application code (`timescore.combine`, in op order, exactly as
   * the SQLite and memory stores do) to the current scores of the items they
   * touch, and writes those items' scores back with the new cursor, all in
   * one transaction. A concurrent folder waits on the lock and then sees the
   * new cursor, so it gets `FoldConflictError`.
   */
  async applyFold(batch: storage.FoldBatch): Promise<void> {
    storage.assertValidHalfLives(batch.halfLives);
    if (!Number.isSafeInteger(batch.toCursor) || batch.toCursor < batch.fromCursor) {
      throw new RangeError(`toCursor must be an integer >= fromCursor, not ${batch.toCursor}`);
    }
    const brainId = this.db.brainId;
    await this.db.derivedAtomic(async (q) => {
      const state = await lockIndexState(q, brainId);
      if (state.fold_cursor !== batch.fromCursor) {
        throw new storage.FoldConflictError(batch.fromCursor, state.fold_cursor);
      }
      const stored =
        state.half_lives === null ? null : (JSON.parse(state.half_lives) as storage.HalfLives);
      if (stored && !storage.sameHalfLives(stored, batch.halfLives)) {
        throw new storage.HalfLifeMismatchError(stored, batch.halfLives);
      }
      const window = batch.burstWindow ?? 0;
      storage.assertValidBurstWindow(window);
      const storedWindow = state.burst_window ?? 0;
      if (stored && storedWindow !== window) {
        throw new storage.BurstWindowMismatchError(storedWindow, window);
      }
      // Every check that can throw runs before the first write.
      const touched = new Set<string>();
      const burstTouched = new Set<string>();
      for (const op of batch.ops) {
        storage.assertValidScoreOp(op, batch.halfLives);
        if (op.type === 'add') touched.add(op.item);
        else if (op.type === 'last') burstTouched.add(op.item);
        else if (op.from !== op.to) {
          touched.add(op.from).add(op.to);
          burstTouched.add(op.from).add(op.to);
        }
      }

      if (touched.size > 0) {
        const items = [...touched];
        // item -> "kind\0halfLife" -> log score
        const current = new Map<string, Map<string, number>>();
        for (const item of items) current.set(item, new Map());
        const { rows } = await query<ScoreRow>(
          q,
          `SELECT item, kind, half_life, log_score FROM scores
           WHERE brain_id = $1 AND item = ANY($2::text[])`,
          [brainId, items],
        );
        for (const r of rows) {
          (current.get(r.item) as Map<string, number>).set(
            `${r.kind}${SCORE_KEY_SEPARATOR}${r.half_life}`,
            r.log_score,
          );
        }
        const add = (item: string, key: string, score: number): void => {
          const scores = current.get(item) as Map<string, number>;
          const was = scores.get(key);
          scores.set(key, was === undefined ? score : timescore.combine(was, score));
        };
        for (const op of batch.ops) {
          if (op.type === 'add') {
            add(op.item, `${op.kind}${SCORE_KEY_SEPARATOR}${op.halfLife}`, op.logScore);
          } else if (op.type === 'last') {
            continue;
          } else if (op.from !== op.to) {
            const from = current.get(op.from) as Map<string, number>;
            for (const [key, score] of from) add(op.to, key, score);
            from.clear();
          }
        }

        const outItems: string[] = [];
        const outKinds: string[] = [];
        const outHalfLives: string[] = [];
        const outScores: number[] = [];
        for (const [item, scores] of current) {
          for (const [key, score] of scores) {
            const [kind, halfLife] = key.split(SCORE_KEY_SEPARATOR) as [string, string];
            outItems.push(item);
            outKinds.push(kind);
            outHalfLives.push(halfLife);
            outScores.push(score);
          }
        }
        await query(q, `DELETE FROM scores WHERE brain_id = $1 AND item = ANY($2::text[])`, [
          brainId,
          items,
        ]);
        if (outItems.length > 0) {
          await query(
            q,
            `INSERT INTO scores (brain_id, item, kind, half_life, log_score)
             SELECT $1, u.* FROM unnest($2::text[], $3::text[], $4::text[], $5::float8[])
               AS u(item, kind, half_life, log_score)`,
            [brainId, outItems, outKinds, outHalfLives, outScores],
          );
        }
      }
      if (burstTouched.size > 0) await applyBurstOps(q, brainId, [...burstTouched], batch.ops);
      await query(
        q,
        `UPDATE index_state SET fold_cursor = $2, half_lives = $3, burst_window = $4
         WHERE brain_id = $1`,
        [
          brainId,
          batch.toCursor,
          storage.halfLivesToJson(batch.halfLives),
          window > 0 ? window : null,
        ],
      );
    });
  }

  async clear(): Promise<void> {
    const brainId = this.db.brainId;
    await this.db.derivedAtomic(async (q) => {
      await lockIndexState(q, brainId);
      await query(q, `DELETE FROM scores WHERE brain_id = $1`, [brainId]);
      await query(q, `DELETE FROM burst_last WHERE brain_id = $1`, [brainId]);
      await query(
        q,
        `UPDATE index_state SET fold_cursor = 0, half_lives = NULL, burst_window = NULL
         WHERE brain_id = $1`,
        [brainId],
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Notes and links

interface NoteRow {
  path: string;
  title: string;
  content_hash: string;
  mtime: number;
  role: storage.NoteRole;
  date: string | null;
}

function toNote(row: NoteRow): storage.NoteRecord {
  return {
    path: row.path,
    title: row.title,
    contentHash: row.content_hash,
    mtime: row.mtime,
    role: row.role,
    date: row.date,
  };
}

const NOTE_COLUMNS = 'path, title, content_hash, mtime, role, date';

export class PgNoteStore implements storage.NoteStore {
  private readonly db: BrainDb;
  constructor(db: BrainDb) {
    this.db = db;
  }

  async upsertNote(note: storage.NoteRecord): Promise<void> {
    storage.assertValidNote(note);
    await this.db.derived(
      `INSERT INTO notes (brain_id, ${NOTE_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (brain_id, path) DO UPDATE SET title = excluded.title,
         content_hash = excluded.content_hash, mtime = excluded.mtime,
         role = excluded.role, date = excluded.date`,
      [this.db.brainId, note.path, note.title, note.contentHash, note.mtime, note.role, note.date],
    );
  }

  async removeNote(path: string): Promise<boolean> {
    const brainId = this.db.brainId;
    return this.db.derivedAtomic(async (q) => {
      await query(q, `DELETE FROM links WHERE brain_id = $1 AND source = $2`, [brainId, path]);
      const r = await query(q, `DELETE FROM notes WHERE brain_id = $1 AND path = $2`, [
        brainId,
        path,
      ]);
      return (r.rowCount ?? 0) > 0;
    });
  }

  async getNote(path: string): Promise<storage.NoteRecord | undefined> {
    const { rows } = await this.db.derived<NoteRow>(
      `SELECT ${NOTE_COLUMNS} FROM notes WHERE brain_id = $1 AND path = $2`,
      [this.db.brainId, path],
    );
    return rows[0] ? toNote(rows[0]) : undefined;
  }

  async listNotes(filter?: { readonly role?: storage.NoteRole }): Promise<storage.NoteRecord[]> {
    const { rows } =
      filter?.role === undefined
        ? await this.db.derived<NoteRow>(`SELECT ${NOTE_COLUMNS} FROM notes WHERE brain_id = $1`, [
            this.db.brainId,
          ])
        : await this.db.derived<NoteRow>(
            `SELECT ${NOTE_COLUMNS} FROM notes WHERE brain_id = $1 AND role = $2`,
            [this.db.brainId, filter.role],
          );
    return rows.map(toNote).sort((a, b) => compareStrings(a.path, b.path));
  }

  async replaceLinks(source: string, links: readonly storage.NoteLink[]): Promise<void> {
    const byTarget = new Map<string, { dangling: boolean; display: string | null }>();
    for (const link of links) {
      if (typeof link.target !== 'string' || link.target === '') {
        throw new RangeError('link target must be a non-empty string');
      }
      byTarget.set(link.target, {
        dangling: Boolean(link.dangling),
        display: storage.linkDisplay(link) ?? null,
      });
    }
    const brainId = this.db.brainId;
    await this.db.derivedAtomic(async (q) => {
      await query(q, `DELETE FROM links WHERE brain_id = $1 AND source = $2`, [brainId, source]);
      if (byTarget.size === 0) return;
      const values = [...byTarget.values()];
      await query(
        q,
        `INSERT INTO links (brain_id, source, target, dangling, display)
         SELECT $1, $2, u.* FROM unnest($3::text[], $4::bool[], $5::text[])
           AS u(target, dangling, display)`,
        [
          brainId,
          source,
          [...byTarget.keys()],
          values.map((v) => v.dangling),
          values.map((v) => v.display),
        ],
      );
    });
  }

  async linksFrom(source: string): Promise<storage.NoteLink[]> {
    const { rows } = await this.db.derived<{
      target: string;
      dangling: boolean;
      display: string | null;
    }>(`SELECT target, dangling, display FROM links WHERE brain_id = $1 AND source = $2`, [
      this.db.brainId,
      source,
    ]);
    return rows
      .map((r) =>
        r.display === null
          ? { target: r.target, dangling: r.dangling }
          : { target: r.target, dangling: r.dangling, display: r.display },
      )
      .sort((a, b) => compareStrings(a.target, b.target));
  }

  async backlinks(target: string): Promise<string[]> {
    const { rows } = await this.db.derived<{ source: string }>(
      `SELECT source FROM links WHERE brain_id = $1 AND target = $2`,
      [this.db.brainId, target],
    );
    return rows.map((r) => r.source).sort(compareStrings);
  }

  async danglingTargets(): Promise<storage.DanglingCount[]> {
    const { rows } = await this.db.derived<{ key: string; display: string | null }>(
      `SELECT target AS key, display FROM links WHERE brain_id = $1 AND dangling`,
      [this.db.brainId],
    );
    return storage.danglingCounts(rows);
  }
}

// ---------------------------------------------------------------------------
// Term index

interface SectionRow {
  path: string;
  idx: number;
  title: string;
  heading: string | null;
  body: string;
  start_line: number;
  end_line: number;
  title_len: number;
  heading_len: number;
  body_len: number;
}

function toSection(row: SectionRow): storage.StoredSection {
  return {
    id: storage.sectionId(row.path, row.idx),
    path: row.path,
    index: row.idx,
    title: row.title,
    heading: row.heading,
    body: row.body,
    startLine: row.start_line,
    endLine: row.end_line,
    lengths: { title: row.title_len, heading: row.heading_len, body: row.body_len },
  };
}

const SECTION_COLUMNS =
  'path, idx, title, heading, body, start_line, end_line, title_len, heading_len, body_len';

/**
 * Inserts a note's sections and all their postings in one statement: the
 * sections' generated ids come back from a data-modifying CTE and are joined
 * to the postings by section index.
 */
const INSERT_SECTIONS_AND_POSTINGS = `
WITH s AS (
  INSERT INTO sections (brain_id, ${SECTION_COLUMNS})
  SELECT $1, $2, u.idx, $3, u.heading, u.body, u.start_line, u.end_line, u.tl, u.hl, u.bl
  FROM unnest($4::int4[], $5::text[], $6::text[], $7::int4[], $8::int4[],
              $9::int4[], $10::int4[], $11::int4[])
    AS u(idx, heading, body, start_line, end_line, tl, hl, bl)
  RETURNING id, idx
)
INSERT INTO postings (brain_id, term, section, title_tf, heading_tf, body_tf, positions)
SELECT $1, p.term, s.id, p.ttf, p.htf, p.btf, p.positions
FROM unnest($12::int4[], $13::text[], $14::int4[], $15::int4[], $16::int4[], $17::bytea[])
  AS p(idx, term, ttf, htf, btf, positions)
JOIN s ON s.idx = p.idx`;

/** Deletes a note's sections and their postings in one statement. */
const DELETE_SECTIONS_AND_POSTINGS = `
WITH d AS (DELETE FROM sections WHERE brain_id = $1 AND path = $2 RETURNING id)
DELETE FROM postings WHERE brain_id = $1 AND section IN (SELECT id FROM d)`;

/** The same, answering how many sections were deleted. */
const DELETE_SECTIONS_AND_POSTINGS_RETURNING = `
WITH d AS (DELETE FROM sections WHERE brain_id = $1 AND path = $2 RETURNING id),
     p AS (DELETE FROM postings WHERE brain_id = $1 AND section IN (SELECT id FROM d))
SELECT count(*) AS n FROM d`;

export class PgTermIndex implements storage.TermIndex {
  private readonly db: BrainDb;
  /** The analyzer recorded for the brain; changed only by `setAnalyzer` (on reset). */
  private current: keyword.AnalyzerOptions;
  constructor(db: BrainDb, current: keyword.AnalyzerOptions) {
    this.db = db;
    this.current = current;
  }

  get analyzer(): keyword.AnalyzerOptions {
    return this.current;
  }

  /** Records a new analyzer (inside `resetIndex`'s transaction, on `q`). */
  async setAnalyzer(q: Queryable, analyzer: keyword.AnalyzerOptions): Promise<void> {
    await query(q, `UPDATE index_state SET analyzer = $2 WHERE brain_id = $1`, [
      this.db.brainId,
      storage.analyzerToJson(analyzer),
    ]);
    this.current = analyzer;
  }

  analyzerMismatch(requested?: Partial<keyword.AnalyzerOptions>): storage.AnalyzerMismatch | null {
    return storage.compareAnalyzers(this.current, requested);
  }

  async replaceSections(
    path: string,
    title: string,
    sections: readonly storage.SectionInput[],
  ): Promise<void> {
    if (typeof path !== 'string' || path === '') throw new RangeError('path must be non-empty');
    const analyzed = sections.map((s) =>
      keyword.analyzeSection({ title, heading: s.heading ?? '', body: s.body }, this.current),
    );
    const s = {
      idx: [] as number[],
      heading: [] as (string | null)[],
      body: [] as string[],
      start: [] as number[],
      end: [] as number[],
      tl: [] as number[],
      hl: [] as number[],
      bl: [] as number[],
    };
    const p = {
      idx: [] as number[],
      term: [] as string[],
      ttf: [] as number[],
      htf: [] as number[],
      btf: [] as number[],
      positions: [] as Buffer[],
    };
    sections.forEach((section, idx) => {
      const a = analyzed[idx] as keyword.AnalyzedSection;
      s.idx.push(idx);
      s.heading.push(section.heading);
      s.body.push(section.body);
      s.start.push(section.startLine ?? 0);
      s.end.push(section.endLine ?? 0);
      s.tl.push(a.lengths.title);
      s.hl.push(a.lengths.heading);
      s.bl.push(a.lengths.body);
      for (const [term, entry] of a.terms) {
        p.idx.push(idx);
        p.term.push(term);
        p.ttf.push(entry.tf.title);
        p.htf.push(entry.tf.heading);
        p.btf.push(entry.tf.body);
        const bytes = storage.encodePositions(entry.positions);
        p.positions.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      }
    });
    const brainId = this.db.brainId;
    await this.db.derivedAtomic(async (q) => {
      await query(q, DELETE_SECTIONS_AND_POSTINGS, [brainId, path]);
      if (sections.length === 0) return;
      await query(q, INSERT_SECTIONS_AND_POSTINGS, [
        brainId,
        path,
        title,
        s.idx,
        s.heading,
        s.body,
        s.start,
        s.end,
        s.tl,
        s.hl,
        s.bl,
        p.idx,
        p.term,
        p.ttf,
        p.htf,
        p.btf,
        p.positions,
      ]);
    });
  }

  async removeSections(path: string): Promise<boolean> {
    const { rows } = await this.db.derived<{ n: number }>(
      `${DELETE_SECTIONS_AND_POSTINGS_RETURNING}`,
      [this.db.brainId, path],
    );
    return (rows[0]?.n ?? 0) > 0;
  }

  async getSection(id: string): Promise<storage.StoredSection | undefined> {
    const parsed = storage.parseSectionId(id);
    if (!parsed) return undefined;
    const { rows } = await this.db.derived<SectionRow>(
      `SELECT ${SECTION_COLUMNS} FROM sections WHERE brain_id = $1 AND path = $2 AND idx = $3`,
      [this.db.brainId, parsed.path, parsed.index],
    );
    return rows[0] ? toSection(rows[0]) : undefined;
  }

  async sectionsOf(path: string): Promise<storage.StoredSection[]> {
    const { rows } = await this.db.derived<SectionRow>(
      `SELECT ${SECTION_COLUMNS} FROM sections WHERE brain_id = $1 AND path = $2 ORDER BY idx`,
      [this.db.brainId, path],
    );
    return rows.map(toSection);
  }

  private async totals(): Promise<{ n: number; title: number; heading: number; body: number }> {
    const { rows } = await this.db.derived<{
      n: number;
      title: number;
      heading: number;
      body: number;
    }>(
      `SELECT count(*) AS n, coalesce(sum(title_len), 0) AS title,
              coalesce(sum(heading_len), 0) AS heading, coalesce(sum(body_len), 0) AS body
       FROM sections WHERE brain_id = $1`,
      [this.db.brainId],
    );
    return rows[0] as { n: number; title: number; heading: number; body: number };
  }

  async statistics(): Promise<keyword.IndexStatistics> {
    const t = await this.totals();
    const { rows } = await this.db.derived<{ term: string; df: number }>(
      `SELECT term, count(*) AS df FROM postings WHERE brain_id = $1 GROUP BY term`,
      [this.db.brainId],
    );
    const documentFrequencies = rows
      .map((r) => [r.term, r.df] as const)
      .sort(([a], [b]) => compareStrings(a, b));
    return {
      sectionCount: t.n,
      totalFieldLengths: { title: t.title, heading: t.heading, body: t.body },
      documentFrequencies,
    };
  }

  // -- keyword.PostingsSource

  async corpusStats(): Promise<keyword.CorpusStats> {
    const t = await this.totals();
    const avg = (total: number): number => (t.n === 0 ? 0 : total / t.n);
    return {
      sectionCount: t.n,
      averageFieldLengths: { title: avg(t.title), heading: avg(t.heading), body: avg(t.body) },
    };
  }

  async documentFrequency(term: string): Promise<number> {
    const { rows } = await this.db.derived<{ n: number }>(
      `SELECT count(*) AS n FROM postings WHERE brain_id = $1 AND term = $2`,
      [this.db.brainId, term],
    );
    return rows[0]?.n ?? 0;
  }

  /** One indexed query: the postings' primary key leads with (brain_id, term). */
  async postings(
    term: string,
    options: { readonly withPositions: boolean },
  ): Promise<keyword.Posting[]> {
    const { rows } = await this.db.derived<{
      path: string;
      idx: number;
      title_len: number;
      heading_len: number;
      body_len: number;
      title_tf: number;
      heading_tf: number;
      body_tf: number;
      positions?: Uint8Array;
    }>(
      `SELECT s.path, s.idx, s.title_len, s.heading_len, s.body_len,
              p.title_tf, p.heading_tf, p.body_tf${options.withPositions ? ', p.positions' : ''}
       FROM postings p JOIN sections s ON s.brain_id = p.brain_id AND s.id = p.section
       WHERE p.brain_id = $1 AND p.term = $2
       ORDER BY p.section`,
      [this.db.brainId, term],
    );
    return rows.map((r) => {
      const tf = { title: r.title_tf, heading: r.heading_tf, body: r.body_tf };
      const posting: keyword.Posting = {
        id: storage.sectionId(r.path, r.idx),
        tf,
        lengths: { title: r.title_len, heading: r.heading_len, body: r.body_len },
        ...(options.withPositions
          ? { positions: storage.decodePositions(r.positions as Uint8Array, tf) }
          : {}),
      };
      return posting;
    });
  }
}
