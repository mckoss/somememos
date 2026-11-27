// The SQLite schema of an offline client's two files (PLAN.md section 4,
// "Sidecar layout" and "SQLite schema"). Plain tables and ordinary SQL only,
// so a Postgres implementation can mirror it (with a brain id on every row).
//
// - `events.sqlite`: original data. A schema version it doesn't know is an
//   error (`MigrationRequiredError`); nothing in it is ever dropped.
// - `index.sqlite`: derived data. A schema version it doesn't know means its
//   tables are dropped and recreated empty, to be rebuilt.

import { storage } from '@somememos/core';
import type { Database } from '../sqlite/database.js';

/** Bump when `events.sqlite` changes shape; add a migration from every older version. */
export const EVENTS_SCHEMA_VERSION = 1;
/** Bump when `index.sqlite` changes shape; old index files are then rebuilt. */
export const INDEX_SCHEMA_VERSION = 1;

/** Internal key in each file's `meta` table. */
export const SCHEMA_VERSION_KEY = 'schema_version';

const EVENTS_SCHEMA = `
-- Internal settings of this file (schema version).
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- Meta that callers store (Stores.meta): kept with the original data.
CREATE TABLE user_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- The event log: events and rename records, one sequence.
CREATE TABLE events (
  seq    INTEGER PRIMARY KEY,   -- local arrival order; rows are never deleted
  id     TEXT NOT NULL UNIQUE,  -- globally unique; a known id is skipped
  kind   TEXT NOT NULL,         -- 'read' | 'edit' | 'mention' | 'rename'
  item   TEXT NOT NULL,         -- note path or dangling key (for 'rename': the old item)
  time   INTEGER NOT NULL,      -- Unix seconds, when it happened
  client TEXT NOT NULL,
  target TEXT                   -- for 'rename': the new item; otherwise NULL
);
CREATE INDEX events_kind_seq ON events (kind, seq);

-- The change log: one record per commit.
CREATE TABLE changes (
  seq     INTEGER PRIMARY KEY,
  id      TEXT NOT NULL UNIQUE,
  time    INTEGER NOT NULL,
  client  TEXT NOT NULL,
  message TEXT,
  op      TEXT
);
CREATE INDEX changes_time ON changes (time, seq);
CREATE INDEX changes_op ON changes (op, time);

CREATE TABLE change_paths (
  change_seq INTEGER NOT NULL REFERENCES changes (seq),
  path       TEXT NOT NULL,
  PRIMARY KEY (change_seq, path)
) WITHOUT ROWID;
CREATE INDEX change_paths_path ON change_paths (path, change_seq);
`;

const INDEX_SCHEMA = `
-- Internal settings: schema version, fold cursor and half-lives, analyzer.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- Meta that callers store (Stores.indexMeta): derived, deleted by a reset.
CREATE TABLE user_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE notes (
  path         TEXT PRIMARY KEY,  -- relative to the brain root, '/' separators
  title        TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  mtime        INTEGER NOT NULL,
  role         TEXT NOT NULL,     -- 'memo' | 'dated' | 'source'
  date         TEXT               -- YYYY-MM-DD for dated notes
) WITHOUT ROWID;

CREATE TABLE links (
  source   TEXT NOT NULL,         -- the linking note's path
  target   TEXT NOT NULL,         -- resolved path, or dangling key
  dangling INTEGER NOT NULL,      -- 1 when target is a dangling key
  PRIMARY KEY (source, target)
) WITHOUT ROWID;
CREATE INDEX links_target ON links (target, source);

-- One row per section (the preamble, then one per '##' heading).
CREATE TABLE sections (
  id          INTEGER PRIMARY KEY,
  path        TEXT NOT NULL,
  idx         INTEGER NOT NULL,   -- position in the note; the public id is '<path>#<idx>'
  title       TEXT NOT NULL,      -- the note's title
  heading     TEXT,               -- NULL for the preamble
  body        TEXT NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  title_len   INTEGER NOT NULL,   -- field lengths in tokens, for BM25F
  heading_len INTEGER NOT NULL,
  body_len    INTEGER NOT NULL,
  UNIQUE (path, idx)
);

-- The term index: counts and positions, never scores.
CREATE TABLE postings (
  term       TEXT NOT NULL,
  section    INTEGER NOT NULL REFERENCES sections (id),
  title_tf   INTEGER NOT NULL,
  heading_tf INTEGER NOT NULL,
  body_tf    INTEGER NOT NULL,
  positions  BLOB NOT NULL,       -- storage.encodePositions: varint gaps, title then heading then body
  PRIMARY KEY (term, section)
) WITHOUT ROWID;
CREATE INDEX postings_section ON postings (section);

-- TimeScore log scores per (item, kind, half-life), unweighted. No row: no events.
CREATE TABLE scores (
  item      TEXT NOT NULL,
  kind      TEXT NOT NULL,
  half_life TEXT NOT NULL,
  log_score REAL NOT NULL,
  PRIMARY KEY (item, kind, half_life)
) WITHOUT ROWID;
`;

/** The tables of the index file, in an order safe to delete from. */
export const INDEX_TABLES = ['postings', 'sections', 'links', 'notes', 'scores', 'user_meta'];

function userTables(db: Database): string[] {
  return db
    .all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .map((r) => r.name);
}

function schemaVersion(db: Database): string | undefined {
  return db.get<{ value: string }>(`SELECT value FROM meta WHERE key = :key`, {
    key: SCHEMA_VERSION_KEY,
  })?.value;
}

/**
 * Creates the event log's tables in a new file, or checks the version of an
 * existing one. Throws `MigrationRequiredError`, changing nothing, for a file
 * with another schema version or one that is not a somememos event log.
 */
export function ensureEventsSchema(db: Database): void {
  db.transaction(() => {
    const tables = userTables(db);
    if (tables.length === 0) {
      db.exec(EVENTS_SCHEMA);
      db.run(`INSERT INTO meta (key, value) VALUES (:key, :value)`, {
        key: SCHEMA_VERSION_KEY,
        value: String(EVENTS_SCHEMA_VERSION),
      });
      return;
    }
    const version = tables.includes('meta') ? schemaVersion(db) : undefined;
    if (version === undefined) {
      throw new storage.MigrationRequiredError(
        `${db.location} is not a somememos event log (it has no schema version). Nothing was changed.`,
      );
    }
    if (version !== String(EVENTS_SCHEMA_VERSION)) {
      throw new storage.MigrationRequiredError(
        `${db.location} has event log schema version ${version}, but this somememos uses version ${EVENTS_SCHEMA_VERSION}. ` +
          `A migration is required; nothing was changed. The event log is original data: back it up and upgrade somememos, never delete it.`,
      );
    }
  });
}

/**
 * Creates the index's tables in a new file. An index file with another (or
 * no) schema version is derived data: its tables are dropped and recreated
 * empty. Returns true when the file was (re)created.
 */
export function ensureIndexSchema(db: Database): boolean {
  return db.transaction(() => {
    const tables = userTables(db);
    if (tables.length > 0) {
      const version = tables.includes('meta') ? schemaVersion(db) : undefined;
      if (version === String(INDEX_SCHEMA_VERSION)) return false;
      for (const name of tables) db.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`);
    }
    db.exec(INDEX_SCHEMA);
    db.run(`INSERT INTO meta (key, value) VALUES (:key, :value)`, {
      key: SCHEMA_VERSION_KEY,
      value: String(INDEX_SCHEMA_VERSION),
    });
    return true;
  });
}

let savepointCounter = 0;

/**
 * Runs `fn` atomically: in a new transaction, or in a savepoint when one is
 * already open on this connection (for example inside `indexTransaction`).
 */
export function atomic<T>(db: Database, fn: () => T): T {
  if (!db.raw.isTransaction) return db.transaction(() => fn());
  const name = `somememos_${++savepointCounter}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    if (db.raw.isOpen && db.raw.isTransaction) db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
    throw error;
  }
}
