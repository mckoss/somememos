# Overnight checklist

Mike is away from the evening of 2026-11-27 and will review in the morning. This file tracks what the overnight session set out to do and what actually got done. Questions that need Mike are in [QUESTIONS.md](QUESTIONS.md). The design is in [PLAN.md](PLAN.md) and the task breakdown in [IMPLEMENTATION.md](IMPLEMENTATION.md).

Status key: `[x]` merged to `main` with CI green, `[~]` in progress, `[ ]` not started, `[!]` blocked (see QUESTIONS.md).

## Starting point

`main` is at v0.2.1: shared core (TimeScore, keyword scoring, markdown, storage, indexing, ranking, evaluation, engine), the SQLite store package, and a CLI with `init`, `index`, `commit`, `status`, `diary` and `import-git`.

## Web app, local first (milestone 2)

- [~] (built, committed to the branch) On-device brain: SQLite in the browser on a worker, persistent storage, engine in the worker, folder import, service worker and manifest
- [~] (built, committed to the branch) Web UI: app shell for phone and desktop, search with rank breakdowns, hot / trending / neglected views, note view, CodeMirror editor with live preview, blog publish control, import and settings
- [~] Join the two: UI running on the on-device brain, browser tests in `npm run check` and CI (agent running in a separate worktree)
- [~] Review screenshots at phone and desktop sizes and fix what looks wrong (first set reviewed; second pass with the integration)
- [ ] Release as v0.3.0

## CLI (milestone 1)

- [~] (built, committed to the branch) `search`, `hot`, `trending`, `neglected`, `read`, `log`, `export`, `import-log`, `eval`
- [~] (built, committed to the branch) `blog` folder role in core
- [~] First experiments on the vault: run, results in PLAN.md section 5. Applying the chosen defaults and the burst rule in code (agent running)

## Server and sync (milestone 3)

- [~] Sync design written into PLAN.md section 7 (request shapes, mutation counter, conflict handling): written, merges with the next PR
- [~] (built, committed to the branch) Postgres implementation of the storage interfaces, passing the shared conformance suite in CI
- [~] (built, committed to the branch) Server: one git repository per brain, sync API, engine over HTTP, note history and restore
- [ ] Sync in the web app
- [~] (built, committed to the branch) Single-user access token, with a seam for real sign-in
- [!] Deploy to Railway (needs Mike: see QUESTIONS.md). Dockerfile, railway.json and docs/deploy.md are written; the image has not been built, because this environment has no Docker daemon

## Agents (milestone 4)

- [~] One-file CLI build (agent running)
- [~] CLI remote mode against the server, plus `clone` and `sync` (agent running)
- [ ] `AGENTS.md` snippet and skill for brains

## Blog publishing (milestone 5, pulled forward if time allows)

- [ ] Public pages for posts marked `published: true`, with the privacy rules in PLAN.md section 8
