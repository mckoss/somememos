# somememos — Plan

This is the working plan for somememos. It is self-contained: everything decided so far is written here, so a new session (human or agent) can start from this file without any earlier conversation. When a decision changes, update this file in the same change.

Origin: a design discussion on 2026-11-26 between Mike Koss and Claude, also recorded in Mike's private second-brain vault (`mckoss/2nd-brain`, `wiki/ideas/timescore-working-memory.md`).

## 1. What it is

somememos is a second brain made of plain markdown files, plus a **sidecar database** that adds:

- a **keyword index** for full-text search over the notes, and
- **TimeScore activation scores**, a working memory that says which notes are active now, which are heating up, and which used to matter but have gone quiet.

Clients (a CLI and a web app) work on an **offline copy** and periodically **sync events and edits** to the server copy. An **MCP server** lets AI agents search, read and write a user's brain, so all their agents share one durable memory.

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
   - The **keyword index** is derived purely from the markdown. It can be deleted and rebuilt at any time and is never committed.
   - The **TimeScore state** is original information. The most useful signals (what a person read or asked about, which note answered a question) never appear in the files, and log scores discard individual events by design. This state cannot be rebuilt from the markdown, so it must be backed up and exported.
3. **Never store raw activity.** No stored search queries, no reading history. Events fold into scores immediately, and only the scores persist. This is a privacy feature.
4. **Offline first.** Every client works fully on a local copy and syncs when it can.
5. **You own your brain.** An export is the user's markdown plus a plain-text scores file. Together they rebuild everything.
6. **Agents read files.** The index exists to point agents at the right files, not to replace reading them.

## 3. TimeScore: the algorithm

TimeScore is Mike's algorithm (public domain, credit requested: "TimeScore algorithm courtesy Mike Koss"). Mike holds US Patent 8,140,541 on it and has said he won't enforce it. Reference material: <https://mckoss.com/posts/timescore/> and <https://github.com/mckoss/timescore-demos> (`site/timescore.js`, `collect/timescore.py`). The demo code is MIT-licensed; somememos carries its own implementation under Apache 2.0.

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

## 4. Data model

### Items, events and weights

- **Items are notes** (one markdown file each). Search works on **sections**; activation is scored per note.
- **Dangling links** (`[[links]]` to notes that don't exist yet) may also be scored, so emerging topics surface before a note exists. This is optional and can wait for a later milestone.
- **Events** are activity on a note. Starting weights (tunable):

  | Event                                         | Weight |
  |-----------------------------------------------|--------|
  | A person edits a note                         | 3      |
  | A person opens/reads a note                   | 1      |
  | An agent cites a note in an answer            | 1      |
  | An agent makes a substantive edit             | 1      |
  | A note is mentioned in a dated diary/log note | 0.5    |

- **Spreading activation.** When a note receives an event of value `s`, each note it links to also receives an event of `0.2 · s`. One hop only, to keep it cheap and predictable. Whether backlinks also spread is an open question.

### What does *not* count

- **Search results are not events.** Counting them would make popular results more popular.
- **Agent reads are not events** unless the agent cites the note as used in an answer. Otherwise an agent that works from the hot list feeds the hot list.
- **Future-dated events are rejected.** A future event's contribution today already exceeds its full weight, and it grows the further out it is. Deadlines and calendar items need a separate look-ahead channel (section 12).

### Sidecar layout

Every brain is a directory of markdown files plus a `.somememos/` directory:

```
my-brain/
  notes...md
  .somememos/
    config.json     committed: exclusions, half-lives, weights
    scores.tsv      committed: snapshot of TimeScore state (the part that can't be rebuilt)
    index.sqlite    gitignored: rebuildable keyword index and live scores
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
CREATE VIRTUAL TABLE chunks USING fts5(
  path UNINDEXED, heading, body,
  tokenize = 'porter unicode61'
);

CREATE TABLE scores (
  item       TEXT NOT NULL,           -- note path (or dangling link target)
  half_life  TEXT NOT NULL,           -- 'day' | 'week' | 'month' | 'year'
  log_score  REAL,                    -- NULL means no events (−∞)
  PRIMARY KEY (item, half_life)
);
CREATE INDEX scores_rank ON scores (half_life, log_score DESC);
```

The update for one event is a single atomic statement, as in the TimeScore blog:

```sql
UPDATE scores SET log_score = CASE
  WHEN log_score IS NULL THEN :e
  ELSE max(log_score, :e) + ln(1 + exp(-abs(log_score - :e)))
END
WHERE item = :item AND half_life = :hl;
```

(`ln`/`exp` need SQLite's math functions. If the chosen driver lacks them, compute in application code inside a transaction.)

### `scores.tsv` snapshot format

```
# somememos scores v1
# epoch=unix-seconds half_lives=day:86400,week:604800,month:2592000,year:31536000
item	day	week	month	year
wiki/projects/timescore.md	14321.53	2046.82	477.31	39.28
```

- An empty cell means no events (−∞).
- Rows are sorted by path, so git diffs stay readable.
- Markdown plus this file rebuilds the whole sidecar, losing only activity since the last snapshot.
- **Only one writer owns the snapshot**: the server, or for a brain with no server, a single designated machine. See section 7 for why.

## 5. Ranking and search

- Keyword relevance comes from FTS5 `bm25()`, which returns *lower is better*, often negative. Use `r = −bm25()`, clamped to a small positive minimum.
- **Combined rank key:** `ln(r) + α · L_h`, where `h` is the chosen half-life. With `α = 1` this ranks by relevance × activation.
- **Time-invariance survives.** Converting `L` to "now" subtracts the same `now · ln2 / h` from every item, so the order is the same at any time. Nothing is recomputed as the clock moves.
- Query modes:

  | Mode        | Ranks by                                       |
  |-------------|------------------------------------------------|
  | `hot`       | relevance × day or week activation             |
  | `trending`  | relevance, then `L_week − L_month`             |
  | `neglected` | relevance, then high `L_year`, low `L_month`   |
  | `all`       | keyword relevance only                         |

- With no keywords, each mode ranks by activation alone. That's the "what's on my mind" view an agent reads at session start.
- Results return note path, section heading, a snippet, and the score components, so a ranking can always be explained.

## 6. Interfaces

### CLI (`somememos`)

```
somememos init [dir]                 create .somememos/ with default config
somememos index [--rebuild]          sync the keyword index with the markdown
somememos search <words> [--mode hot|trending|neglected|all] [--limit N] [--json]
somememos hot | trending | neglected list notes by activation only
somememos event <path> <kind>        record an event (e.g. read, edit, cite)
somememos bootstrap --from-git       seed scores from git history (see below)
somememos snapshot                   write .somememos/scores.tsv
somememos sync                       push events and edits, pull changes (milestone 3)
```

**Bootstrap from git.** A new brain has no activation history. `bootstrap --from-git` replays `git log` and records an *edit* event for every commit that touched a note, at the commit's timestamp, plus *mention* events for notes linked from dated diary or log notes (such as `diary/YYYY/MM/YYYY-MM-DD.md`). Run it once at setup; it must not double-count if run again.

### MCP server

A local stdio server first, later remote over HTTP with authentication. Tools:

- `search(query, mode?, limit?)`
- `hot(limit?)`, `trending(limit?)`, `neglected(limit?)`
- `read(path)`: returns the whole file, without recording an event
- `write(path, content)` or a structured `edit`: records an agent edit event
- `cite(paths[])`: the agent records that it used these notes in an answer

### Web client

An offline-first web app (milestone 4): a markdown editor with `[[wiki-links]]`, backlinks and quick search, plus hot, trending and neglected views. It replaces Obsidian for Mike.

## 7. Offline-first sync

Each client (CLI or web) holds a full local copy: the markdown, the sidecar index, and its view of the scores. It syncs periodically with the server copy.

### Scores: send only deltas

`combine()` adds activation. Merging two copies that share history counts that history twice. So:

- Each client keeps a **pending delta**: a per-item, per-half-life log score that starts at −∞ and accumulates only the events recorded locally since the last successful sync.
- The client's local view is `combine(canonical_as_of_last_sync, pending_delta)`.
- On sync, the client sends its pending deltas as a batch tagged `(client_id, batch_seq)`. The server folds them into the canonical scores with `combine()`. The server is **idempotent**: it ignores a batch whose `(client_id, batch_seq)` it has already applied. That guarantees exactly-once counting despite retries.
- The client then pulls the canonical scores and resets its pending deltas to −∞.
- Deltas, not raw events, cross the wire, so no query text or reading timeline ever leaves the device. The tradeoff is that the server can't re-weight past events. That's acceptable, and consistent with principle 3.

### Edits

- Every file version is identified by its content hash. A client uploads an edit together with the **base hash** it was made against.
- If the server's current hash equals the base, the edit applies.
- Otherwise it's a conflict. First version: keep both, saving the incoming edit as `name.conflict-<client>-<date>.md` and surfacing it to the user. Later: a three-way merge (diff3) for non-overlapping changes. Whether to eventually use a CRDT is an open question.
- Deletes and renames sync as explicit operations, so a rename doesn't look like a delete plus a new note.

### Single owner of the snapshot

The server writes `scores.tsv` and owns the canonical scores. Clients never commit their own snapshot of combined scores, because two snapshots merged in git would double-count shared history.

## 8. Hosted service direction

- **Where users' files live:** either the user's own GitHub repo (files stay theirs and git serves as backup, with the server committing on their behalf) or hosted storage with export (simpler for non-technical users, weaker ownership). Support hosted storage first; offer GitHub-repo storage as an option.
- **One SQLite file per user** for the sidecar. It isolates users cleanly and is cheap to back up and rebuild.
- **The MCP server is likely the feature people pay for**: every agent a person uses shares one durable, time-aware memory.
- **Privacy.** The server must read plaintext to index it, so client-side encryption like git-crypt doesn't carry over. Encryption at rest, a clear data policy, and possibly a self-hosted option matter from the start. A brain holds the most sensitive text a user has.
- **Exclusions.** Folders can be excluded from indexing and scoring entirely (for example a private journal), configured in `.somememos/config.json`. Score files list note paths in plaintext, so excluded folders must not appear there either.
- **Export:** the user's markdown plus `scores.tsv`.

## 9. Proposed technical stack

To confirm at milestone 0. It follows Mike's existing projects: Node, native ESM without bundlers, SQLite, Railway.

- **Language:** TypeScript, compiled with `tsc` only (no bundler). Node 22+ LTS, native ESM.
- **Repo layout:** npm workspaces.
  ```
  packages/core     TimeScore math, markdown chunker, link parser, ranking, sync protocol types
  packages/cli      the somememos command
  packages/mcp      MCP server (uses @modelcontextprotocol/sdk)
  packages/server   sync + hosting API
  packages/web      offline-first web client
  ```
- **SQLite on Node:** `node:sqlite` (built in) or `better-sqlite3`. Choose one at milestone 0 and confirm that FTS5 and the math functions (`ln`, `exp`) are available.
- **SQLite in the browser:** the official `@sqlite.org/sqlite-wasm` build with OPFS persistence. Confirm FTS5 is included.
- **Server:** a small HTTP framework (Express, which Mike already uses, or Hono). Hosted on Railway with a volume for per-user SQLite files, plus a backup strategy for those files.
- **Tests:** `node:test` or Vitest. The TimeScore core needs property tests: order preserved as time advances, `combine` commutative and associative, idempotent batch replay, no double-counting across sync.
- **Versioning:** one app version in the root `package.json`, which is the single source of truth. Workspace packages are private and move in lockstep. The web UI shows the version in small text in the header. Start at `0.1.0`.

## 10. Milestones

Each milestone should leave something usable.

- **M0 — Foundations.** npm workspace scaffold, CI (lint, type-check, tests), `packages/core` with the TimeScore functions and property tests. Confirm the SQLite driver choices (section 9).
- **M1 — Local CLI.** `init`, `index`, `search`, `hot`/`trending`/`neglected`, `event`, `snapshot`, `bootstrap --from-git`. Done when Mike can index his second-brain vault, seed it from git history, and get useful hot, trending and neglected lists.
- **M2 — MCP server, local.** stdio MCP with search/read/write/cite. Done when Mike's agents (Claude Code and Hermes) use it on the second brain instead of grep for orientation, ideally replacing the vault's `rg "^## " logs | tail -40` step.
- **M3 — Server and sync.** Single-user server on Railway: delta score sync with idempotent batches, edit sync with base hashes and conflict files, server-owned snapshot. The CLI syncs.
- **M4 — Web client.** Offline-first PWA with an editor, `[[wiki-links]]`, backlinks, search, and activation views. Version shown in the header. Done when Mike can stop using Obsidian entirely.
- **M5 — Hosted multi-user.** Accounts, per-user SQLite, remote MCP with authentication, privacy policy, export, and optional GitHub-repo storage. Launch at the somememos domain.

## 11. Dogfooding on Mike's vault

- The vault is `mckoss/2nd-brain`: wiki notes in `wiki/`, daily diaries in `diary/YYYY/MM/YYYY-MM-DD.md`, changelogs in `logs/YYYY/MM/YYYY-MM-DD.md`, immutable sources in `raw/`. Its `AGENTS.md` describes the conventions.
- **Must be excluded from indexing and scoring:** `personal.encrypted/` (git-crypt-encrypted private notes) and `personal/` (legacy, local only). Their names must never appear in a scores file.
- Likely scored items: `wiki/**` notes. Diaries and logs are mainly *sources of mention events*, not items to surface.
- The vault's `AGENTS.md` currently says "No RAG pipeline" and still describes Obsidian Sync. It will need a deliberate amendment once somememos is in use. Make that change in the vault, not here.

## 12. Open questions

1. **Primary purpose.** Is it mainly to prime agents, or to show the person what they're neglecting? The weights and default views would differ. Likely both, but pick a default.
2. **Conflict handling.** After the first "keep both" version, a three-way merge or a CRDT?
3. **Backlink spreading.** Should activation also spread to notes that link *to* the active note?
4. **Dangling links as items.** In from M1, or later?
5. **Look-ahead channel.** How should deadlines and calendar items surface, given that they can't be TimeScore events?
6. **Embeddings.** Add semantic search later as one more ranking signal (for example with sqlite-vec)?
7. **Storage default for hosted users.** Hosted storage first, or the user's GitHub repo first?
8. **Section-level scores.** Would scoring sections as well as notes be worth the extra state?
