# Instructions for AI agents

Read [PLAN.md](PLAN.md) before starting work. It holds the design, the decisions made so far, the milestones and the open questions. [IMPLEMENTATION.md](IMPLEMENTATION.md) breaks the milestones into tasks; tick them off as they land. When a decision changes, update PLAN.md in the same change.

## Ground rules

- **Markdown is the content.** Never change a user's markdown except through an explicit edit operation.
- **Never store raw activity.** No search queries or reading history may be persisted. Events fold into TimeScore log scores immediately.
- **Search results and activation lists are not events.** Reads through somememos (`somememos read`) are. Events are dated when the interaction happens, and future-dated events are rejected.
- **Scoring is set by experiment.** Don't pick a weight or ranking parameter by intuition; measure it with `somememos eval` (PLAN.md section 5).
- **Edit and mention events come only from git commits** in a git-backed brain. Scores are stored per event kind, unweighted.
- **Sync sends deltas, not totals.** Never merge two score snapshots that share history. The server owns the canonical scores and `scores.tsv`.
- **Never change the time epoch** (Unix seconds) or a half-life's name or meaning without a migration. Changing either invalidates stored scores.
- **Stack:** TypeScript throughout. SvelteKit for the server and PWA client (`apps/web`); a Node CLI (`packages/cli`); shared, isomorphic logic in `packages/core`, which must never import Node-only modules.
- **Bundlers are fine** wherever they help (SvelteKit's Vite build, bundling the CLI). Everything is native ESM.
- **TimeScore:** the canonical description is the blog post at https://mckoss.com/posts/timescore/. Read it before changing anything in the scoring code, and keep PLAN.md section 3 consistent with it.
- **Versioning:** the root `package.json` version is the single source of truth. Workspace packages are private and move in lockstep. The web UI shows the version in its header.
- **License:** Apache 2.0. New source files don't need license headers.
