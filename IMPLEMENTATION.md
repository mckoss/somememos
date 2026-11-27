# somememos — Implementation plan

This file breaks the milestones in [PLAN.md](PLAN.md) section 10 into tasks. PLAN.md holds the design and the reasons; this file holds the order of work and what "done" means for each step. Tick tasks off as they land, and keep the two files consistent.

Milestones 0 to 2 are planned in detail. Milestones 3 to 5 are outlines, and each starts with a design review, because experiments and dogfooding in the earlier milestones will change them.

Conventions for every task:

- TypeScript, native ESM, tests in Vitest next to the code (`*.test.ts`).
- `packages/core` never imports a Node-only module. It receives the database, the clock and file access as interfaces.
- One PR per task or small group of tasks, each raising the root `package.json` version once.

## M0 — Foundations

Goal: an empty but working workspace, with the TimeScore math proven correct.

- [ ] **0.1 Workspace scaffold.** Root `package.json` (private, version `0.1.0`, npm workspaces), `tsconfig.base.json`, ESLint and Prettier, `.gitignore`, Node version pinned in `engines` and `.nvmrc`.
- [ ] **0.2 `packages/core` skeleton.** Builds with `tsc` to ESM. Exports a `VERSION` read from the root `package.json` at build time.
- [ ] **0.3 TimeScore functions.** Read the blog post first (PLAN.md section 3). Implement `eventScore`, `combine`, `addEvent`, `scoreAt`, the half-life table, and `weightedTotal(scoresByKind, weights)`.
  - Unit tests against worked values from the post and its demo code.
  - Property tests (fast-check): `combine` is commutative and associative within tolerance; order is unchanged as `now` advances; two simultaneous events of value 1 add `ln 2`; weighting at read time equals weighting at record time; a future-dated event is rejected.
- [ ] **0.4 `packages/cli` skeleton.** A `somememos` binary with `--version` and `--help`, using an argument parser with no heavy dependencies (`node:util` `parseArgs` unless it proves too limited).
- [ ] **0.5 `apps/web` skeleton.** SvelteKit with `adapter-node`, one page whose header shows the version from the root `package.json`.
- [ ] **0.6 CI.** A GitHub Actions workflow that runs lint, type-check, tests and the web build on every PR and on `main`.
- [ ] **0.7 Confirm the SQLite choice.** A spike test that opens a database with `node:sqlite` and checks: FTS5 with the `porter unicode61` tokenizer, `bm25()` with column weights, the `ln` and `exp` functions, `INSERT … ON CONFLICT`, WAL mode and a busy timeout. If any check fails, repeat with `better-sqlite3`. Record the result in PLAN.md section 9.
- [ ] **0.8 Database interface.** Define the small `Db` interface in core (`exec`, `prepare`, `transaction`) and implement it in the CLI over the chosen driver. Core's SQL runs only through this interface, so the PWA can later supply sqlite-wasm.

Done when: CI is green, `npx somememos --version` prints `0.1.0`, the web skeleton shows the same version, and PLAN.md section 9 records the SQLite decision.

## M1 — Local CLI and evaluation

Goal: on one machine, Mike indexes his vault, imports its git history, gets useful activation lists, and the first experiments set the default weights.

### Event log and scores

- [ ] **1.1 Config.** `.somememos/config.json` with folder roles (`memo`, `dated`, `source`, `excluded`) as path patterns, with every file a `memo` when none are declared, half-lives, per-kind weights and `α`. `somememos init` writes defaults and a client id. Excluded paths must never reach the event log, the index, the scores or any CLI output; test that explicitly.
- [ ] **1.2 Event log.** `events.sqlite` with the `events` table from PLAN.md section 4. An `appendEvent` function in core that assigns a unique id (a random UUID for live events), rejects future-dated events, and is idempotent on id.
- [ ] **1.3 Folding (core).** Fold events after a stored cursor into per-kind scores in `index.sqlite`, cursor and scores in one transaction. Apply rename records by moving an item's scores. A full refold after deleting `index.sqlite` must give the same scores as incremental folding; property-test that with random event sequences, including renames.
- [ ] **1.4 Schema versions.** A `schema_version` in each database. A mismatch in `index.sqlite` triggers a rebuild. A mismatch in `events.sqlite` runs an explicit migration and never drops data.

### Indexing

- [ ] **1.5 Markdown chunker (core).** Split a note into a preamble plus one chunk per `##` heading. Extract the title (front matter `title`, else first `#` heading, else file name). Ignore headings inside code fences.
- [ ] **1.6 Link parser (core).** Find `[[target]]`, `[[target|alias]]` and `[[target#heading]]`, skipping code fences and inline code. Resolve targets to paths with the vault's rules (read the vault's `AGENTS.md` for its link conventions before fixing these); unresolved targets are dangling links keyed by their normalized text.
- [ ] **1.7 Keyword indexing.** `somememos index` scans the working tree (path, size, mtime, then content hash for changed files) and updates `notes`, `links` and the FTS `chunks` table. `--rebuild` deletes `index.sqlite` first.
- [ ] **1.8 Edit detection.** During the scan, for each scored note whose content hash changed since the last pass: log an `edit` event at the file's modification time (at most now), and a `mention` event for each link target in the new version that the old version lacked. A new file counts as an edit. The very first index of a brain logs nothing, since nothing is known to have changed.
- [ ] **1.9 Renames and dangling links.** A path that disappears while a new path appears with the same content hash is a rename: log a rename record instead of an edit. When a new note resolves a dangling target, log a rename from the dangling key to the note's path.
  - Tests use small fixture directories: an edit, a rename, a rename with an edit (treated as delete plus new note; document that), a note created after being linked, an excluded folder, and a second `index` run that must log nothing.
- [ ] **1.10 Auto-index.** Every command that reads the brain runs the incremental index and fold first. It must be fast when nothing changed (target: under 100 ms on Mike's vault). `--no-index` skips it.

### Git import

- [ ] **1.11 `import-git`.** Read the whole history with one `git log` call (`--name-status -M`, author time, patch for added lines). For each commit: an `edit` event per changed scored note and a `mention` event per `[[link]]` added, at the commit's author time, with rename records for renames. An `--ignore-commit` option skips named commits as events while still following their renames, for mass rewrites such as the vault's `wiki/` to `memos/` rename. Event ids are a hash of commit, path, kind and target, so a second run adds nothing. Stop at the moment the brain was first indexed, so a commit and its live-detected edit are never both counted.
  - Tests build fixture repos in a temp directory: a rename, a merge commit, a note linked before it existed, an excluded folder, and a repeated import.

### Querying

- [ ] **1.12 Ranking (core).** Given candidate items, their per-kind scores, weights, `α`, a half-life and a mode, return ranked results with the score components. Pure functions with no database access, so the evaluation harness can call them with any parameters.
- [ ] **1.13 `search`.** FTS5 query built safely from the user's words (quote terms, so punctuation can't break the query syntax), `r = −bm25()` clamped, combined with activation, grouped so a note appears once with its best section. Modes `hot`, `trending`, `neglected`, `all`.
- [ ] **1.14 `hot`, `trending`, `neglected`.** Activation-only lists, including dangling links, marked as such.
- [ ] **1.15 `read` and `commit`.** `read` prints the note and logs a `read` event at the current time. It refuses excluded paths, and reading a note that isn't a scored item prints it and logs nothing. `commit` runs the index pass, so its edits are logged at once; it exists in local mode so agents follow the same search, read, edit, commit flow they will use against the server.
- [ ] **1.16 Output.** Plain text by default: one result per line (path, heading, snippet), stable across runs. `--json` gives full records with score components. Exit codes 0, 1 and 2. Complete `--help` for every command.
- [ ] **1.16a Roles and `diary`.** Only `memo` files are scored items. A `dated` pattern yields the entry's date from its path, and `search` accepts `--since` and `--until` on it. A changed `source` file is reported, not logged as an edit. `somememos diary` prints today's entry path, creating the file if needed. `somememos init` in an empty directory creates `memos/`, `diary/` and `sources/`.
- [ ] **1.17 `status` and `export`.** `status` shows note and section counts, events by kind, and the weights in effect. `export` writes `events.jsonl`; a round-trip test imports it into an empty brain and compares scores.
- [ ] **1.18 Concurrency.** WAL mode and a busy timeout on both databases, so several agents can run commands at once. A test runs parallel `read` commands and checks that no event is lost or folded twice.

### Evaluation

- [ ] **1.19 Metrics (core).** Recall@k and MRR, with unit tests on hand-computed cases.
- [ ] **1.20 Replay (core).** Fold the event log up to a given time into in-memory scores, with the weights, half-lives and folding rules of one experiment setting. This is the same folding code as 1.3, given different parameters.
- [ ] **1.21 Case builders.**
  - Orientation cases: at a sampled time, the answers are the notes with events in the following day and week.
  - Search cases from imported git history: for a sampled commit, the query is its message plus any changelog text it added; the answers are the scored notes it changed that already existed. The keyword index is built from the parent commit's tree (`git ls-tree` plus `git cat-file --batch`, in an in-memory database), with no working-tree checkout.
  - Hand-written cases: a JSONL file of `{query, time?, answers}` kept in the brain.
- [ ] **1.22 `somememos eval`.** Run a named set of parameter settings over the cases and print a table of recall@k and MRR per setting, with a `--json` form. Sampling is seeded so runs repeat. Per-case detail is shown only on request and never written outside the brain.
- [ ] **1.22a Prepare the vault.** In `mckoss/2nd-brain` (not here), before the first import: rename `wiki/` to `memos/` and rewrite the links and instructions that name it, in one commit; add `.somememos/config.json` with the roles and exclusions; ignore the two database files in git; tidy the stray root-level note and the loose files in `raw/`. Then run `import-git`, ignoring the rename commit.
- [ ] **1.23 First experiments on Mike's vault.** Run, in this order, and record the aggregate results and chosen defaults in PLAN.md:
  1. Check the search cases. Read a sample of generated cases to see whether they describe their tasks. If they don't, write 30 to 50 cases by hand first.
  2. Baseline: keyword only (`all` mode) vs keyword plus activation.
  3. `edit` and `mention` weights, and `α`.
  4. Half-lives, and which of them (or what mix) drives `hot`, on orientation cases.
  5. How bursts of edits to one note should count.
  6. Heading vs body weight in `bm25`.
  7. Link spreading: off, outgoing, backlinks, at a few strengths.
  8. Section-level edit attribution (from diffs in the imported history) vs note-level.

  The read weight can't be measured yet, because imported history holds no reads. It stays at the placeholder until M2 has collected some.

Done when: `somememos index` and `import-git` run cleanly on the vault with the private folders absent from the event log and every output, the three activation lists look right to Mike, and PLAN.md records the first experiment results with the defaults they chose.

## M2 — Agent use on one machine

Goal: Mike's agents on his main machine use somememos for orientation and reading. Other machines wait for the server in M3.

- [ ] **2.1 One-file build.** Bundle the CLI and core into a single JavaScript file that needs only Node. Smoke-test the bundle in CI on a clean Node install.
- [ ] **2.2 Distribution.** Attach the bundle to a GitHub release and document a one-line install. Decide here whether to also publish to npm.
- [ ] **2.3 Agent instructions.** A short `AGENTS.md` snippet and a skill, shipped in this repo: `somememos hot` to orient at session start, `somememos search` before grep, `somememos read` in place of `cat`, edit notes with ordinary tools, and `somememos commit` after editing.
- [ ] **2.4 Amend the vault.** In `mckoss/2nd-brain` (not here): replace the `rg "^## " logs | tail -40` step; and update the "No RAG pipeline" and Obsidian Sync text.
- [ ] **2.5 Back up the event log.** Until the server exists, the log lives on one machine. Schedule `somememos export` to a backed-up location and document it.
- [ ] **2.6 Dogfood review.** After two weeks of use: is `hot` output the right size and shape for a session start, do agents follow the instructions, and how fast is the CLI in practice? Adjust output and instructions from what the sessions show.
- [ ] **2.7 Read experiments.** With reads now in the log, measure the read weight on orientation cases, and check whether agent reads make the hot list reinforce itself.

Done when: Claude Code and Hermes sessions on the main machine orient with `somememos hot` and read with `somememos read` without being reminded, and the read weight has a measured default.

## M3 — Server and remote CLI (outline)

Goal: the server's filesystem becomes the home of the vault, and agents on any machine use it with only the CLI and a credential.

- [ ] **3.0 Design review.** Settle single-user authentication, the request API, how commits are attributed and described, and how the vault's existing repository becomes the server's. Update PLAN.md section 7 before coding.
- [ ] **3.1 Server storage.** One git repository per brain on the server's filesystem, the event log beside it, and one mutation counter that numbers every change. Writes to a brain are serialized, and each accepted change is exactly one git commit. Confirm how the server runs git (the `git` binary in the deploy image, or a library).
- [ ] **3.2 Query API.** `search`, the activation lists and `status` as server routes that run the same core code as local mode.
- [ ] **3.3 Read API and working folder.** `read` fetches a note into the working folder, records its path and hash in a manifest, and logs the read on the server. A repeated read refetches when the server is newer and the local file is untouched, and warns when both have changed.
- [ ] **3.4 Commit API.** `commit` sends changed and new files with their base hashes. The server compares each base with the note's current version, then writes the files, makes a git commit and logs `edit` and `mention` events, or refuses a stale base and returns the current version, which the CLI saves beside the file. Deletes and renames are explicit.
- [ ] **3.5 Forgotten commits.** Every remote command compares the working folder with its manifest and prints a reminder naming edited, uncommitted files. `status` lists them.
- [ ] **3.6 Tests.** Two clients editing the same note; a commit retried after a dropped connection; a stale working folder; excluded paths refused by every route.
- [ ] **3.7 Version history commands.** List a note's versions and restore one, served from the brain's git history. Restoring is a new commit, never a rewrite of history.
- [ ] **3.8 Deploy.** Railway with `adapter-node`, a volume for the notes and databases, backups, and a health endpoint that reports the version.
- [ ] **3.9 Cloud sessions.** Add the CLI install and credential to the cloud environment's setup (Mike changes the environment; give him the exact lines).
- [ ] **3.10 Move the vault.** Load the vault's existing git repository, with its history, as the brain's repository on the server, along with the event log. Update the vault's agent instructions so agents use the CLI and no longer clone the vault.

## M4 — PWA client (outline)

- [ ] **4.0 Design review.** Editor choice, sqlite-wasm with OPFS (confirm FTS5 and the VFS), and whether a person's events should be told apart from an agent's (open question 5).
- [ ] **4.1 Local store.** The core `Db` interface over sqlite-wasm in a Web Worker.
- [ ] **4.2 Offline shell.** Service worker, manifest, install to home screen.
- [ ] **4.3 Notes.** Editor with `[[wiki-links]]`, backlinks, quick search, and version history.
- [ ] **4.4 Activation views.** Hot, trending, neglected, and dangling links worth writing.
- [ ] **4.5 Offline sync.** Catch up from the server by mutation counter; push events logged offline (the server ignores ids it has) and offline edits with base hashes; conflict files. Property tests: repeated pushes count nothing twice, and any interleaving of clients ends with the same events and scores everywhere.
- [ ] **4.6 `somememos clone`.** The same sync for a full local copy on a machine that runs local or offline models.
- [ ] **4.7 Playwright tests.** Including offline edits that sync later.

## M5 — Hosted multi-user and MCP (outline)

- [ ] **5.0 Design review.** Accounts, privacy policy, event log retention, pricing.
- [ ] **5.1 Accounts and per-user storage.**
- [ ] **5.2 Export and account deletion.**
- [ ] **5.3 MCP.** A thin adapter over core: remote endpoint with authentication, and local stdio (`somememos mcp`).
- [ ] **5.4 Launch** at the somememos domain.
