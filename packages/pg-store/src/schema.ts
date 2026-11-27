// The server's Postgres schema (PLAN.md sections 4 and 9): the same tables as
// an offline client's two SQLite files, in one database for every brain, with
// a brain id leading every row, primary key and index.
//
// Migrations are plain SQL, applied in order by `migrate` (./migrate.ts) and
// recorded in `schema_migrations`. Never edit a migration that has shipped:
// add a new one. Original data (events, changes, meta, content) is never
// dropped by a migration; derived data may be, since it can be rebuilt.
//
// Text that is compared or sorted (ids, paths, items, terms, keys) is
// `COLLATE "C"`: bytewise, like SQLite's default, and independent of the
// database's locale. Where an interface promises an order by
// `storage.compareStrings` (UTF-16 code units), the code sorts in JavaScript,
// exactly as the SQLite store does.

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const INITIAL = `
-- One row per brain. Its counters are bumped under this row's lock, so for
-- one brain they are assigned in commit order (see event-log.ts).
CREATE TABLE brains (
  brain_id     text COLLATE "C" PRIMARY KEY,
  created_at   bigint NOT NULL,               -- Unix seconds
  event_seq    bigint NOT NULL DEFAULT 0,     -- last events.seq assigned
  change_seq   bigint NOT NULL DEFAULT 0,     -- last changes.seq assigned
  mutation_seq bigint NOT NULL DEFAULT 0      -- PLAN.md section 7, "The mutation counter"
);

-- Advances a brain's mutation counter by n and returns the new value. The
-- brain row stays locked until the calling transaction ends, so numbers are
-- handed out in commit order.
CREATE FUNCTION somememos_advance_mutation_seq(p_brain_id text, p_n bigint DEFAULT 1)
RETURNS bigint LANGUAGE sql AS $$
  UPDATE brains SET mutation_seq = mutation_seq + p_n
  WHERE brain_id = p_brain_id
  RETURNING mutation_seq
$$;

-- ---------------------------------------------------------------------------
-- Original data

-- Meta that callers store (Stores.meta): kept with the original data.
CREATE TABLE brain_meta (
  brain_id text COLLATE "C" NOT NULL REFERENCES brains,
  key      text COLLATE "C" NOT NULL,
  value    text NOT NULL,
  PRIMARY KEY (brain_id, key)
);

-- The event log: events and rename records, one sequence per brain.
CREATE TABLE events (
  brain_id text COLLATE "C" NOT NULL REFERENCES brains,
  seq      bigint NOT NULL,                  -- 1, 2, … per brain, no gaps; never deleted
  id       text COLLATE "C" NOT NULL,        -- globally unique; a known id is skipped
  kind     text COLLATE "C" NOT NULL,        -- an event kind, or 'rename'
  item     text COLLATE "C" NOT NULL,        -- note path or dangling key (rename: the old item)
  time     bigint NOT NULL,                  -- Unix seconds, when it happened
  client   text NOT NULL,
  target   text COLLATE "C",                 -- rename: the new item; otherwise NULL
  PRIMARY KEY (brain_id, seq),
  UNIQUE (brain_id, id)
);
CREATE INDEX events_kind_seq ON events (brain_id, kind, seq);

-- The change log: one record per commit.
CREATE TABLE changes (
  brain_id text COLLATE "C" NOT NULL REFERENCES brains,
  seq      bigint NOT NULL,
  id       text COLLATE "C" NOT NULL,
  time     bigint NOT NULL,
  client   text NOT NULL,
  message  text,
  op       text COLLATE "C",
  PRIMARY KEY (brain_id, seq),
  UNIQUE (brain_id, id)
);
CREATE INDEX changes_time ON changes (brain_id, time, seq);
CREATE INDEX changes_op ON changes (brain_id, op, time);

CREATE TABLE change_paths (
  brain_id   text COLLATE "C" NOT NULL,
  change_seq bigint NOT NULL,
  path       text COLLATE "C" NOT NULL,
  PRIMARY KEY (brain_id, change_seq, path),
  FOREIGN KEY (brain_id, change_seq) REFERENCES changes (brain_id, seq)
);
CREATE INDEX change_paths_path ON change_paths (brain_id, path, change_seq);

-- Note text (storage.ContentStore), for a host that keeps it in the database.
CREATE TABLE content (
  brain_id text COLLATE "C" NOT NULL REFERENCES brains,
  path     text COLLATE "C" NOT NULL,        -- brain-relative, '/' separators
  text     text NOT NULL,                    -- exactly what was saved
  size     bigint NOT NULL,                  -- UTF-8 bytes
  mtime    bigint NOT NULL,                  -- Unix seconds
  hash     text NOT NULL,                    -- storage.contentHash(text)
  PRIMARY KEY (brain_id, path)
);

-- ---------------------------------------------------------------------------
-- Derived data (Stores.resetIndex deletes a brain's rows)

-- The fold cursor and half-lives, and the term index's analyzer. One row per
-- brain; applyFold locks it to check the cursor.
CREATE TABLE index_state (
  brain_id    text COLLATE "C" PRIMARY KEY REFERENCES brains,
  fold_cursor bigint NOT NULL DEFAULT 0,
  half_lives  text,                          -- storage.halfLivesToJson; NULL before the first fold
  analyzer    text                           -- storage.analyzerToJson
);

-- Meta that callers store (Stores.indexMeta): derived, deleted by a reset.
CREATE TABLE index_meta (
  brain_id text COLLATE "C" NOT NULL REFERENCES brains,
  key      text COLLATE "C" NOT NULL,
  value    text NOT NULL,
  PRIMARY KEY (brain_id, key)
);

CREATE TABLE notes (
  brain_id     text COLLATE "C" NOT NULL REFERENCES brains,
  path         text COLLATE "C" NOT NULL,
  title        text NOT NULL,
  content_hash text NOT NULL,
  mtime        bigint NOT NULL,
  role         text COLLATE "C" NOT NULL,    -- a folder role other than 'excluded'; not an enum
  date         text,                         -- YYYY-MM-DD for dated notes
  PRIMARY KEY (brain_id, path)
);
CREATE INDEX notes_role ON notes (brain_id, role, path);

CREATE TABLE links (
  brain_id text COLLATE "C" NOT NULL REFERENCES brains,
  source   text COLLATE "C" NOT NULL,        -- the linking note's path
  target   text COLLATE "C" NOT NULL,        -- resolved path, or dangling key
  dangling boolean NOT NULL,
  PRIMARY KEY (brain_id, source, target)
);
CREATE INDEX links_target ON links (brain_id, target, source);

-- One row per section (the preamble, then one per '##' heading). The id is
-- internal; the public id is '<path>#<idx>'.
CREATE TABLE sections (
  brain_id    text COLLATE "C" NOT NULL REFERENCES brains,
  id          bigint GENERATED ALWAYS AS IDENTITY,
  path        text COLLATE "C" NOT NULL,
  idx         integer NOT NULL,
  title       text NOT NULL,
  heading     text,                          -- NULL for the preamble
  body        text NOT NULL,
  start_line  integer NOT NULL,
  end_line    integer NOT NULL,
  title_len   integer NOT NULL,              -- field lengths in tokens, for BM25F
  heading_len integer NOT NULL,
  body_len    integer NOT NULL,
  PRIMARY KEY (brain_id, id),
  UNIQUE (brain_id, path, idx)
);

-- The term index: counts and positions, never scores.
CREATE TABLE postings (
  brain_id   text COLLATE "C" NOT NULL,
  term       text COLLATE "C" NOT NULL,
  section    bigint NOT NULL,
  title_tf   integer NOT NULL,
  heading_tf integer NOT NULL,
  body_tf    integer NOT NULL,
  positions  bytea NOT NULL,                 -- storage.encodePositions
  PRIMARY KEY (brain_id, term, section)
  -- No foreign key to sections: its per-row check slowed indexing a lot.
  -- Postings are deleted with their sections, in the same statement.
);
CREATE INDEX postings_section ON postings (brain_id, section);

-- TimeScore log scores per (item, kind, half-life), unweighted. No row: no
-- events. Never -Infinity.
CREATE TABLE scores (
  brain_id  text COLLATE "C" NOT NULL REFERENCES brains,
  item      text COLLATE "C" NOT NULL,
  kind      text COLLATE "C" NOT NULL,
  half_life text COLLATE "C" NOT NULL,
  log_score double precision NOT NULL CHECK (log_score > '-Infinity'::double precision),
  PRIMARY KEY (brain_id, item, kind, half_life)
);
`;

// The server's own tables (packages/server): which brains exist and who owns
// them, the git commit each brain's repository is at, every note version by
// mutation number, and the mutation number each log entry and change record
// took (PLAN.md section 7, "The mutation counter"). NULL `mutation` means the
// entry was not stored through the server's write path (pg-store's own tests,
// or a write that has not been numbered yet); the server numbers such entries
// on its next write to the brain.
const SERVER = `
ALTER TABLE events ADD COLUMN mutation bigint;
ALTER TABLE changes ADD COLUMN mutation bigint;
CREATE INDEX events_mutation ON events (brain_id, mutation);
CREATE INDEX changes_mutation ON changes (brain_id, mutation);

-- A brain the server hosts. Ownership lives here so real accounts can
-- replace the single-user token without changing the data.
CREATE TABLE server_brains (
  brain_id   text COLLATE "C" PRIMARY KEY REFERENCES brains,
  owner_id   text COLLATE "C" NOT NULL,
  config     text NOT NULL,                 -- the brain's config (JSON), without a client id
  git_head   text,                          -- the commit the repository is recorded at; NULL before the first
  created_at bigint NOT NULL                -- Unix seconds
);
CREATE INDEX server_brains_owner ON server_brains (owner_id, brain_id);

-- Every note version the server stored, by the mutation number it took. A
-- rename takes one number and two rows: the old path (hash NULL, renamed_to
-- set) and the new one.
CREATE TABLE note_versions (
  brain_id   text COLLATE "C" NOT NULL REFERENCES brains,
  mutation   bigint NOT NULL,
  path       text COLLATE "C" NOT NULL,
  hash       text,                          -- storage.contentHash of the text; NULL when the path was removed
  renamed_to text COLLATE "C",              -- set when the path was removed by a rename
  commit     text NOT NULL,                 -- the git commit that made this version
  PRIMARY KEY (brain_id, path, mutation)
);
CREATE INDEX note_versions_mutation ON note_versions (brain_id, mutation);
`;

/** Every migration, in order. Append only. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial', sql: INITIAL },
  { version: 2, name: 'server', sql: SERVER },
];

/** The derived tables of a brain, in an order safe to delete from. */
export const DERIVED_TABLES = ['postings', 'sections', 'links', 'notes', 'scores', 'index_meta'];
