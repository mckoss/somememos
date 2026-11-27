// The derived stores over `index.sqlite`: scores and the fold cursor, notes
// and links, and the term index. Synchronous, like the event log.

import { keyword, storage, timescore } from '@somememos/core';
import type { Database } from '../sqlite/database.js';
import { atomic } from './schema.js';

const { compareStrings } = storage;

/** Internal keys in the index file's `meta` table. */
export const META_FOLD_CURSOR = 'fold_cursor';
export const META_FOLD_HALF_LIVES = 'fold_half_lives';
export const META_ANALYZER = 'analyzer';

function getMeta(db: Database, key: string): string | undefined {
  return db.get<{ value: string }>(`SELECT value FROM meta WHERE key = :key`, { key })?.value;
}

function setMeta(db: Database, key: string, value: string): void {
  db.run(
    `INSERT INTO meta (key, value) VALUES (:key, :value)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    { key, value },
  );
}

function deleteMeta(db: Database, key: string): void {
  db.run(`DELETE FROM meta WHERE key = :key`, { key });
}

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

export class SqliteScoreStore implements storage.ScoreStore {
  constructor(private readonly db: Database) {}

  foldState(): storage.FoldState {
    const cursor = Number(getMeta(this.db, META_FOLD_CURSOR) ?? 0);
    const hl = getMeta(this.db, META_FOLD_HALF_LIVES);
    return { cursor, halfLives: hl === undefined ? null : (JSON.parse(hl) as storage.HalfLives) };
  }

  getItem(item: string): timescore.ItemScores<string> | undefined {
    const rows = this.db.all<ScoreRow>(
      `SELECT item, kind, half_life, log_score FROM scores WHERE item = :item`,
      { item },
    );
    if (rows.length === 0) return undefined;
    const out: timescore.ItemScores<string> = {};
    for (const row of rows) addRow(out, row);
    return ordered(out);
  }

  getAll(): Map<string, timescore.ItemScores<string>> {
    const byItem = new Map<string, timescore.ItemScores<string>>();
    for (const row of this.db.all<ScoreRow>(
      `SELECT item, kind, half_life, log_score FROM scores`,
    )) {
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

  applyFold(batch: storage.FoldBatch): void {
    storage.assertValidHalfLives(batch.halfLives);
    if (!Number.isSafeInteger(batch.toCursor) || batch.toCursor < batch.fromCursor) {
      throw new RangeError(`toCursor must be an integer >= fromCursor, not ${batch.toCursor}`);
    }
    const db = this.db;
    atomic(db, () => {
      // Read the state inside the transaction (which holds the write lock),
      // so a concurrent folder cannot commit in between.
      const state = this.foldState();
      if (state.cursor !== batch.fromCursor) {
        throw new storage.FoldConflictError(batch.fromCursor, state.cursor);
      }
      if (state.halfLives && !storage.sameHalfLives(state.halfLives, batch.halfLives)) {
        throw new storage.HalfLifeMismatchError(state.halfLives, batch.halfLives);
      }
      const get = db.prepare(
        `SELECT log_score FROM scores WHERE item = :item AND kind = :kind AND half_life = :hl`,
      );
      const put = db.prepare(
        `INSERT INTO scores (item, kind, half_life, log_score) VALUES (:item, :kind, :hl, :score)
         ON CONFLICT (item, kind, half_life) DO UPDATE SET log_score = excluded.log_score`,
      );
      // Combined in JavaScript with timescore.combine, so every store agrees bit for bit.
      const add = (item: string, kind: string, hl: string, score: number): void => {
        const current = get.get<{ log_score: number }>({ item, kind, hl })?.log_score;
        put.run({
          item,
          kind,
          hl,
          score: current === undefined ? score : timescore.combine(current, score),
        });
      };
      for (const op of batch.ops) {
        storage.assertValidScoreOp(op, batch.halfLives);
        if (op.type === 'add') {
          add(op.item, op.kind, op.halfLife, op.logScore);
        } else if (op.from !== op.to) {
          const rows = db.all<ScoreRow>(
            `SELECT item, kind, half_life, log_score FROM scores WHERE item = :item`,
            { item: op.from },
          );
          for (const row of rows) add(op.to, row.kind, row.half_life, row.log_score);
          db.run(`DELETE FROM scores WHERE item = :item`, { item: op.from });
        }
      }
      setMeta(db, META_FOLD_CURSOR, String(batch.toCursor));
      setMeta(db, META_FOLD_HALF_LIVES, storage.halfLivesToJson(batch.halfLives));
    });
  }

  clear(): void {
    atomic(this.db, () => {
      this.db.run(`DELETE FROM scores`);
      deleteMeta(this.db, META_FOLD_CURSOR);
      deleteMeta(this.db, META_FOLD_HALF_LIVES);
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

export class SqliteNoteStore implements storage.NoteStore {
  constructor(private readonly db: Database) {}

  upsertNote(note: storage.NoteRecord): void {
    storage.assertValidNote(note);
    this.db.run(
      `INSERT INTO notes (path, title, content_hash, mtime, role, date)
       VALUES (:path, :title, :hash, :mtime, :role, :date)
       ON CONFLICT (path) DO UPDATE SET title = excluded.title,
         content_hash = excluded.content_hash, mtime = excluded.mtime,
         role = excluded.role, date = excluded.date`,
      {
        path: note.path,
        title: note.title,
        hash: note.contentHash,
        mtime: note.mtime,
        role: note.role,
        date: note.date,
      },
    );
  }

  removeNote(path: string): boolean {
    return atomic(this.db, () => {
      this.db.run(`DELETE FROM links WHERE source = :path`, { path });
      return this.db.run(`DELETE FROM notes WHERE path = :path`, { path }).changes > 0;
    });
  }

  getNote(path: string): storage.NoteRecord | undefined {
    const row = this.db.get<NoteRow>(`SELECT * FROM notes WHERE path = :path`, { path });
    return row ? toNote(row) : undefined;
  }

  listNotes(filter?: { readonly role?: storage.NoteRole }): storage.NoteRecord[] {
    const rows =
      filter?.role === undefined
        ? this.db.all<NoteRow>(`SELECT * FROM notes`)
        : this.db.all<NoteRow>(`SELECT * FROM notes WHERE role = :role`, { role: filter.role });
    return rows.map(toNote).sort((a, b) => compareStrings(a.path, b.path));
  }

  replaceLinks(source: string, links: readonly storage.NoteLink[]): void {
    const byTarget = new Map<string, boolean>();
    for (const link of links) {
      if (typeof link.target !== 'string' || link.target === '') {
        throw new RangeError('link target must be a non-empty string');
      }
      byTarget.set(link.target, Boolean(link.dangling));
    }
    atomic(this.db, () => {
      this.db.run(`DELETE FROM links WHERE source = :source`, { source });
      const insert = this.db.prepare(
        `INSERT INTO links (source, target, dangling) VALUES (:source, :target, :dangling)`,
      );
      for (const [target, dangling] of byTarget) {
        insert.run({ source, target, dangling: dangling ? 1 : 0 });
      }
    });
  }

  linksFrom(source: string): storage.NoteLink[] {
    return this.db
      .all<{ target: string; dangling: number }>(
        `SELECT target, dangling FROM links WHERE source = :source`,
        { source },
      )
      .map((r) => ({ target: r.target, dangling: r.dangling !== 0 }))
      .sort((a, b) => compareStrings(a.target, b.target));
  }

  backlinks(target: string): string[] {
    return this.db
      .all<{ source: string }>(`SELECT source FROM links WHERE target = :target`, { target })
      .map((r) => r.source)
      .sort(compareStrings);
  }

  danglingTargets(): storage.DanglingCount[] {
    return this.db
      .all<{ key: string; count: number }>(
        `SELECT target AS key, count(*) AS count FROM links WHERE dangling = 1 GROUP BY target`,
      )
      .sort((a, b) => b.count - a.count || compareStrings(a.key, b.key))
      .map((r) => ({ key: r.key, count: r.count }));
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

export class SqliteTermIndex implements storage.TermIndex {
  constructor(
    private readonly db: Database,
    /** The analyzer recorded in the file; changed only by `setAnalyzer` (on reset). */
    private current: keyword.AnalyzerOptions,
  ) {}

  get analyzer(): keyword.AnalyzerOptions {
    return this.current;
  }

  /** Records a new analyzer. Only for an empty index (`resetIndex`). */
  setAnalyzer(analyzer: keyword.AnalyzerOptions): void {
    setMeta(this.db, META_ANALYZER, storage.analyzerToJson(analyzer));
    this.current = analyzer;
  }

  analyzerMismatch(requested?: Partial<keyword.AnalyzerOptions>): storage.AnalyzerMismatch | null {
    return storage.compareAnalyzers(this.current, requested);
  }

  replaceSections(path: string, title: string, sections: readonly storage.SectionInput[]): void {
    if (typeof path !== 'string' || path === '') throw new RangeError('path must be non-empty');
    const analyzed = sections.map((s) =>
      keyword.analyzeSection({ title, heading: s.heading ?? '', body: s.body }, this.current),
    );
    const db = this.db;
    atomic(db, () => {
      this.removeSections(path);
      const insertSection = db.prepare(
        `INSERT INTO sections (${SECTION_COLUMNS})
         VALUES (:path, :idx, :title, :heading, :body, :start, :end, :tl, :hl, :bl)`,
      );
      const insertPosting = db.prepare(
        `INSERT INTO postings (term, section, title_tf, heading_tf, body_tf, positions)
         VALUES (:term, :section, :ttf, :htf, :btf, :positions)`,
      );
      sections.forEach((s, idx) => {
        const a = analyzed[idx] as keyword.AnalyzedSection;
        const { lastInsertRowid: section } = insertSection.run({
          path,
          idx,
          title,
          heading: s.heading,
          body: s.body,
          start: s.startLine ?? 0,
          end: s.endLine ?? 0,
          tl: a.lengths.title,
          hl: a.lengths.heading,
          bl: a.lengths.body,
        });
        for (const [term, entry] of a.terms) {
          insertPosting.run({
            term,
            section,
            ttf: entry.tf.title,
            htf: entry.tf.heading,
            btf: entry.tf.body,
            positions: storage.encodePositions(entry.positions),
          });
        }
      });
    });
  }

  removeSections(path: string): boolean {
    return atomic(this.db, () => {
      this.db.run(
        `DELETE FROM postings WHERE section IN (SELECT id FROM sections WHERE path = :path)`,
        { path },
      );
      return this.db.run(`DELETE FROM sections WHERE path = :path`, { path }).changes > 0;
    });
  }

  getSection(id: string): storage.StoredSection | undefined {
    const parsed = storage.parseSectionId(id);
    if (!parsed) return undefined;
    const row = this.db.get<SectionRow>(
      `SELECT ${SECTION_COLUMNS} FROM sections WHERE path = :path AND idx = :idx`,
      { path: parsed.path, idx: parsed.index },
    );
    return row ? toSection(row) : undefined;
  }

  sectionsOf(path: string): storage.StoredSection[] {
    return this.db
      .all<SectionRow>(`SELECT ${SECTION_COLUMNS} FROM sections WHERE path = :path ORDER BY idx`, {
        path,
      })
      .map(toSection);
  }

  private totals(): { n: number; title: number; heading: number; body: number } {
    return this.db.get<{ n: number; title: number; heading: number; body: number }>(
      `SELECT count(*) AS n, coalesce(sum(title_len), 0) AS title,
              coalesce(sum(heading_len), 0) AS heading, coalesce(sum(body_len), 0) AS body
       FROM sections`,
    ) as { n: number; title: number; heading: number; body: number };
  }

  statistics(): keyword.IndexStatistics {
    const t = this.totals();
    const documentFrequencies = this.db
      .all<{ term: string; df: number }>(`SELECT term, count(*) AS df FROM postings GROUP BY term`)
      .map((r) => [r.term, r.df] as const)
      .sort(([a], [b]) => compareStrings(a, b));
    return {
      sectionCount: t.n,
      totalFieldLengths: { title: t.title, heading: t.heading, body: t.body },
      documentFrequencies,
    };
  }

  // -- keyword.PostingsSource

  corpusStats(): keyword.CorpusStats {
    const t = this.totals();
    const avg = (total: number): number => (t.n === 0 ? 0 : total / t.n);
    return {
      sectionCount: t.n,
      averageFieldLengths: { title: avg(t.title), heading: avg(t.heading), body: avg(t.body) },
    };
  }

  documentFrequency(term: string): number {
    return (
      this.db.get<{ n: number }>(`SELECT count(*) AS n FROM postings WHERE term = :term`, { term })
        ?.n ?? 0
    );
  }

  postings(term: string, options: { readonly withPositions: boolean }): keyword.Posting[] {
    const rows = this.db.all<{
      path: string;
      idx: number;
      title_len: number;
      heading_len: number;
      body_len: number;
      title_tf: number;
      heading_tf: number;
      body_tf: number;
      positions: Uint8Array;
    }>(
      `SELECT s.path, s.idx, s.title_len, s.heading_len, s.body_len,
              p.title_tf, p.heading_tf, p.body_tf, p.positions
       FROM postings p JOIN sections s ON s.id = p.section
       WHERE p.term = :term`,
      { term },
    );
    return rows.map((r) => {
      const tf = { title: r.title_tf, heading: r.heading_tf, body: r.body_tf };
      const posting: keyword.Posting = {
        id: storage.sectionId(r.path, r.idx),
        tf,
        lengths: { title: r.title_len, heading: r.heading_len, body: r.body_len },
        ...(options.withPositions ? { positions: storage.decodePositions(r.positions, tf) } : {}),
      };
      return posting;
    });
  }
}
