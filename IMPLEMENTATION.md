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

Goal: Mike indexes his vault, gets useful activation lists, and the first experiments set the default weights. Git-backed brains only.

### Indexing

- [ ] **1.1 Config.** `.somememos/config.json` with `exclude` globs, `score` globs (which notes are scored items; default all), half-lives, per-kind weights and `α`. `somememos init` writes defaults and adds `index.sqlite` to the brain's `.gitignore`. Excluded paths must never reach the index, the scores, CLI output or `scores.tsv`; test that explicitly.
- [ ] **1.2 Markdown chunker (core).** Split a note into a preamble plus one chunk per `##` heading. Extract the title (front matter `title`, else first `#` heading, else file name). Ignore headings inside code fences.
- [ ] **1.3 Link parser (core).** Find `[[target]]`, `[[target|alias]]` and `[[target#heading]]`, skipping code fences and inline code. Resolve targets to paths with the vault's rules (read the vault's `AGENTS.md` for its link conventions before fixing these); unresolved targets are dangling links keyed by their normalized text.
- [ ] **1.4 Schema and migrations.** Create the tables in PLAN.md section 4, with a `schema_version` in `meta`. A version mismatch on a derived table triggers a rebuild, never a silent reuse.
- [ ] **1.5 Keyword indexing.** `somememos index` scans the working tree (path, size, mtime, then content hash for changed files) and updates `notes`, `links` and the FTS `chunks` table. Deleted and renamed files are handled. `--rebuild` drops the derived tables first.
- [ ] **1.6 Git-derived events.** Read commits after the stored watermark with one `git log` call (`--name-status -M`, author time, patch for added lines). For each commit: one `edit` event per changed scored note, one `mention` event per `[[link]]` added in the commit, both at the commit's author time clamped to now. Follow renames by moving every score row of the old path. Move a dangling target's scores to the note's path when a commit creates the note. Store the new watermark in the same transaction as the scores.
  - Tests use small fixture repos built in a temp directory: a rename, a note created after being linked, a merge commit, an excluded folder, and a second `index` run that must change nothing.
- [ ] **1.7 Rebuild and history rewrites.** `index --rebuild` clears `edit` and `mention` scores and replays all history, leaving `read` scores untouched. If the watermark commit is no longer an ancestor of `HEAD` (a rebase or force-push), do the same automatically and say so.
- [ ] **1.8 Auto-index.** Every command that reads the brain runs the incremental index first. It must be fast when nothing changed (target: under 100 ms on Mike's vault). `--no-index` skips it.

### Querying

- [ ] **1.9 Ranking (core).** Given candidate items, their per-kind scores, weights, `α`, a half-life and a mode, return ranked results with the score components. Pure functions, no database access, so the evaluation harness can call them with any parameters.
- [ ] **1.10 `search`.** FTS5 query built safely from the user's words (quote terms, so punctuation can't break the query syntax), `r = −bm25()` clamped, combined with activation, grouped so a note appears once with its best section. Modes `hot`, `trending`, `neglected`, `all`.
- [ ] **1.11 `hot`, `trending`, `neglected`.** Activation-only lists, including dangling links, marked as such.
- [ ] **1.12 `read`.** Print the note and record a `read` event at the current time. Refuse excluded paths. Reading a note that isn't a scored item prints it and records nothing.
- [ ] **1.13 Output.** Plain text by default: one result per line (path, heading, snippet), stable across runs. `--json` gives full records with score components. Exit codes 0, 1 and 2. Complete `--help` for every command.
- [ ] **1.14 `status`.** Note and section counts, items with scores, the last commit processed, and the weights in effect.
- [ ] **1.15 Concurrency.** WAL mode and a busy timeout, so several agents can run commands at once. A test runs parallel `read` commands and checks that no event is lost.

### Snapshot

- [ ] **1.16 `snapshot` and import.** Write `scores.tsv` in the PLAN.md section 4 format, sorted and deterministic. On a fresh sidecar in a git-backed brain, import only the `read` rows, then derive the rest from git. Round-trip test: snapshot, delete the sidecar, rebuild, compare scores.

### Evaluation

- [ ] **1.17 Metrics (core).** Recall@k and MRR, with unit tests on hand-computed cases.
- [ ] **1.18 Historical state.** A function that returns the scores as of a past commit (replay events up to it) and a keyword index built from that commit's tree (`git ls-tree` plus `git cat-file --batch`, in an in-memory database). No working-tree checkout, so the vault is never disturbed.
- [ ] **1.19 Case builders.**
  - Replay cases: for a sampled commit, the query is its message plus any changelog text it added; the answers are the scored notes it changed that already existed.
  - Orientation cases: at a sampled time, the answers are the notes changed in the following day and week.
  - Hand-written cases: a JSONL file of `{query, answers}` kept in the brain.
- [ ] **1.20 `somememos eval`.** Run a named set of parameter settings over the cases and print a table of recall@k and MRR per setting, with a `--json` form. Sampling is seeded so runs repeat. Per-case detail is shown only on request and never written outside the brain.
- [ ] **1.21 First experiments on Mike's vault.** Run, in this order, and record the aggregate results and chosen defaults in PLAN.md:
  1. Check the replay queries. Read a sample of generated cases to see whether they describe their tasks. If they don't, write 30 to 50 cases by hand first.
  2. Baseline: keyword only (`all` mode) vs keyword plus activation.
  3. `edit` and `mention` weights, and `α`.
  4. Which half-life (or mix) drives `hot`, measured on orientation cases.
  5. Heading vs body weight in `bm25`.
  6. Link spreading: off, outgoing, backlinks, at a few strengths.
  7. Section-level edit attribution (from diffs) vs note-level.
  
  The read weight can't be measured yet, because history holds no reads. It stays at the placeholder until M2 has collected some.

Done when: `somememos index` on the vault finishes cleanly with the private folders absent from every output, the three activation lists look right to Mike, and PLAN.md records the first experiment results with the defaults they chose.

## M2 — Agent use via the CLI

Goal: Mike's agents use somememos for orientation and reading, on every machine they run on.

- [ ] **2.1 One-file build.** Bundle the CLI and core into a single JavaScript file that needs only Node. Smoke-test the bundle in CI on a clean Node install.
- [ ] **2.2 Distribution.** Attach the bundle to a GitHub release and document a one-line install. Decide here whether to also publish to npm. Add the install step to the cloud environment's setup script (Mike changes the environment; give him the exact lines).
- [ ] **2.3 Agent instructions.** A short `AGENTS.md` snippet and a skill, shipped in this repo: `somememos hot` to orient at session start, `somememos search` before grep, `somememos read` in place of `cat`, edit and commit as usual.
- [ ] **2.4 Amend the vault.** In `mckoss/2nd-brain` (not here): add `.somememos/config.json` with the exclusions, replace the `rg "^## " logs | tail -40` step, and update the "No RAG pipeline" and Obsidian Sync text.
- [ ] **2.5 Snapshot owner.** Name the one machine that writes and commits `scores.tsv`, and document that other machines never do. Reads on disposable machines are lost until M3; say so in the instructions.
- [ ] **2.6 Dogfood review.** After two weeks of use: is `hot` output the right size and shape for a session start, do agents follow the instructions, and how fast is the CLI in practice? Adjust output and instructions from what the sessions show.
- [ ] **2.7 Read weight experiment.** With committed snapshots now holding read scores, evaluate later commits against them: the read weight, and whether agent reads make the hot list reinforce itself.

Done when: Claude Code and Hermes sessions orient with `somememos hot` and read with `somememos read` without being reminded, and the read weight has a measured default.

## M3 — Server and sync (outline)

- [ ] **3.0 Design review.** Settle PLAN.md open questions 7 and 8: how the server gets a git-backed brain's commits, how edits become events without git, and the conflict policy. Update PLAN.md section 7 before coding.
- [ ] **3.1 Pending deltas in the CLI.** Per `(item, kind, half-life)` deltas since the last sync, with `client_id` and `batch_seq`.
- [ ] **3.2 Sync API.** SvelteKit server routes: push a delta batch (idempotent), pull canonical scores, push and pull edits by content hash with a base hash.
- [ ] **3.3 Property tests for sync.** Replayed batches don't double-count; any interleaving of clients converges to the same scores.
- [ ] **3.4 Server-owned snapshot.** The server writes `scores.tsv`; the designated-machine rule from M2 ends.
- [ ] **3.5 Deploy.** Railway with `adapter-node`, a volume for the SQLite file, backups, single-user authentication, and a health endpoint that reports the version.
- [ ] **3.6 `somememos sync`.** Including from disposable cloud sessions, so their reads are kept.

## M4 — PWA client (outline)

- [ ] **4.0 Design review.** Editor choice, sqlite-wasm with OPFS (confirm FTS5 and the VFS), and how a person's reads and edits are recorded (open question 5).
- [ ] **4.1 Local store.** The core `Db` interface over sqlite-wasm in a Web Worker.
- [ ] **4.2 Offline shell.** Service worker, manifest, install to home screen.
- [ ] **4.3 Notes.** Editor with `[[wiki-links]]`, backlinks, quick search.
- [ ] **4.4 Activation views.** Hot, trending, neglected, and dangling links worth writing.
- [ ] **4.5 Sync.** The same protocol as the CLI.
- [ ] **4.6 Playwright tests.** Including offline edits that sync later.

## M5 — Hosted multi-user and MCP (outline)

- [ ] **5.0 Design review.** Accounts, storage default (open question 9), privacy policy, pricing.
- [ ] **5.1 Accounts and per-user SQLite.**
- [ ] **5.2 Brains without git.** Hosted storage with export.
- [ ] **5.3 MCP.** A thin adapter over core: remote endpoint with authentication, and local stdio (`somememos mcp`).
- [ ] **5.4 Optional GitHub-repo storage.**
- [ ] **5.5 Launch** at the somememos domain.
