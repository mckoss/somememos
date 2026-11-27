# somememos — Plan

This is the working plan for somememos. It is self-contained: everything decided so far is written here, so a new session (human or agent) can start from this file without any earlier conversation. When a decision changes, update this file in the same change.

Task-level steps for each milestone are in [IMPLEMENTATION.md](IMPLEMENTATION.md).

Origin: a design discussion on 2026-11-26 between Mike Koss and Claude (revised 2026-11-27), also recorded in Mike's private second-brain vault (`mckoss/2nd-brain`, `wiki/ideas/timescore-working-memory.md`).

## 1. What it is

somememos is a second brain made of plain markdown files, plus a **sidecar database** that adds:

- a **keyword index** for full-text search over the notes,
- an **event log** of interactions with the notes (reads, edits, mentions), and
- **TimeScore activation scores** computed from that log, a working memory that says which notes are active now, which are heating up, and which used to matter but have gone quiet.

The notes live on the **server's filesystem**, in one git repository per brain, which gives every note a version history. Git stays inside the server: clients never speak the git protocol. Agents reach it through a CLI that talks to the server directly and fetches only the notes it reads. The web app keeps a full **offline copy** and syncs with the server. All of a person's agents share this one durable memory. An **MCP server** comes later, for clients without a shell and for the hosted service.

**Primary purpose:** a more relevant memory for agents. Views for people (what am I neglecting?) matter too, but agent relevance decides the defaults.

The first user is Mike, dogfooding on his own vault. The goal after that is a hosted website at **somememos** (Mike owns the domain) that hosts brains for other users.

### Why it exists

- Mike's second brain is a git repo of markdown notes that AI agents maintain. Agents start each session from zero and orient themselves with `grep` and by tailing changelogs. They have no sense of what is active now.
- Mike stopped using Obsidian because he didn't like its subscription model for sync. He wants to keep plain markdown files, with sync he controls.
- Most RAG and "AI memory" products have no notion of time. Activation that builds with use and fades at several speeds is the distinguishing feature.

### Is this RAG?

Only in the broad sense of retrieval for an AI. Classic RAG chunks documents into embeddings and automatically pastes the most similar fragments into a model's prompt. somememos differs:

- **The agent drives the search.** It calls `search` as a tool, then reads whole files (agentic retrieval).
- **Ranking is keyword relevance plus activation**, so every result can be explained.
- **Markdown files are the content's source of truth.**
- **Time awareness** (working memory, trending, neglect) is the novel part.

Embeddings may be added later as one more ranking signal (section 12), never as a replacement for reading files.

## 2. Principles

1. **Plain markdown is the content.** Notes are ordinary `.md` files with `[[wiki-links]]`, readable and editable with any tool.
2. **The sidecar has two kinds of data, treated differently:**
   - The **event log** is original information: one record per interaction with a note (which note, what kind, when). The most useful signals, such as what was read, never appear in the files. The log cannot be rebuilt from the markdown, so it is backed up, synced and exported.
   - Everything else is **derived**. The keyword index is built from the markdown, and the TimeScore scores are built from the event log. Both can be deleted and rebuilt at any time.
3. **Keep the event log.** (Decided 2026-11-27. The earlier plan forbade storing any raw activity, as a privacy feature; Mike dropped that rule.) Keeping events means scores can be rebuilt, weights and half-lives can change, experiments can replay real history, and sync stays simple. Search query text is not logged for now, only because scoring doesn't use it. How long a hosted service keeps other people's logs is decided at milestone 5.
4. **Offline where it matters.** The web app works fully on a local copy and syncs when it can, because a person needs their notes on a plane. Agents are almost always online, so the CLI talks to the server and keeps only the notes it has read. A full local copy is an option for local or offline model use.
5. **You own your brain.** An export is the user's markdown plus the event log as a plain-text file. Together they rebuild everything.
6. **Agents read files.** The index exists to point agents at the right files, not to replace reading them. Agents read them through `somememos read`, so each read is recorded.
7. **Git on the server only.** Each brain is one git repository on the server's filesystem. The server commits every accepted change, so git supplies version history, diffs and the base for merges. No git interface is exposed for now: clients use somememos's own lighter protocol (section 7), and a hosted user never needs to know git is there. Exposing the git protocol to agents later remains possible.

## 3. TimeScore: the algorithm

> **Canonical description:** Mike's blog post **"TimeScore"** at <https://mckoss.com/posts/timescore/>. Read it before implementing or changing anything in this section. It explains the motivation, derives the time-invariant log form, gives the SQL update, and compares TimeScore with Reddit's and Hacker News's rankings. If this section and the post ever disagree, the post wins and this section should be fixed.

TimeScore is Mike's algorithm (public domain, credit requested: "TimeScore algorithm courtesy Mike Koss"). Mike holds US Patent 8,140,541 on it and has said he won't enforce it. Working code accompanies the post at <https://github.com/mckoss/timescore-demos> (`site/timescore.js`, `collect/timescore.py`). The demo code is MIT-licensed; somememos carries its own implementation under Apache 2.0.

The summary below is a condensed restatement of the post, plus the choices somememos makes on top of it (time units, half-lives, derived signals).

### Definition

An event with value `s > 0` at time `t` is worth `s` at that moment and halves every half-life `h`. An item's score at time `now` is:

```
S(now) = Σ s_i · 2^(-(now − t_i) / h)
```

### Time-invariant storage

Decay is never applied to stored data. Each event is scaled up by `2^(t_i / h)` when added, so every item shares the same time-dependent factor `2^(-now/h)`:

```
Ŝ = Σ s_i · 2^(t_i / h)          (stored)
S(now) = 2^(-now/h) · Ŝ           (read)
```

Ŝ doubles every half-life and would overflow, so only its natural log is stored: the **log score** `L = ln Ŝ`. An item with no events has `L = −∞` (`NULL` in SQL).

### Operations (reference implementation)

```ts
const LN2 = Math.LN2;
export const EMPTY = -Infinity;

// Log contribution of one event. Throws unless value > 0.
export function eventScore(value: number, time: number, halfLife: number): number {
  if (!(value > 0)) throw new RangeError("value must be > 0");
  return Math.log(value) + (time * LN2) / halfLife;
}

// Log-sum-exp: ln(e^a + e^b) without overflow. Commutative and associative.
export function combine(a: number, b: number): number {
  const high = Math.max(a, b), low = Math.min(a, b);
  if (low === -Infinity) return high;
  return high + Math.log1p(Math.exp(low - high));
}

export function addEvent(L: number, value: number, time: number, halfLife: number): number {
  return combine(L, eventScore(value, time, halfLife));
}

// Decayed score at time `now`.
export function scoreAt(L: number, now: number, halfLife: number): number {
  return Math.exp(L - (now * LN2) / halfLife);
}
```

Properties the design relies on:

- **Order never changes as time passes.** Every item fades at the same rate, so a sorted index on `L` stays valid. Order changes only when events arrive.
- **Adding an event is O(1).** There is no rescoring.
- **`combine()` is commutative and associative**, so activity from separate replicas can be merged, as long as each event is counted exactly once (section 7).
- Two simultaneous events of value 1 add exactly `ln 2` to an item's log score.

### Time units and precision

- somememos measures time in **seconds since the Unix epoch**, with half-lives in seconds. The epoch must never change, or stored scores become meaningless.
- Precision: for a one-day half-life, `L` today is about `1.78e9 / 86400 · ln 2 ≈ 14,300`. IEEE doubles carry about 15–16 significant digits, so roughly 11–12 digits of score precision remain. The blog reports about eleven digits for an 8-hour half-life measured in milliseconds. Shorter half-lives lose precision faster; treat about one hour as the minimum.

### Half-lives

Each item keeps one log score per half-life:

| Name  | Half-life | Meaning                    |
|-------|-----------|----------------------------|
| day   | 1 day     | what I'm doing right now   |
| week  | 7 days    | current focus              |
| month | 30 days   | ongoing projects           |
| year  | 365 days  | the long-term self         |

### Derived signals

- **Trending (heating up):** `D = L_week − L_month`. D does not depend on `now`, so it can be indexed directly. (The demos build their "Weekly trending" lists this way.)
- **Neglected (cooling but important):** a high year score with a low month score, for example ranked by `L_year − L_month`.
- **Guidance from the blog post on trending.** One recent event on an otherwise quiet item is "all trend", so rank trending only among items with enough recent activity (for example the top 100 by week score), then order those by D. Dividing the ratio by its steady value (about 0.24 for week over month with daily activity) makes 1.0 mean an item's usual pace.
- An item with no events in either half-life has no derived signal and sorts last.

## 4. Data model

### Items, events and kinds

- **Items are notes** (one markdown file each). Search works on **sections**; activation is scored per note. Whether to score sections too is an experiment (section 5).
- **Dangling links** (`[[links]]` to notes that don't exist yet) are items too, from M1, keyed by the link's target text. Emerging topics surface before a note exists. When the note is created, the dangling item's history carries over to it.
- **Events** are interactions with a note. There are three kinds, each recorded by the client that sees it happen:

  | Kind      | What happened                                                                  | Event time                                   |
  |-----------|--------------------------------------------------------------------------------|----------------------------------------------|
  | `read`    | The note was read through somememos (`somememos read`; later MCP and the PWA)  | when it was read                             |
  | `edit`    | The note's content changed (committed through the CLI, or saved in the PWA)    | the file's modification time, at most now    |
  | `mention` | An edit added a `[[link]]` to the note (or to a dangling target)               | the same time as that edit                   |

- **An event is dated when the interaction happens.** A date written inside a note (a deadline, a meeting next week) is content, not an event time. Writing about next week's meeting is an event today.
- **Weights and every other ranking parameter are set by experiment, not by intuition** (section 5, Evaluation). Until an experiment has measured them, every weight is 1. That is a placeholder, not a choice.
- **Link spreading is not stored.** If activation should spread across links, it is computed at query time from neighbors' scores, so its strength, direction and depth can be tuned by experiment. It starts switched off.

### The event log

The event log is the source of truth for all scores.

- It is **append-only**. Each record has a unique id, the item, the kind, the time, and the client that recorded it.
- A note that is renamed gets a **rename record** (old path, new path), so its history follows it. The index pass detects a rename when a path disappears and a new path appears with the same content.
- Every event is logged as it happened. Rules that treat events differently, such as counting a burst of saves to one note as a single edit, are applied when the log is folded into scores. That keeps them tunable by experiment.
- **Scores are folded from the log, per kind and unweighted.** Each event adds value 1 to the log score for its `(item, kind, half-life)`. Weights are applied when scores are read:

  ```
  L(item, h) = logsumexp over kinds k of ( ln w_k + L_k(item, h) )
  ```

  So changing a weight needs no rebuild. Changing a half-life, or a folding rule, needs a rebuild from the log, which is always possible.
- Excluded folders never appear in the log.
- Search query text is not logged.

### The change log

somememos keeps the change log itself. Agents are not asked to write changelog files. (Decided 2026-11-27, replacing the vault's rule that agents append to `logs/` by hand.)

- Every `commit` makes one **change record**: the time, the client, the notes that changed, and the message the agent gave.
- The agent supplies only what it alone knows, the reason, as the commit message: `somememos commit -m "<op> <summary>"`. The optional first word is an operation tag (`ingest`, `update`, `session`, `query`, `lint`, as the vault uses today). Further lines can give per-note reasons and sources.
- A message is expected but not required. A commit without one still works and still records what changed.
- `somememos log` shows the change log, newest first. It can be narrowed to one note (that note's history, with reasons and sources), to an operation, or to a date range. By default it hides changes that touch only `dated` files, so routine diary and todo maintenance doesn't crowd out changes to memos.
- Change records are original data. They are stored beside the event log, exported with it, and on the server each one is also the message of that change's git commit.
- Messages are indexed for search, and they are the best source of queries for the experiments (section 5).
- Because the log is no longer a note full of links, a change no longer counts twice, once as an edit and once as a mention from its log entry.

### Storage as built

Implemented in `packages/core/src/storage` (interfaces, folding, an in-memory reference) and `packages/cli/src/store` (SQLite). The table sketches below are illustrative; the code is the reference. Points that differ from the sketches:

- Notes are keyed by path. A section's id is its note's path plus its position, so ids stay the same across rebuilds.
- The term index stores each term's positions as well as its counts, which is what makes quoted phrases work.
- Change records have their own tables beside the event log.
- **Scores are combined in application code**, not with the SQL statement shown below. SQLite and Postgres would each round that statement slightly differently; doing it in core makes every store agree exactly. Scores rebuilt from the log agree with incrementally folded ones to within rounding in the last digits.
- **Renames apply by time.** An event dated at or before a rename counts toward the new name, following chains of renames. An event dated after it stays with the old name. So a late-arriving event from before the rename follows the note, while a new note that later reuses the old path starts fresh.
- Folding is safe when several processes run at once: a fold that loses the race is recomputed, never double-counted.
- Every implementation must pass one shared conformance test suite, which the Postgres implementation will also run.

### One engine for every host

The CLI, the web app and the server all run the same code (restructured 2026-11-27):

- **`packages/core/src/engine`** is the single interface a host calls: index, search, list, read a note, save, rename, delete, commit, show the change log, status, and export or import the log. Calls are serialized. Results are plain data that can cross a worker or network boundary, and a refused request raises a typed error that never names an excluded path.
- **`packages/core/src/indexing`** holds every rule about how a changed note becomes index entries and events.
- **A content store** is where note text lives: files on disk for the CLI, a table beside the event log for the browser. A note's content hash is the SHA-256 of its UTF-8 text.
- **`packages/sqlite-store`** is the one SQLite implementation of storage, written against a small synchronous driver interface. `node:sqlite` is one driver; SQLite compiled for the browser is another.
- **Saving through the engine carries the hash the edit was based on.** If the stored note has changed since, the save is refused and the current text is returned to merge against. This is the same check sync will use.
- A link or embed of a file that isn't markdown (for example `![[photo.png]]`) is ignored unless it resolves to a note.

### One-time import from git

An existing vault that has lived in git (Mike's has) carries years of history. `somememos import-git` reads that history once and writes it into the event log: an `edit` event for each commit that changed a note, and a `mention` event for each `[[link]]` a commit added, both at the commit's time, following renames. Imported events get ids derived from the commit, so running the import twice adds nothing. After the import, clients have no further use for git. When the vault moves to the server, its repository becomes the brain's version store (section 7).

### Folder roles and the default layout

A brain's config maps **roles** to path patterns. somememos works with whatever a brain declares, and a brain that declares nothing treats every file as a memo.

| Role       | Default folder | Treatment                                                                          |
|------------|----------------|------------------------------------------------------------------------------------|
| `memo`     | `memos/`       | A lasting note. Scored and searchable; what `hot`, `trending` and `neglected` show |
| `dated`    | `diary/`       | An entry for one day, with the date known from the path. Searchable and a source of mentions. Whether dated entries are scored is an experiment |
| `source`   | `sources/`     | Immutable source material. Searchable; a commit that changes one is refused        |
| `blog`     | `blog/`        | A dated post the owner can publish on the somememos website (section 8). Scored and searchable like a memo, with its date known from the path |
| `excluded` | (none)         | Never indexed, logged or shown                                                     |

- **A lasting note is called a memo**, in keeping with the name somememos. (Elsewhere in this plan, "note" means any markdown file in a brain.)
- **New brains start with `memos/`, `diary/`, `blog/` and `sources/`.** The layout is a default, not a requirement: any brain can map the roles to its own folders.
- **A dated entry's date is content, not an event time.** It is used to filter and display (for example, "what did I write last week"). The TimeScore event is still dated when the entry was actually written.
- `somememos diary` prints the path of today's dated entry, creating it if needed, so agents always write to the right place.

### What does *not* count

- **Search results and activation lists are not events.** Appearing in `search`, `hot`, `trending` or `neglected` output never adds to the log. Counting them would make popular results more popular.
- **Reads that bypass somememos are invisible.** Agents are told to read notes with `somememos read`, never `cat`.
- **Changes that arrive through sync are not new events.** The client that made an edit records it; a client that receives it does not.
- **Future-dated events are rejected.** A future event's contribution today already exceeds its full weight, and it grows the further out it is.
- **A known risk to measure:** an agent that reads what the hot list shows it feeds the hot list. The read weight experiment must check for this loop.

### Sidecar layout

Every brain is a directory of markdown files plus a `.somememos/` directory:

```
my-brain/
  notes...md
  .somememos/
    config.json     folder roles, exclusions, half-lives, weights
    events.sqlite   the event log: original data, backed up and synced
    index.sqlite    derived: keyword index, links and scores; safe to delete
```

### SQLite schema (first draft)

```sql
CREATE TABLE notes (
  id          INTEGER PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,   -- relative to brain root, '/' separators
  title       TEXT,
  content_sha TEXT NOT NULL,          -- for change detection and sync
  mtime       INTEGER NOT NULL
);

CREATE TABLE links (                  -- from [[wiki-links]]
  src_id  INTEGER NOT NULL REFERENCES notes(id),
  target  TEXT NOT NULL,              -- resolved path, or raw text if dangling
  PRIMARY KEY (src_id, target)
);

-- One row per '##' section (plus the preamble before the first heading).
CREATE TABLE sections (
  id          INTEGER PRIMARY KEY,
  note_id     INTEGER NOT NULL REFERENCES notes(id),
  heading     TEXT,
  body        TEXT NOT NULL,
  title_len   INTEGER NOT NULL,       -- field lengths in tokens, for BM25
  heading_len INTEGER NOT NULL,
  body_len    INTEGER NOT NULL
);

-- The term index: how often each term occurs in each field of each section.
CREATE TABLE postings (
  term       TEXT NOT NULL,
  section_id INTEGER NOT NULL REFERENCES sections(id),
  title_tf   INTEGER NOT NULL,
  heading_tf INTEGER NOT NULL,
  body_tf    INTEGER NOT NULL,
  PRIMARY KEY (term, section_id)
) WITHOUT ROWID;

CREATE TABLE scores (
  item       TEXT NOT NULL,           -- note path, or dangling link target
  kind       TEXT NOT NULL,           -- 'read' | 'edit' | 'mention'
  half_life  TEXT NOT NULL,           -- 'day' | 'week' | 'month' | 'year'
  log_score  REAL NOT NULL,           -- no row means no events (−∞)
  PRIMARY KEY (item, kind, half_life)
);

CREATE TABLE meta (                   -- schema version, last event folded into scores
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Those tables are all derived and, in an offline client, live in `index.sqlite`. The event log lives in `events.sqlite`. The server keeps the same tables in Postgres, with a brain id on every row (section 9). The schema uses only plain tables and ordinary SQL so it works in both databases.

```sql
CREATE TABLE events (
  seq     INTEGER PRIMARY KEY,        -- local arrival order
  id      TEXT NOT NULL UNIQUE,       -- globally unique; sync ignores an id it has seen
  item    TEXT NOT NULL,              -- note path, or dangling link target
  kind    TEXT NOT NULL,              -- 'read' | 'edit' | 'mention' | 'rename'
  time    INTEGER NOT NULL,           -- Unix seconds, when the interaction happened
  client  TEXT NOT NULL,              -- which client recorded it
  detail  TEXT                        -- for 'rename': the new path
);
```

Folding one event into the scores is a single atomic statement, following the TimeScore blog (`:e` is the event's log contribution):

```sql
INSERT INTO scores (item, kind, half_life, log_score)
VALUES (:item, :kind, :hl, :e)
ON CONFLICT (item, kind, half_life) DO UPDATE SET
  log_score = max(log_score, :e) + ln(1 + exp(-abs(log_score - :e)));
```

(`ln`/`exp` need SQLite's math functions. If the chosen driver lacks them, compute in application code inside a transaction.)

`index.sqlite` records the `seq` of the last event it folded, so folding catches up after a crash without counting an event twice. Deleting `index.sqlite` and folding the whole log again gives the same scores.

The weighted total per item is computed in application code when a query runs. A personal brain has a few thousand notes, so scanning every score is fast. A hosted service with large brains can cache the totals for the current weights.

### Export format

`somememos export` writes the event log as `events.jsonl`, one JSON record per line in time order. The markdown plus this file rebuilds the whole sidecar.

## 5. Ranking and search

- **Keyword relevance is computed in somememos's own code**, in `packages/core`, not by a database's full-text search. The server uses Postgres and offline clients use SQLite, and their built-in search engines rank differently, so relying on them would order results differently online and offline. Core tokenizes and stems the text, the database stores only a term index (which terms occur in which section, and how often), and core computes a BM25 score `r` (higher is better) with separate weights for a match in the title, the heading and the body. Ranking is therefore identical in the CLI, on the server and in the PWA, and every part of it can be tuned by experiment.
- **Combined rank key:** `ln(r) + α · L_h`, where `h` is the chosen half-life and `L_h` is the item's weighted total across event kinds (section 4). With `α = 1` this ranks by relevance × activation.
- **Keyword search only, for now.** No embeddings. Semantic search may come back later if an experiment shows keyword search misses notes that agents can't find by rephrasing (section 12).
- **Time-invariance survives.** Converting `L` to "now" subtracts the same `now · ln2 / h` from every item, so the order is the same at any time. Nothing is recomputed as the clock moves.
- Query modes:

  | Mode        | Ranks by                                       |
  |-------------|------------------------------------------------|
  | `hot`       | relevance × day or week activation             |
  | `trending`  | relevance, then `L_week − L_month`             |
  | `neglected` | relevance, then high `L_year`, low `L_month`   |
  | `all`       | keyword relevance only                         |

- **Search covers everything that is indexed**: memos, dated entries and sources. Only excluded folders are left out. The activation lists show only memos and dangling links, since those are the only scored items.
- With no keywords, each mode ranks by activation alone. That's the "what's on my mind" view an agent reads at session start.
- Results return note path, section heading, a snippet, and the score components, so a ranking can always be explained.

### Evaluation: experiments decide the scoring

No ranking parameter is chosen by intuition. `somememos eval` replays the brain's own event log, and the measured winner becomes the default.

- **Orientation cases (no keywords).** At a past moment, fold only the events before it. Does the `hot` list contain the notes that were read or edited in the following day or week? This tests activation alone, which is what an agent reads at session start. It needs only the event log, so it works for every kind of event, reads included.
- **Search cases.** A query, a time, and the notes that were the right answers. Two sources:
  - *From imported git history:* the query is a commit's message plus any changelog text it added, and the answers are the existing notes that commit changed. The keyword index is rebuilt as of the commit's parent, so the answer isn't leaked by later text.
  - *Hand-written:* a file of questions, each with the notes that answer it. Whether the vault's changelog entries are descriptive enough to skip this is an open question (section 12).
- **Metrics.** *Recall@k*: the share of right notes that appear in the top k. *MRR* (mean reciprocal rank): 1 divided by the position of the first right note, averaged over cases. These only compare setups offline. They never touch a score.
- **What gets compared:** per-kind weights, `α`, half-lives and which of them drive each mode, how bursts of edits are counted, the keyword scoring parameters (title, heading and body weights, and BM25's `k1` and `b`), link spreading (off, outgoing, backlinks; strength), and note-level vs section-level scoring.
- **Limits.** Imported history holds edits and mentions but no reads. The read weight can be measured once the log has collected reads from real use.
- **Privacy.** Evaluation cases come from private notes, and this repository is public. Nothing from a real brain may reach it:
  - Case files and per-case output are written only inside the brain's own `.somememos/` directory. `eval` refuses to write anywhere inside a somememos source checkout.
  - What may be recorded here is aggregate numbers only: a metric per parameter setting, and the number of cases. No query, path, title or name, and no example drawn from a real case.
  - Tests and documentation use a synthetic brain made by a generator script, never a sample of real notes.
  - The repo's `.gitignore` covers every sidecar file, and CI fails if a database or an event log export is committed.

### First experiment results (2026-11-27)

Run with `somememos eval` on one real vault: about seven months of history, imported from git. Only aggregate numbers are recorded here. There were 247 search cases (each commit's message as the query, the memos it changed as the answers, the index rebuilt as of the commit's parent) and 272 orientation cases (which memos have activity in the following week). MRR is mean reciprocal rank; R@10 is recall in the top ten.

| Question | Result |
|---|---|
| Does activation help search? | **Yes.** Keyword only: MRR 0.43, R@10 0.60. Keyword plus activation: MRR 0.59, R@10 0.77 |
| How strongly should activation count (`α`)? | **Less than 1.** MRR 0.51 at `α` = 2, 0.59 at 1, 0.62 at 0.5, 0.64 at 0.25 |
| Which half-life drives `hot`? | **Week** for search (MRR 0.59, against 0.57 day, 0.53 month, 0.45 year). For orientation, day has the best MRR (0.72 against 0.64) and week the best R@20 |
| Count a burst of events on one note as one? | **Yes.** With a one-hour window, orientation MRR rises from 0.64 to 0.75 and search from 0.59 to 0.61 |
| Weight of a mention against an edit | **No clear winner.** 0.5 and 1 are within noise; 0 hurts orientation (MRR 0.61 against 0.64 to 0.66); 2 is slightly worse |
| Keyword parameters | **Title weight 5 and body `b` 0.5** are best (keyword-only MRR 0.46, against 0.43 at the placeholders). `k1` makes no measurable difference |
| Link spreading | **It hurts in every form tried.** Search MRR falls from 0.59 to between 0.30 and 0.51. Stays off |

**Defaults chosen from this:** `α` 0.5, a one-hour burst window, title weight 5, body `b` 0.5, `hot` on the week half-life, mention weight 1, link spreading off. With `α` 0.5, the burst window and the keyword changes together, search MRR is 0.64 and R@10 0.81.

**How far to trust it:** this is one vault and one kind of query, the settings were chosen and measured on the same cases, and differences under about 0.02 are noise. The read weight is unmeasured, because imported history has no reads. Section-level scoring has not been tried. Rerun as real use accumulates.

### Keyword scoring details

Implemented in `packages/core/src/keyword`. The parameter values below are **placeholders until the experiments set them**.

- **Tokens:** text is lower-cased and stripped of diacritics, and a token is a run of letters and digits. `snake_case`, `kebab-case` and dotted names split at the punctuation; `camelCase` does not split. No stop words are removed.
- **Stemming:** the Porter stemmer, on by default and switchable off. An index records whether it was built with stemming, and a query must use the same setting.
- **Scoring:** BM25F over three fields, with an inverse document frequency that is never negative. Placeholder defaults: `k1` 1.2; `b` 0.5 for title and heading, 0.75 for body; field weights title 3, heading 2, body 1.
- **Queries:** a section matches when it contains any query term (an option requires all of them). Quoted phrases match consecutive words within one field, which needs term positions in the index.
- **Storage keeps counts, never scores.** Per section: the three field lengths. Per term and section: the term's frequency in each field, and its positions. Scores are computed at query time so the parameters stay tunable.

### Link resolution

Implemented in `packages/core/src/markdown`. A `[[target]]` resolves, in order, to: an exact path (with or without `.md`); a path relative to the linking note's folder; then a unique file name anywhere in the brain, case-insensitively. When several notes share the name, the one in the linking note's folder wins, then the shortest path. Anything else is a dangling link, keyed by the target trimmed, lower-cased and without `.md`. A link to a heading in the same note (`[[#heading]]`) is not a link. Only `##` headings written with hashes start a section.

## 6. Interfaces

### CLI (`somememos`)

```
somememos init [dir]                 create .somememos/ with default config
somememos search <words> [--mode hot|trending|neglected|all] [--limit N]
somememos hot | trending | neglected list notes by activation only
somememos read <path>                place the note in the working folder, print it, log a read event
somememos commit [-m msg] [paths]    send edited notes to the brain; log the edits and a change record
somememos log [path] [--op x]        show the change log, newest first
somememos status                     edited notes not yet committed; counts; config in effect
somememos diary                      print the path of today's dated entry, creating it if needed
somememos index [--rebuild]          update the derived index and scores (local mode)
somememos import-git                 one-time: write a vault's git history into the event log
somememos export                     write the event log as events.jsonl
somememos eval [--cases file]        run the ranking experiments (section 5)
```

**The agent's flow is search, read, edit, commit.**

- `search` and the activation lists only list notes: path, heading and a snippet. They place nothing and log nothing.
- `read` is the selection step. It puts the note into a **working folder** that mirrors the brain's paths (so relative links and ordinary tools work), prints it, and logs the read.
- The agent edits the file in the working folder with its ordinary text tools.
- `commit` sends each changed file together with the content hash it had when it was fetched. If that is still the brain's current version, the edit is stored and its `edit` and `mention` events are logged. If someone else changed the note meanwhile, the commit is refused for that file and the current version is saved beside it, so the agent can merge and commit again. New notes are created in the working folder and committed the same way. The `-m` message says why, and becomes the change log entry (section 4).
- **Forgotten commits.** Every command checks the working folder for files edited since they were fetched and not yet committed, and prints a reminder naming them. `status` lists them on request. Whether the client should commit them itself instead of reminding is an open question (section 12).

**Two modes, one flow.**

- *Local mode* (milestones 1 and 2): the brain's directory is on this machine and is its own working folder. `read` prints and logs; `commit` runs the index pass that finds changed files and logs their edits. Every command also runs that pass first, so a forgotten commit is picked up by the next command.
- *Remote mode* (from milestone 3): the brain is on the server. Each command is a request to the server, the working folder holds only the notes this agent has read, and a new machine needs just the CLI and a credential.

**Agents use the CLI.** It costs an agent no context until it is used, composes with other shell commands, and is the same interface Mike tests by hand. To serve agents well:

- Output is short, predictable plain text by default: one result per line with path, heading and a snippet. `--json` gives the full record, including score components.
- Exit codes are conventional (0 success, 1 error, 2 usage), and `--help` is complete enough to learn the tool from.
- The repo ships a short `AGENTS.md` snippet (and a skill) to paste into a brain: run `somememos hot` to orient, `somememos search` before grep, `somememos log` to see what changed recently, `somememos read` in place of `cat`, and `somememos commit -m` with a reason after editing.
- somememos requires no other structure from agents. There is no citation step and no handle to pass back.

### MCP server

Deferred to milestone 5, where it arrives as a remote endpoint with authentication, plus local stdio (`somememos mcp`) for clients without a shell. It is a thin adapter over the same `packages/core` functions the CLI calls: `search`, `hot`/`trending`/`neglected` and `read` (which records a read event, as in the CLI). How MCP clients write notes is settled with the edit sync design.

### Web app

**The web app is the main product for people** (decided 2026-11-27): an installable, offline-first progressive web app that works on a phone and on a desktop browser.

- **It runs on local data.** The browser holds a full copy of the brain in SQLite (compiled for the browser, running in a background worker, stored in the browser's private storage for the app). Search, ranking, the activation views, editing and saving all run on the device with no network. The server is where it syncs (section 7).
- **Editor:** a markdown *source* editor (CodeMirror 6). What the person types is stored byte for byte; the editor highlights markdown but never rewrites it. A live preview updates as they type, with `[[links]]` rendered as links and links to notes that don't exist yet shown differently.
- **Layout:** on a desktop, editor and preview sit side by side. On a phone there is one pane at a time with a toggle. Every screen is designed for a phone width first.
- **Features:** create, open, edit and save notes; keyword search in the hot, trending, neglected and keyword-only modes, with each result showing why it ranked where it did (relevance, activity at each half-life, and the split between reads, edits and mentions); the hot, trending and neglected lists and dangling links worth writing; backlinks; each note's change history.
- **Events:** opening a note logs a read, and saving logs an edit, with an optional reason for the change log. Both are recorded locally and synced later.
- **Getting notes in before a server exists:** import a folder of markdown files from the device.
- **Installable:** a web app manifest and a service worker cache the app, so it opens offline from the home screen.

## 7. Clients, sync and offline use

The server's filesystem is the home of the notes. Clients come in two shapes.

### Remote clients (the CLI for agents)

- Each command is a request to the server. Search and ranking run there, and events are logged there directly, so nothing is lost when a disposable session ends.
- The only local state is the working folder: the notes this agent has read, plus a manifest of each one's path and the content hash it had when fetched.
- A repeated `read` fetches the note again if the server has a newer version and the local file is untouched.
- Edits go back through `commit` with the base hash (section 6).

### The mutation counter

The server keeps one counter that never decreases. Every change, whether a new version of a note, a delete, a rename or a logged event, takes the next number. A client that keeps a copy remembers the last number it has seen and asks for everything after it. That makes catching up cheap however large the brain is.

### Offline copies (the PWA, and an optional `somememos clone`)

A client that must work offline holds a full local copy: the markdown, the event log, and the derived index and scores.

- **Catching up:** it asks the server for all changes after its last counter value and applies them.
- **Events: send the log, never the scores.** The client pushes the events it logged while offline. Every event has a globally unique id, and the server ignores any id it already has, so a retried push counts nothing twice. Score tables are never merged or sent; each copy derives its scores from the log. Folding is order-independent (`combine()` is commutative and associative), so every copy that holds the same events computes the same scores.
- **Edits** made offline are sent like a commit, each with its base hash.
- A change that arrives from the server is not a new event on the receiving client.

### Sync protocol (first version)

Written 2026-11-27 so the server and the app can be built against one description. It follows the rules above and adds the concrete shapes.

**One request does a whole sync.** An offline copy sends `POST /api/brains/{brain}/sync` with what it has to push and the last mutation number it has seen, and gets back everything newer.

```
request:  { since,                       // last mutation number this client has applied
            events:  [...],              // event log entries logged locally (with their ids)
            changes: [...],              // change records written locally (with their ids)
            edits:   [ { id, op: "write" | "delete" | "rename", path, to?, baseHash, text? } ] }

response: { mutation,                    // the server's counter after this request
            results: [ { id, status: "applied" | "duplicate" | "conflict", hash?, currentHash?, currentText? } ],
            notes:   [ { path, hash, text } | { path, deleted: true } | { path, renamedTo } ],
            events:  [...], changes: [...] }      // everything after `since`, from any client
```

- **Order on the server:** edits first, then events and change records, all for one brain inside one lock, so the counter and the git history agree.
- **An edit is applied only if `baseHash` matches** the note's current hash (`null` means "create; the note must not exist"). An applied edit becomes one git commit, whose message is the change record that names it, and takes the next mutation number.
- **Events and change records are deduplicated by id.** The client that made an edit logged its own `edit` and `mention` events and its change record, and pushes them. The server does not log events for edits that arrive through sync, or they would be counted twice.
- **Applying what comes back:** the client writes the returned notes into its content store and indexes them *without logging events*, appends the returned events and change records (ignoring ids it has), folds, and stores `mutation` as its new `since`.
- **A conflict never loses text.** For an edit refused as stale, the client keeps its own version as `name.conflict-<client>-<date>.md`, takes the server's version at the original path, and tells the person. A later version can offer a three-way merge using the base version from the server's git history.
- **Retries are safe.** Repeating a request whose response was lost re-sends the same ids: events and changes are duplicates, and an edit whose text already matches the stored note is reported as `duplicate`, not as a conflict.
- **A first sync** is the same request with `since: 0` from an empty copy, or, for a brain that started on the device, a push of everything it has.
- **Large brains:** the response is paged. It carries `more: true` and the client repeats with the new `since` until it is false.

**Remote clients use the engine over HTTP.** An agent's CLI in remote mode holds no copy. It calls routes that map one-to-one onto the engine (`search`, `list`, `readNote`, `saveNote`, `log`, `status`), and for those calls the *server's* engine logs the read, edit and mention events, since no client has.

**Access.** Every request carries a bearer token. The first version is a single-user server with one token set in its environment; real sign-in replaces how a token is obtained, not the protocol.

### Edits and conflicts

- Every file version is identified by its content hash. An edit arrives with the **base hash** it was made against.
- If the server's current hash equals the base, the edit applies.
- Otherwise it's a conflict, and nothing is overwritten silently. A remote client gets the commit refused, with the current version to merge against. For an offline copy, the first version keeps both, saving the incoming edit as `name.conflict-<client>-<date>.md` and surfacing it to the user. Later: a three-way merge (diff3) for non-overlapping changes, using the base version from the version history. Whether to eventually use a CRDT is an open question.
- Deletes and renames are explicit operations, so a rename doesn't look like a delete plus a new note.

### Version history: a git repository per brain

The server stores each brain as its own git repository and makes one commit for every change it accepts (a committed edit, a new note, a delete, a rename), recording which client sent it. This gives:

- **Undo and recovery** of any earlier version of a note, with ordinary git history behind it.
- **The base version** for a three-way merge, and git's own merge machinery to do it.
- **History for experiments:** the keyword index can be rebuilt as of any past commit, the same way the evaluation harness reads imported history.
- **A simple import.** An existing vault's git history becomes the brain's history when the vault moves to the server.

Git is an internal detail of the server. Clients send and receive whole notes with content hashes over the somememos protocol and never run git against the server. Local mode (milestones 1 and 2) doesn't use git either, apart from the one-time `import-git`. Full history stays on the server; offline copies hold only current versions.

## 8. Hosted service direction

- **Where users' files live:** on the server's filesystem, one git repository per brain, with a full export always available. Git is the server's storage format, not an interface: users don't push to it, and the server does not store brains in a user's GitHub repo.
- **One Postgres database for the server**, with a brain id on every row, holding the event log, change records, scores and the term index. Each brain's notes are in its own git repository on the filesystem (section 7).
- **The MCP server is likely the feature people pay for**: every agent a person uses shares one durable, time-aware memory.
- **Privacy.** The server must read plaintext to index it, so client-side encryption like git-crypt doesn't carry over. Encryption at rest, a clear data policy, and possibly a self-hosted option matter from the start. A brain holds the most sensitive text a user has.
- **Exclusions.** Folders can be excluded from indexing and scoring entirely (for example a private journal), configured in `.somememos/config.json`. The event log lists note paths in plaintext, so excluded folders must not appear there either.
- **Export:** the user's markdown plus the event log (`events.jsonl`).
- **Event log retention.** A person's reading history is sensitive. Decide at milestone 5 how long the hosted service keeps it and what control the user gets.

### Publishing a blog

Decided 2026-11-27: a brain has a `blog/` folder of dated posts that its owner can publish directly on the somememos website.

- **A post is an ordinary note** in `blog/`, with its date in the path (for example `blog/2026/2026-11-27-why-memos.md`). It is written, edited, searched and scored like any memo, in the same editor, online or offline.
- **A post is public only when its front matter says `published: true`** (decided 2026-11-27). Anything else in the blog folder is a draft and stays private, so a half-written post can't go public by accident. Removing the line, or setting it to `false`, takes the post down.
- **The editor has a publish control for blog posts.** When the open note is in the blog folder, the editor shows whether it is a draft or published, and a control that publishes or unpublishes it. The control only writes or removes the `published: true` line in the front matter, which the person can also type by hand, so the markdown stays the single record of the post's state. Publishing asks for confirmation, since it makes the post public. Until the post has synced, the editor says it is waiting to be published.
- **Publishing happens on the server**, when the post syncs. The site serves the rendered post at a public address under the owner's name, with an index of posts and a feed.
- **It is the one public part of an otherwise private brain, so the boundary has to be strict:**
  - Only files in the blog folder can ever be public. Nothing else in a brain is reachable from a public page.
  - A `[[link]]` from a post to another published post becomes a normal link. A link to anything private is shown as plain text and exposes neither the note's content nor its path. An embed of a private note is never inlined.
  - Public page views are not events and never change a score.
- **To settle before building:** the address scheme, images and other attachments in posts, a custom domain, and whether an unpublished post leaves any public trace.

## 9. Technical stack

Decided by Mike on 2026-11-26:

- **TypeScript everywhere.** Node 22+ LTS, native ESM.
- **SvelteKit for the server and the PWA client**, as one app. Server routes provide the sync API and, later, the remote MCP endpoint and accounts. The same app serves the offline-first PWA.
- **A Node-based CLI**, the `somememos` command. It is how agents use a brain (section 6). From milestone 5 it also runs the local stdio MCP server (`somememos mcp`).

### Repo layout (npm workspaces)

```
packages/core     TimeScore math, markdown chunker, link parser, ranking, evaluation metrics, sync protocol types
packages/cli      the somememos command (Node): file access, SQLite driver, the git import, later `somememos mcp`
apps/web          SvelteKit app: server routes (sync API, remote MCP, accounts) + PWA client
```

- **`packages/core` must be isomorphic.** It runs in Node (CLI and SvelteKit server) and in the browser (PWA), so it must not import Node-only modules. Storage and file access are passed in as interfaces.
- Bundlers are fine for this project: `apps/web` uses SvelteKit's standard Vite build, and `core` and `cli` may use `tsc`, Vite or another bundler, whichever is simplest.

### Details to confirm at milestone 0

- **Two databases, by role** (decided 2026-11-27): **Postgres on the server**, and **SQLite in offline clients** (the CLI's local mode, `somememos clone` and the PWA). Core defines storage interfaces in terms of operations (append an event, fold scores, read postings for a term), not SQL, with one implementation per database and one shared test suite run against both.
- **SQLite on Node (the CLI):** `node:sqlite` (built in), which keeps the CLI free of native dependencies. **Confirmed on 2026-11-27** (Node 22.23, SQLite 3.54): full-precision values, transactions, the event-fold upsert with `ln` and `exp`, WAL, a busy timeout and concurrent writers in separate processes all pass (`packages/cli/src/sqlite`). Node 22 prints an experimental warning on load, which the CLI's wrapper hides. FTS5 is present but not used.
- **SQLite in the PWA:** the official `@sqlite.org/sqlite-wasm` build, persisted to OPFS from a Web Worker. Prefer the `opfs-sahpool` VFS, which (as far as we know) doesn't need cross-origin isolation (COOP/COEP headers). FTS5 is not needed, because keyword scoring is in core.
- **PWA plumbing:** SvelteKit's built-in service worker support (`src/service-worker.ts`) for offline caching, plus a web app manifest. Add a plugin only if needed.
- **Deployment:** `@sveltejs/adapter-node` on Railway, with Railway's managed Postgres (which handles database backups) and a volume for the brains' git repositories, which need their own backup.
- **MCP:** `@modelcontextprotocol/sdk`, not needed until milestone 5.
- **CLI distribution:** bundle the CLI into one JavaScript file that needs only Node, so an agent's environment (including a cloud session's setup script) can install it in one step. This favors `node:sqlite`, which has no native dependency.
- **Tests:** Vitest, which fits SvelteKit and also works for `core` and `cli`. Playwright for PWA smoke tests, including offline behavior. The TimeScore core needs property tests: order preserved as time advances, `combine` commutative and associative, idempotent batch replay, no double-counting across sync. From milestone 3, CI runs a Postgres service and the storage tests run against both databases.
- **Versioning:** one app version in the root `package.json`, which is the single source of truth. Workspace packages are private and move in lockstep. The PWA shows the version in small text in the header, read from `package.json`. Start at `0.1.0`.

## 10. Milestones

Each milestone should leave something usable. [IMPLEMENTATION.md](IMPLEMENTATION.md) breaks each one into tasks. The order was revised on 2026-11-27 to put the web app ahead of the server, because the app works on local data and needs no server to be useful.

- **M0 — Foundations.** Done. Workspace, CI, the TimeScore math, and the checks in section 9.
- **M1 — Local CLI and evaluation.** `init`, `index`, `search`, `hot`/`trending`/`neglected`, `read`, `commit`, `log`, `status`, `diary`, `import-git`, `export` and `eval` on a brain in a local folder. Done when Mike can index his second-brain vault on one machine, import its git history, get useful hot, trending and neglected lists, and the first experiments have set the default weights.
- **M2 — Web app, local first.** The installable PWA of section 6, working entirely on data in the browser: editor with live preview, search with score breakdowns, activation views, backlinks and folder import, on phone and desktop. Done when Mike can import his vault into the app and use it offline in place of Obsidian for reading, searching and editing.
- **M3 — Server and sync.** A SvelteKit server on Railway with Postgres and one git repository per brain; the app and an optional `somememos clone` sync with it by mutation counter; single-user sign-in. Done when the same brain stays in step across a phone and a desktop.
- **M4 — Agents everywhere.** A one-file CLI build with remote mode (`search`, `read` and `commit` as requests to the server, with a working folder), the `AGENTS.md` snippet and skill, and the vault's instructions amended. Done when Mike's agents on any machine, including disposable cloud sessions, use the brain with only the CLI and a credential, and record their reasons with `somememos commit -m`.
- **M5 — Hosted multi-user and MCP.** Accounts, per-user storage, published blogs (section 8), remote MCP with authentication plus local stdio MCP, privacy policy, event log retention, and export. Launch at the somememos domain.

## 11. Dogfooding on Mike's vault

- The vault is `mckoss/2nd-brain`: lasting notes in `wiki/`, daily diaries in `diary/YYYY/MM/YYYY-MM-DD.md`, changelogs in `logs/YYYY/MM/YYYY-MM-DD.md`, immutable sources in `raw/`. Its `AGENTS.md` describes the conventions.
- **`wiki/` will be renamed `memos/`** (decided 2026-11-27), before the git history is imported. The rename rewrites links in most files, so the import must not count that one commit as an edit to every memo. The topic folders inside it (`people/`, `projects/` and so on) stay as they are, and `raw/` keeps its name, mapped to the `source` role in config.
- **Must be excluded from indexing and scoring:** `personal.encrypted/` (git-crypt-encrypted private notes) and `personal/` (legacy, local only). Their names must never appear in the event log, the index or any output.
- Roles for the vault: `memos/**` is `memo`; `diary/**`, `todo/**` and `logs/**` are `dated`; `raw/**` is `source`. Diaries and logs are mainly *sources of mention events*, not items to surface.
- The vault's `AGENTS.md` currently says "No RAG pipeline" and still describes Obsidian Sync. It will need a deliberate amendment once somememos is in use. Make that change in the vault, not here.

- The vault's `logs/` folder stops growing once agents use `somememos commit -m` (milestone 2). The existing files stay as dated notes, and their entries can seed the change log during the import.
- The vault lives in git today. Its history is imported once with `somememos import-git`. From milestone 3 the server holds the vault, and git stops being how it moves between machines.
- Agents working in the vault must read notes with `somememos read`, not `cat`, so that reads are recorded. The amended `AGENTS.md` says so.

- **Keep the vault out of this repo.** The vault is private and this repository is public. Work on the vault happens in the vault's own directory and repository. Nothing learned from its contents is written here beyond the general layout above and aggregate experiment numbers (see the privacy rules in section 5 and in `AGENTS.md`).

## 12. Open questions

Settled on 2026-11-27, and removed from this list: the primary purpose (agent memory), dangling links (in from M1), the look-ahead channel (events are dated by interaction, so calendar dates are just content), how scoring choices get made (by experiment), raw activity (an event log is kept), git (the server's version store, one repository per brain, with no git interface exposed), and the change log (kept by somememos from commit messages, not written by agents).

0. **Image and file embeds.** `![[photo.png]]` is not treated as a link to a note, so attachments don't appear as dangling items. Settled as a default on 2026-11-27; revisit if attachments need their own handling.
1. **Evaluation queries.** Changelog entries and commit messages give some usable search cases, but not all of them describe their task well enough, so a hand-written case file is also needed. How many cases are enough for a stable comparison?
2. **Ranking parameters, all to be answered by experiment:** per-kind weights, `α`, half-lives per mode, how bursts of edits count, heading vs body weight, link spreading (whether, which direction, how strong), and section-level vs note-level scoring.
3. **The read feedback loop.** Does counting agent reads make the hot list reinforce itself, and does the read weight need a guard?
4. **Semantic search.** No embeddings for now. Revisit only if experiments show keyword search missing notes that rephrasing doesn't find. If added, it is one more ranking signal (for example with sqlite-vec), with section-level vectors.
5. **Who made the event.** Should a person's read or edit count differently from an agent's? The log records the client, not whether a person or an agent was behind it.
6. **Logging search queries.** Not logged today, because scoring doesn't use them. Would they be worth keeping for building evaluation cases?
7. **Agent citations.** Should somememos ever capture which notes an agent actually used, without requiring structure from agents?
8. **Exposing git.** The server keeps each brain in git but offers no git interface. Would letting agents clone and push directly ever be worth it?
9. **Conflict handling.** After the first "keep both" version, a three-way merge or a CRDT?
10. **Event log retention for hosted users** (milestone 5).
11. **Forgotten commits.** The client reminds the agent about edited files that were never committed. Should it commit them itself instead? That saves work lost at the end of a session, but can store half-finished edits.
