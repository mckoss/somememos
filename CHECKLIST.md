# Overnight checklist

Mike is away from the evening of 2026-11-27 and will review in the morning. This file tracks what the overnight session set out to do and what actually got done. Questions that need Mike are in [QUESTIONS.md](QUESTIONS.md). The design is in [PLAN.md](PLAN.md) and the task breakdown in [IMPLEMENTATION.md](IMPLEMENTATION.md).

Status key: `[x]` merged to `main` with CI green, `[~]` in progress, `[ ]` not started, `[!]` blocked (see QUESTIONS.md).

## Starting point

`main` was at v0.2.1 when the night started: shared core (TimeScore, keyword scoring, markdown, storage, indexing, ranking, evaluation, engine), the SQLite store package, and a CLI with `init`, `index`, `commit`, `status`, `diary` and `import-git`.

## Web app, local first (milestone 2)

- [x] On-device brain: SQLite in the browser on a worker, persistent storage, engine in the worker, folder import, service worker and manifest
- [x] Web UI: app shell for phone and desktop, search with rank breakdowns, hot / trending / neglected views, note view, CodeMirror editor with live preview, blog publish control, import and settings
- [x] Join the two: UI running on the on-device brain, browser tests in `npm run check` and CI
- [x] Review screenshots at phone and desktop sizes and fix what looks wrong (two passes)
- [x] Release as v0.3.0 (PR 16)

## CLI (milestone 1)

- [x] `search`, `hot`, `trending`, `neglected`, `read`, `log`, `export`, `import-log`, `eval`
- [x] `blog` folder role in core
- [x] First experiments on the vault: run, results in PLAN.md section 5, and the chosen defaults and the burst rule are in the code (v0.4.0)

## Server and sync (milestone 3)

- [x] Sync design written into PLAN.md section 7
- [x] Postgres implementation of the storage interfaces, passing the shared conformance suite in CI
- [x] Server: one git repository per brain, sync API, engine over HTTP, note history and restore
- [x] Sync in the web app (v0.5.0)
- [x] Single-user access token, with a seam for real sign-in
- [x] Deploy to Railway (v0.6.2, 2026-11-27): project `somememos` with Postgres 16 and a volume at `/data`; deploys from `main` after CI passes; health check verified. No brain has been created on the server yet

## Agents (milestone 4)

- [x] One-file CLI build (v0.4.0)
- [x] CLI remote mode against the server, plus `clone`, `sync`, `history` and `restore` (v0.4.0)
- [x] Agent guide: `somememos help agents` and `help setup` (v0.4.0). A packaged skill is not written

## Blog publishing (milestone 5, pulled forward if time allows)

- [x] Public pages for posts marked `published: true`, with the privacy rules in PLAN.md section 8 (v0.5.0)

## Added during the night

- [x] Shared settings (folder roles) that sync between devices, a blog settings screen, one remote commit as one change, `history` and `restore` from a clone (v0.5.0)
- [x] Independent security review of the server, with fixes (v0.5.0)
- [x] README and user guides under `docs/` (v0.5.0)
- [x] Fix for the sync browser test that failed once on CI: a real note-page bug fixed, exact CI cause not reproduced (v0.6.0)
- [x] Final polish: lockout fix, export of notes from the app, and nine smaller fixes (v0.6.0)
- [x] Scores could depend on arrival order when two renames share a timestamp, found by a property test: fixed in v0.6.0, and its concurrent case in v0.6.1

## Interruptions

- The coding agents hit the account's usage limit at about 10:10 UTC and stopped until it reset at 11:40 UTC. Their work was saved and they were resumed.

## After Mike returned (27 November, daytime)

- [x] Move to Node 26 LTS for development, CI and the server, with the CLI still supported on Node 22.13 or later (v0.6.1)
- [~] Replace three bespoke pieces with packages: `valibot` for request validation, `fflate` for zip, Vitest browser mode for the in-browser conformance suites (v0.6.2 PR)

