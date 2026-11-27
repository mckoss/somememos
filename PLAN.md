# somememos — Plan

This is the working plan for somememos. It is self-contained: everything decided so far is written here, so a new session (human or agent) can start from this file without any earlier conversation. When a decision changes, update this file in the same change.

Task-level steps for each milestone are in [IMPLEMENTATION.md](IMPLEMENTATION.md).

Origin: a design discussion on 2026-11-26 between Mike Koss and Claude (revised 2026-11-27), also recorded in Mike's private second-brain vault (`mckoss/2nd-brain`, `wiki/ideas/timescore-working-memory.md`).

## 1. What it is

somememos is a second brain made of plain markdown files, plus a **sidecar database** that adds:

- a **keyword index** for full-text search over the notes,
- an **event log** of interactions with the notes (reads, edits, mentions), and
- **TimeScore activation scores** computed from that log, a working memory that says which notes are active now, which are heating up, and which used to matter but have gone quiet.

The notes live on the **server's filesystem**, which also keeps a version history of each note. somememos does not use git. Clients (a CLI and a web app) work on an **offline copy** and periodically **sync events and edits** to the server copy. AI agents use the brain through the **CLI** first, so all of a person's agents share one durable memory. An **MCP server** comes later, for clients without a shell and for the hosted service.

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
4. **Offline first.** Every client works fully on a local copy and syncs when it can.
5. **You own your brain.** An export is the user's markdown plus the event log as a plain-text file. Together they rebuild everything.
6. **Agents read files.** The index exists to point agents at the right files, not to replace reading them. Agents read them through `somememos read`, so each read is recorded.
7. **No git inside.** The server's filesystem is the home of the notes, and the server keeps their version history. A person may keep their own copy in git, but somememos never reads or needs it, apart from a one-time import of an existing vault's history (section 4).

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

## 4. Data model

### Items, events and kinds

- **Items are notes** (one markdown file each). Search works on **sections**; activation is scored per note. Whether to score sections too is an experiment (section 5).
- **Dangling links** (`[[links]]` to notes that don't exist yet) are items too, from M1, keyed by the link's target text. Emerging topics surface before a note exists. When the note is created, the dangling item's history carries over to it.
- **Events** are interactions with a note. There are three kinds, each recorded by the client that sees it happen:

  | Kind      | What happened                                                                  | Event time                                   |
  |-----------|--------------------------------------------------------------------------------|----------------------------------------------|
  | `read`    | The note was read through somememos (`somememos read`; later MCP and the PWA)  | when it was read                             |
  | `edit`    | The note's content changed (found by the next index pass, or saved in the PWA) | the file's modification time, at most now    |
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

### One-time import from git

An existing vault that has lived in git (Mike's has) carries years of history. `somememos import-git` reads that history once and writes it into the event log: an `edit` event for each commit that changed a note, and a `mention` event for each `[[link]]` a commit added, both at the commit's time, following renames. Imported events get ids derived from the commit, so running the import twice adds nothing. After the import, somememos has no further use for git.

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
    config.json     exclusions, half-lives, weights
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
CREATE VIRTUAL TABLE chunks USING fts5(
  path UNINDEXED, heading, body,
  tokenize = 'porter unicode61'
);

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

Those tables are all derived and live in `index.sqlite`. The event log lives in `events.sqlite`:

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

- Keyword relevance comes from FTS5 `bm25()`, which returns *lower is better*, often negative. Use `r = −bm25()`, clamped to a small positive minimum.
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

- With no keywords, each mode ranks by activation alone. That's the "what's on my mind" view an agent reads at session start.
- Results return note path, section heading, a snippet, and the score components, so a ranking can always be explained.

### Evaluation: experiments decide the scoring

No ranking parameter is chosen by intuition. `somememos eval` replays the brain's own event log, and the measured winner becomes the default.

- **Orientation cases (no keywords).** At a past moment, fold only the events before it. Does the `hot` list contain the notes that were read or edited in the following day or week? This tests activation alone, which is what an agent reads at session start. It needs only the event log, so it works for every kind of event, reads included.
- **Search cases.** A query, a time, and the notes that were the right answers. Two sources:
  - *From imported git history:* the query is a commit's message plus any changelog text it added, and the answers are the existing notes that commit changed. The keyword index is rebuilt as of the commit's parent, so the answer isn't leaked by later text.
  - *Hand-written:* a file of questions, each with the notes that answer it. Whether the vault's changelog entries are descriptive enough to skip this is an open question (section 12).
- **Metrics.** *Recall@k*: the share of right notes that appear in the top k. *MRR* (mean reciprocal rank): 1 divided by the position of the first right note, averaged over cases. These only compare setups offline. They never touch a score.
- **What gets compared:** per-kind weights, `α`, half-lives and which of them drive each mode, how bursts of edits are counted, heading vs body weight in `bm25`, link spreading (off, outgoing, backlinks; strength), and note-level vs section-level scoring.
- **Limits.** Imported history holds edits and mentions but no reads. The read weight can be measured once the log has collected reads from real use.
- **Privacy.** Evaluation cases come from private notes. Case files and per-case output stay in the brain or on the local machine. Only the harness code and aggregate results belong in this repo.

## 6. Interfaces

### CLI (`somememos`)

```
somememos init [dir]                 create .somememos/ with default config
somememos index [--rebuild]          update the keyword index, log new edits, fold events into scores
somememos search <words> [--mode hot|trending|neglected|all] [--limit N]
somememos hot | trending | neglected list notes by activation only
somememos read <path>                print a note and log a read event
somememos status                     counts, events logged, config in effect
somememos import-git                 one-time: write a vault's git history into the event log
somememos export                     write the event log as events.jsonl
somememos eval [--cases file]        run the ranking experiments (section 5)
somememos sync                       push events and edits, pull changes (milestone 3)
```

- Every command that reads the brain first runs a quick incremental `index`, so an agent never has to remember to.
- Agents edit notes with their own tools. The next index pass sees the change and logs the edit, along with any links it added.
- `index --rebuild` deletes the derived data and rebuilds it from the markdown and the event log.

**Agents use the CLI.** It costs an agent no context until it is used, composes with other shell commands, and is the same interface Mike tests by hand. To serve agents well:

- Output is short, predictable plain text by default: one result per line with path, heading and a snippet. `--json` gives the full record, including score components.
- Exit codes are conventional (0 success, 1 error, 2 usage), and `--help` is complete enough to learn the tool from.
- The repo ships a short `AGENTS.md` snippet (and a skill) to paste into a brain: run `somememos hot` to orient, `somememos search` before grep, and `somememos read` in place of `cat`.
- somememos requires no other structure from agents. There is no citation step and no handle to pass back.

### MCP server

Deferred to milestone 5, where it arrives as a remote endpoint with authentication, plus local stdio (`somememos mcp`) for clients without a shell. It is a thin adapter over the same `packages/core` functions the CLI calls: `search`, `hot`/`trending`/`neglected` and `read` (which records a read event, as in the CLI). How MCP clients write notes is settled with the edit sync design.

### Web client

An offline-first PWA (milestone 4), built in the same SvelteKit app as the server: a markdown editor with `[[wiki-links]]`, backlinks and quick search, plus hot, trending and neglected views. It installs to the home screen, works with no network, and syncs when it can. It replaces Obsidian for Mike.

## 7. Offline-first sync

Each client (CLI or web) holds a full local copy: the markdown, the event log, and the derived index and scores. It syncs periodically with the server copy. The server's filesystem is the home of the notes.

### Events: send the log, never the scores

- A client pushes the events it has logged since its last sync. Every event has a globally unique id, and the server **ignores any id it already has**. A retried or repeated push therefore counts nothing twice.
- The client pulls the events it hasn't seen (the server gives each a sequence number, and the client remembers how far it has read) and folds them into its local scores.
- **Score tables are never merged or sent.** Scores are derived from the log on each copy. Merging two score tables that share history would count that history twice.
- Folding is order-independent (`combine()` is commutative and associative), so every copy that holds the same events computes the same scores.

### Edits

- Every file version is identified by its content hash. A client uploads an edit together with the **base hash** it was made against.
- If the server's current hash equals the base, the edit applies.
- Otherwise it's a conflict. First version: keep both, saving the incoming edit as `name.conflict-<client>-<date>.md` and surfacing it to the user. Later: a three-way merge (diff3) for non-overlapping changes, using the base version from the version history. Whether to eventually use a CRDT is an open question.
- Deletes and renames sync as explicit operations, so a rename doesn't look like a delete plus a new note.
- The client that makes an edit logs its `edit` and `mention` events. Clients that receive the edit log nothing.

### Version history

The server keeps earlier versions of every note, each with its content hash and the time it was replaced. This gives:

- **Undo and recovery** of any earlier version of a note, without git.
- **The base version** for a three-way merge.
- **History for experiments:** the keyword index can be rebuilt as of a past moment.

How long versions are kept, and whether clients hold any history offline, is settled in the milestone 3 design.

## 8. Hosted service direction

- **Where users' files live:** on the server's filesystem, one directory per user, with version history kept by the server and a full export always available. The server does not store brains in git or in a user's GitHub repo.
- **One SQLite file per user** for the sidecar. It isolates users cleanly and is cheap to back up and rebuild.
- **The MCP server is likely the feature people pay for**: every agent a person uses shares one durable, time-aware memory.
- **Privacy.** The server must read plaintext to index it, so client-side encryption like git-crypt doesn't carry over. Encryption at rest, a clear data policy, and possibly a self-hosted option matter from the start. A brain holds the most sensitive text a user has.
- **Exclusions.** Folders can be excluded from indexing and scoring entirely (for example a private journal), configured in `.somememos/config.json`. The event log lists note paths in plaintext, so excluded folders must not appear there either.
- **Export:** the user's markdown plus the event log (`events.jsonl`).
- **Event log retention.** A person's reading history is sensitive. Decide at milestone 5 how long the hosted service keeps it and what control the user gets.

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

- **SQLite on Node (CLI and server):** `node:sqlite` (built in) or `better-sqlite3`. Confirm that FTS5 and the math functions (`ln`, `exp`) are available in whichever is chosen.
- **SQLite in the PWA:** the official `@sqlite.org/sqlite-wasm` build, persisted to OPFS from a Web Worker. Prefer the `opfs-sahpool` VFS, which (as far as we know) doesn't need cross-origin isolation (COOP/COEP headers). Confirm that FTS5 is included.
- **PWA plumbing:** SvelteKit's built-in service worker support (`src/service-worker.ts`) for offline caching, plus a web app manifest. Add a plugin only if needed.
- **Deployment:** `@sveltejs/adapter-node` on Railway, with a volume for per-user SQLite files and a backup strategy for them.
- **MCP:** `@modelcontextprotocol/sdk`, not needed until milestone 5.
- **CLI distribution:** bundle the CLI into one JavaScript file that needs only Node, so an agent's environment (including a cloud session's setup script) can install it in one step. This favors `node:sqlite`, which has no native dependency.
- **Tests:** Vitest, which fits SvelteKit and also works for `core` and `cli`. Playwright for PWA smoke tests, including offline behavior. The TimeScore core needs property tests: order preserved as time advances, `combine` commutative and associative, idempotent batch replay, no double-counting across sync.
- **Versioning:** one app version in the root `package.json`, which is the single source of truth. Workspace packages are private and move in lockstep. The PWA shows the version in small text in the header, read from `package.json`. Start at `0.1.0`.

## 10. Milestones

Each milestone should leave something usable. [IMPLEMENTATION.md](IMPLEMENTATION.md) breaks each one into tasks.

- **M0 — Foundations.** npm workspace scaffold (`packages/core`, `packages/cli`, and a skeleton SvelteKit `apps/web` that shows the version), CI (lint, type-check, tests), `packages/core` with the TimeScore functions and property tests checked against the blog post. Confirm the details in section 9.
- **M1 — Local CLI and evaluation.** `init`, `index` (keyword index, edit detection, folding), `search`, `hot`/`trending`/`neglected`, `read`, `status`, `import-git`, `export`, and `eval`. Done when Mike can index his second-brain vault on one machine, import its git history, get useful hot, trending and neglected lists, and the first experiments have set the default weights.
- **M2 — Agent use on one machine.** A one-file CLI build, the `AGENTS.md` snippet and skill, and the vault's instructions amended. Done when Mike's agents on his main machine (Claude Code and Hermes, both of which have a shell) use `somememos hot`, `search` and `read` in place of grep and `cat`, replacing the vault's `rg "^## " logs | tail -40` step.
- **M3 — Server and sync.** Single-user SvelteKit server on Railway that holds the notes on its filesystem with version history: event sync by unique id, edit sync with base hashes and conflict files. The CLI syncs. Done when agents on any machine, including disposable cloud sessions, get the brain with `somememos sync` and their events reach the server, with no git involved.
- **M4 — PWA client.** Offline-first SvelteKit PWA with an editor, `[[wiki-links]]`, backlinks, search, and activation views, syncing through the same protocol as the CLI. Version shown in the header. Done when Mike can stop using Obsidian entirely.
- **M5 — Hosted multi-user and MCP.** Accounts, per-user storage, remote MCP with authentication plus local stdio MCP, privacy policy, event log retention, and export. Launch at the somememos domain.

## 11. Dogfooding on Mike's vault

- The vault is `mckoss/2nd-brain`: wiki notes in `wiki/`, daily diaries in `diary/YYYY/MM/YYYY-MM-DD.md`, changelogs in `logs/YYYY/MM/YYYY-MM-DD.md`, immutable sources in `raw/`. Its `AGENTS.md` describes the conventions.
- **Must be excluded from indexing and scoring:** `personal.encrypted/` (git-crypt-encrypted private notes) and `personal/` (legacy, local only). Their names must never appear in the event log, the index or any output.
- Likely scored items: `wiki/**` notes. Diaries and logs are mainly *sources of mention events*, not items to surface.
- The vault's `AGENTS.md` currently says "No RAG pipeline" and still describes Obsidian Sync. It will need a deliberate amendment once somememos is in use. Make that change in the vault, not here.

- The vault lives in git today. Its history is imported once with `somememos import-git`. From milestone 3 the server holds the vault, and git stops being how it moves between machines.
- Agents working in the vault must read notes with `somememos read`, not `cat`, so that reads are recorded. The amended `AGENTS.md` says so.

## 12. Open questions

Settled on 2026-11-27, and removed from this list: the primary purpose (agent memory), dangling links (in from M1), the look-ahead channel (events are dated by interaction, so calendar dates are just content), how scoring choices get made (by experiment), raw activity (an event log is kept), and git (not used, apart from a one-time import).

1. **Evaluation queries.** Are the vault's changelog entries and commit messages descriptive enough to serve as search cases, or is a hand-written case file needed from the start?
2. **Ranking parameters, all to be answered by experiment:** per-kind weights, `α`, half-lives per mode, how bursts of edits count, heading vs body weight, link spreading (whether, which direction, how strong), and section-level vs note-level scoring.
3. **The read feedback loop.** Does counting agent reads make the hot list reinforce itself, and does the read weight need a guard?
4. **Semantic search.** No embeddings for now. Revisit only if experiments show keyword search missing notes that rephrasing doesn't find. If added, it is one more ranking signal (for example with sqlite-vec), with section-level vectors.
5. **Who made the event.** Should a person's read or edit count differently from an agent's? The log records the client, not whether a person or an agent was behind it.
6. **Logging search queries.** Not logged today, because scoring doesn't use them. Would they be worth keeping for building evaluation cases?
7. **Agent citations.** Should somememos ever capture which notes an agent actually used, without requiring structure from agents?
8. **Version history.** How long the server keeps old versions, and whether clients hold any history offline (milestone 3).
9. **Conflict handling.** After the first "keep both" version, a three-way merge or a CRDT?
10. **Event log retention for hosted users** (milestone 5).
