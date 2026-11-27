# somememos — Implementation plan

This file breaks the milestones in [PLAN.md](PLAN.md) section 10 into tasks. PLAN.md holds the design and the reasons; this file holds the order of work and what "done" means for each step. Tick tasks off as they land, and keep the two files consistent.

Milestones 0 to 2 are planned in detail. Milestones 3 to 5 are outlines, and each starts with a design review, because experiments and dogfooding in the earlier milestones will change them.

Conventions for every task:

- **No personal data.** Nothing from a real brain goes into this repo, a commit message or a PR. See the first ground rule in `AGENTS.md`.
- TypeScript, native ESM, tests in Vitest next to the code (`*.test.ts`).
- `packages/core` never imports a Node-only module. It receives the database, the clock and file access as interfaces.
- One PR per task or small group of tasks, each raising the root `package.json` version once.

## M0 — Foundations

Goal: an empty but working workspace, with the TimeScore math proven correct.

- [x] **0.1 Workspace scaffold.** Root `package.json` (private, version `0.1.0`, npm workspaces), `tsconfig.base.json`, ESLint and Prettier, `.gitignore`, Node version pinned in `engines` and `.nvmrc`.
- [x] **0.1a Privacy guards.** `.gitignore` covers `.somememos/`, `*.sqlite` and `events.jsonl`. A CI step fails if any such file, or any file over a small size limit outside known source folders, is committed.
- [x] **0.1b Synthetic brain.** A seeded generator script that builds an invented brain (memos, dated entries, sources, links, a git history with renames) for tests, examples and documentation.
- [x] **0.2 `packages/core` skeleton.** Builds with `tsc` to ESM. Exports a `VERSION` read from the root `package.json` at build time.
- [x] **0.3 TimeScore functions.** Read the blog post first (PLAN.md section 3). Implement `eventScore`, `combine`, `addEvent`, `scoreAt`, the half-life table, and `weightedTotal(scoresByKind, weights)`.
  - Unit tests against worked values from the post and its demo code.
  - Property tests (fast-check): `combine` is commutative and associative within tolerance; order is unchanged as `now` advances; two simultaneous events of value 1 add `ln 2`; weighting at read time equals weighting at record time; a future-dated event is rejected.
- [x] **0.4 `packages/cli` skeleton.** A `somememos` binary with `--version` and `--help`, using an argument parser with no heavy dependencies (`node:util` `parseArgs` unless it proves too limited).
- [x] **0.5 `apps/web` skeleton.** SvelteKit with `adapter-node`, one page whose header shows the version from the root `package.json`.
- [x] **0.6 CI.** A GitHub Actions workflow that runs lint, type-check, tests and the web build on every PR and on `main`.
- [x] **0.7 Confirm `node:sqlite`.** A test suite that checks what the CLI's local store needs from the built-in `node:sqlite`: typed values at full precision, transactions, `INSERT … ON CONFLICT` with the `ln` and `exp` functions, WAL mode, a busy timeout, and concurrent writers in separate processes. Record the result in PLAN.md section 9. FTS5 is not required.
- [x] **0.8 Storage interfaces.** Define storage interfaces in core as operations (event log, scores, notes and links, term index), not SQL, so SQLite and Postgres can each implement them. Implement them for SQLite in the CLI, with a shared test suite that a Postgres implementation will also have to pass in M3.
- [x] **0.9 Keyword scoring (core).** Tokenizer, Porter stemmer, BM25 with title, heading and body weights, an in-memory reference index, and snippets. All parameters are tunable placeholders until the experiments set them.

Done when: CI is green, `npx somememos --version` prints `0.1.0`, the web skeleton shows the same version, and PLAN.md section 9 records the SQLite decision.

## M1 — Local CLI and evaluation

Goal: on one machine, Mike indexes his vault, imports its git history, gets useful activation lists, and the first experiments set the default weights.

### Event log and scores

- [x] **1.1 Config.** `.somememos/config.json` with folder roles (`memo`, `dated`, `source`, `excluded`) as path patterns, with every file a `memo` when none are declared, half-lives, per-kind weights and `α`. `somememos init` writes defaults and a client id. Excluded paths must never reach the event log, the index, the scores or any CLI output; test that explicitly.
- [x] **1.2 Event log.** `events.sqlite` with the `events` table from PLAN.md section 4. An `appendEvent` function in core that assigns a unique id (a random UUID for live events), rejects future-dated events, and is idempotent on id.
- [x] **1.3 Folding (core).** Fold events after a stored cursor into per-kind scores in `index.sqlite`, cursor and scores in one transaction. Apply rename records by moving an item's scores. A full refold after deleting `index.sqlite` must give the same scores as incremental folding; property-test that with random event sequences, including renames.
- [x] **1.4 Schema versions.** (Done as far as it can be: no older schema exists yet, so an event log mismatch stops with a "migration required" error and changes nothing.) A `schema_version` in each database. A mismatch in `index.sqlite` triggers a rebuild. A mismatch in `events.sqlite` runs an explicit migration and never drops data.

### Indexing

- [x] **1.5 Markdown chunker (core).** Split a note into a preamble plus one chunk per `##` heading. Extract the title (front matter `title`, else first `#` heading, else file name). Ignore headings inside code fences.
- [x] **1.6 Link parser (core).** Find `[[target]]`, `[[target|alias]]` and `[[target#heading]]`, skipping code fences and inline code. Resolve targets to paths with the vault's rules (read the vault's `AGENTS.md` for its link conventions before fixing these); unresolved targets are dangling links keyed by their normalized text.
- [x] **1.7 Keyword indexing.** `somememos index` scans the working tree (path, size, mtime, then content hash for changed files) and updates the `notes`, `links`, `sections` and `postings` tables, using core's tokenizer. `--rebuild` deletes `index.sqlite` first.
- [x] **1.8 Edit detection.** During the scan, for each scored note whose content hash changed since the last pass: log an `edit` event at the file's modification time (at most now), and a `mention` event for each link target in the new version that the old version lacked. A new file counts as an edit. The very first index of a brain logs nothing, since nothing is known to have changed.
- [x] **1.9 Renames and dangling links.** A path that disappears while a new path appears with the same content hash is a rename: log a rename record instead of an edit. When a new note resolves a dangling target, log a rename from the dangling key to the note's path.
  - Tests use small fixture directories: an edit, a rename, a rename with an edit (treated as delete plus new note; document that), a note created after being linked, an excluded folder, and a second `index` run that must log nothing.
- [x] **1.10 Auto-index.** Every command that reads the brain runs the incremental index and fold first. It must be fast when nothing changed (target: under 100 ms on Mike's vault). `--no-index` skips it.

### Git import

- [x] **1.11 `import-git`.** Read the whole history with one `git log` call (`--name-status -M`, author time, patch for added lines). For each commit: an `edit` event per changed scored note and a `mention` event per `[[link]]` added, at the commit's author time, with rename records for renames. An `--ignore-commit` option skips named commits as events while still following their renames, for mass rewrites such as the vault's `wiki/` to `memos/` rename. Event ids are a hash of commit, path, kind and target, so a second run adds nothing. Stop at the moment the brain was first indexed, so a commit and its live-detected edit are never both counted.
  - Tests build fixture repos in a temp directory: a rename, a merge commit, a note linked before it existed, an excluded folder, and a repeated import.

### Querying

- [x] **1.12 Ranking (core).** Given candidate items, their per-kind scores, weights, `α`, a half-life and a mode, return ranked results with the score components. Pure functions with no database access, so the evaluation harness can call them with any parameters.
- [ ] **1.13 `search`.** Core's keyword scoring over the stored term index gives a relevance `r` per section, combined with activation and grouped so a note appears once with its best section. Modes `hot`, `trending`, `neglected`, `all`.
- [ ] **1.14 `hot`, `trending`, `neglected`.** Activation-only lists, including dangling links, marked as such.
- [ ] **1.15 `read` and `commit`.** `read` prints the note and logs a `read` event at the current time. It refuses excluded paths, and reading a note that isn't a scored item prints it and logs nothing. `commit [-m message]` runs the index pass, so its edits are logged at once, and writes one change record (time, client, changed notes, message) beside the event log; it exists in local mode so agents follow the same search, read, edit, commit flow they will use against the server.
- [ ] **1.16 Output.** Plain text by default: one result per line (path, heading, snippet), stable across runs. `--json` gives full records with score components. Exit codes 0, 1 and 2. Complete `--help` for every command.
- [ ] **1.16a Roles and `diary`.** Only `memo` files are scored items. A `dated` pattern yields the entry's date from its path, and `search` accepts `--since` and `--until` on it. A changed `source` file is reported, not logged as an edit. `somememos diary` prints today's entry path, creating the file if needed. `somememos init` in an empty directory creates `memos/`, `diary/` and `sources/`.
- [ ] **1.16b `log`.** Show change records newest first, as plain text or `--json`. Filters: a note path, `--op`, `--since` and `--until`, and `--all` to include changes that touch only `dated` files. Changes found by the index pass without a `commit` appear with no message. Index messages for `search`. `import-git` also writes a change record per imported commit, using the commit message.
- [ ] **1.17 `status` and `export`.** `status` shows note and section counts, events by kind, and the weights in effect. `export` writes `events.jsonl`, change records included; a round-trip test imports it into an empty brain and compares scores.
- [ ] **1.18 Concurrency.** WAL mode and a busy timeout on both databases, so several agents can run commands at once. A test runs parallel `read` commands and checks that no event is lost or folded twice.

### Evaluation

- [x] **1.19 Metrics (core).** Recall@k and MRR, with unit tests on hand-computed cases.
- [x] **1.20 Replay (core).** Fold the event log up to a given time into in-memory scores, with the weights, half-lives and folding rules of one experiment setting. This is the same folding code as 1.3, given different parameters.
- [ ] **1.21 Case builders.**
  - Orientation cases: at a sampled time, the answers are the notes with events in the following day and week.
  - Search cases from imported git history: for a sampled commit, the query is its message plus any changelog text it added; the answers are the scored notes it changed that already existed. The keyword index is built from the parent commit's tree (`git ls-tree` plus `git cat-file --batch`, in an in-memory database), with no working-tree checkout.
  - Hand-written cases: a JSONL file of `{query, time?, answers}` kept in the brain.
- [ ] **1.22 `somememos eval`.** Run a named set of parameter settings over the cases and print a table of recall@k and MRR per setting, with a `--json` form. Sampling is seeded so runs repeat. Per-case detail is shown only on request, written only inside the brain's `.somememos/` directory, and refused if the target is inside a somememos source checkout. The default report is aggregate numbers that are safe to paste into this repo.
- [ ] **1.22a Prepare the vault.** In `mckoss/2nd-brain` (not here), before the first import: rename `wiki/` to `memos/` and rewrite the links and instructions that name it, in one commit; add `.somememos/config.json` with the roles and exclusions; ignore the two database files in git. Then run `import-git`, ignoring the rename commit.
- [ ] **1.23 First experiments on Mike's vault.** Run in the vault's own directory, in this order, and record only the aggregate numbers and the chosen defaults in PLAN.md (no queries, paths, titles or examples):
  1. Check the search cases. Read a sample of generated cases to see whether they describe their tasks. If they don't, write 30 to 50 cases by hand first.
  2. Baseline: keyword only (`all` mode) vs keyword plus activation.
  3. `edit` and `mention` weights, and `α`.
  4. Half-lives, and which of them (or what mix) drives `hot`, on orientation cases.
  5. How bursts of edits to one note should count.
  6. Keyword scoring parameters: title, heading and body weights, `k1` and `b`, and stemming on or off.
  7. Link spreading: off, outgoing, backlinks, at a few strengths.
  8. Section-level edit attribution (from diffs in the imported history) vs note-level.

  The read weight can't be measured yet, because imported history holds no reads. It stays at the placeholder until M2 has collected some.

Done when: `somememos index` and `import-git` run cleanly on the vault with the private folders absent from the event log and every output, the three activation lists look right to Mike, and PLAN.md records the first experiment results with the defaults they chose.

## M2 — Web app, local first

Goal: the installable PWA of PLAN.md section 6, working entirely on data in the browser, on phone and desktop.

- [ ] **2.0 Shared packages.** Move the SQLite store out of the CLI into a package with a small driver interface (one driver for `node:sqlite`, one for SQLite in the browser), and move the "a note changed: update the index and log events" logic into core, so the CLI, the browser and the server use one copy.
- [ ] **2.1 In-browser storage.** The storage interfaces on SQLite compiled for the browser, in a background worker with persistent storage, passing the shared conformance suite in a real browser. Note bodies are stored locally too.
- [ ] **2.2 Brain engine in the worker.** Indexing, folding, ranking and search run in the worker behind a small request interface the pages call.
- [ ] **2.3 Editor.** CodeMirror 6 source editor that stores exactly what was typed, with a live preview, `[[link]]` autocomplete, and create, save and rename. Side by side on desktop, one pane with a toggle on a phone.
- [ ] **2.3a Blog posts.** The `blog` folder role in core and the app. In the editor, a note in the blog folder shows a draft or published badge and a control that sets or removes `published: true` in its front matter, with a confirmation before publishing.
- [ ] **2.4 Search and activation views.** The four modes, results with score breakdowns, the hot, trending and neglected lists, and dangling links.
- [ ] **2.5 Note view.** Rendered markdown, backlinks, and the note's change history. Opening a note logs a read.
- [ ] **2.6 Folder import.** Bring a folder of markdown files into the app from the device, honoring roles and exclusions.
- [ ] **2.7 Installable and offline.** Manifest, service worker, and an update prompt when a new version is available. The header shows the version.
- [ ] **2.8 Browser tests.** Playwright at phone and desktop sizes: import, search, edit, reload, and use with the network off.

Done when Mike can import his vault into the app and use it offline for reading, searching and editing.

## M3 — Server and sync (outline)

- [ ] **3.0 Design review.** Settle the sync request API, single-user sign-in, how commits are attributed, and how an existing vault's repository becomes the server's. Update PLAN.md section 7 before coding.
- [ ] **3.1 Postgres storage.** Implement core's storage interfaces for Postgres, with a brain id on every row, and run the shared conformance suite against it in CI with a Postgres service.
- [ ] **3.2 Server storage.** One git repository per brain on the server's filesystem, with one commit per accepted change, and one mutation counter that numbers every change.
- [ ] **3.3 Sync API.** Catch up by mutation counter; push events (ids the server has are ignored) and edits with base hashes; refuse a stale base and return the current version.
- [ ] **3.4 Sync in the app,** with conflict files, and in `somememos clone`.
- [ ] **3.5 Property tests.** Repeated pushes count nothing twice, and any interleaving of clients ends with the same events and scores everywhere.
- [ ] **3.6 Version history.** List a note's versions and restore one, as a new commit.
- [ ] **3.7 Deploy.** Railway with `adapter-node`, managed Postgres, a volume for the git repositories with its own backup, and a health endpoint that reports the version.

## M4 — Agents everywhere (outline)

- [ ] **4.1 One-file CLI build** and a one-line install.
- [ ] **4.2 Remote mode.** `search`, the activation lists, `read`, `commit` and `log` as requests to the server, with a working folder and a reminder about uncommitted edits.
- [ ] **4.3 Agent instructions.** An `AGENTS.md` snippet and a skill: `somememos hot` to orient, `somememos search` before grep, `somememos read` in place of `cat`, and `somememos commit -m` after editing.
- [ ] **4.4 Amend the vault** (in `mckoss/2nd-brain`, not here): remove the log-writing rules and the grep orientation step, and update the text about RAG and Obsidian Sync.
- [ ] **4.5 Cloud sessions.** Add the CLI install and credential to the cloud environment's setup (Mike changes the environment; give him the exact lines).
- [ ] **4.6 Read experiments.** With reads in the log, measure the read weight and check whether agent reads make the hot list reinforce itself.

## M5 — Hosted multi-user and MCP (outline)

- [ ] **5.0 Design review.** Accounts, privacy policy, event log retention, pricing.
- [ ] **5.1 Accounts and per-user storage.**
- [ ] **5.2 Export and account deletion.**
- [ ] **5.3 MCP.** A thin adapter over core: remote endpoint with authentication, and local stdio (`somememos mcp`).
- [ ] **5.4 Launch** at the somememos domain.
