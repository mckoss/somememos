# Instructions for AI agents

Read [PLAN.md](PLAN.md) before starting work. It holds the design, the decisions made so far, the milestones and the open questions. [IMPLEMENTATION.md](IMPLEMENTATION.md) breaks the milestones into tasks; tick them off as they land. When a decision changes, update PLAN.md in the same change.

## Ground rules

- **No personal data in this repo.** This repository is public, and a brain is private. Nothing taken from a real brain may be committed here or written into a commit message, PR or issue: no note text, titles, file names or paths, people's names, search queries, change messages, event logs, databases, evaluation cases or per-case results. Only aggregate numbers that name no note may be recorded (for example, recall@10 for a parameter setting). Tests and examples use invented data. Run somememos against a real brain in the brain's own directory, never from a copy inside this checkout. If you are unsure whether something reveals the brain's contents, leave it out and ask.
- **Markdown is the content.** Never change a user's markdown except through an explicit edit operation.
- **The event log is the source of truth for scores.** It is append-only, and every event has a unique id. Scores and the keyword index are derived data that must always be rebuildable. Search query text is not logged.
- **Search results and activation lists are not events.** Reads through somememos (`somememos read`) are. Events are dated when the interaction happens, and future-dated events are rejected.
- **Scoring is set by experiment.** Don't pick a weight or ranking parameter by intuition; measure it with `somememos eval` (PLAN.md section 5).
- **Git on the server only.** Each brain is one git repository on the server, used as the version store. No git interface is exposed; clients use somememos's own protocol. Local mode uses git only for the one-time `import-git` command.
- **Scores are stored per event kind, unweighted.** Weights are applied when scores are read.
- **Sync sends events, never scores.** The receiver ignores an event id it already has. Never merge two score tables. A change that arrives through sync is not a new event.
- **Never change the time epoch** (Unix seconds); event times depend on it. Changing a half-life requires rebuilding scores from the event log.
- **Stack:** TypeScript throughout. SvelteKit for the server and PWA client (`apps/web`); a Node CLI (`packages/cli`); shared, isomorphic logic in `packages/core`, which must never import Node-only modules.
- **Databases:** Postgres on the server, SQLite in offline clients (the CLI's local mode and the PWA). Core talks to storage through operation-level interfaces, never dialect-specific SQL.
- **Keyword scoring lives in `packages/core`.** Never rank with a database's full-text search (FTS5, `tsvector`): ranking must be identical on every client and the server.
- **Bundlers are fine** wherever they help (SvelteKit's Vite build, bundling the CLI). Everything is native ESM.
- **TimeScore:** the canonical description is the blog post at https://mckoss.com/posts/timescore/. Read it before changing anything in the scoring code, and keep PLAN.md section 3 consistent with it.
- **Versioning:** the root `package.json` version is the single source of truth. Workspace packages are private and move in lockstep. The web UI shows the version in its header.
- **License:** Apache 2.0. New source files don't need license headers.
