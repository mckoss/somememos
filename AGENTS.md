# Instructions for AI agents

Read [PLAN.md](PLAN.md) before starting work. It holds the design, the decisions made so far, the milestones and the open questions. When a decision changes, update PLAN.md in the same change.

## Ground rules

- **Markdown is the content.** Never change a user's markdown except through an explicit edit operation.
- **Never store raw activity.** No search queries or reading history may be persisted. Events fold into TimeScore log scores immediately.
- **Search results are not events**, and agent reads aren't either unless the note is cited. Future-dated events are rejected.
- **Sync sends deltas, not totals.** Never merge two score snapshots that share history. The server owns the canonical scores and `scores.tsv`.
- **Never change the time epoch** (Unix seconds) or a half-life's name or meaning without a migration. Changing either invalidates stored scores.
- **Stack:** TypeScript throughout. SvelteKit for the server and PWA client (`apps/web`); a Node CLI (`packages/cli`); shared, isomorphic logic in `packages/core`, which must never import Node-only modules.
- **Bundlers only where SvelteKit needs one.** `packages/core` and `packages/cli` are compiled with `tsc` only, as native ESM. `apps/web` uses SvelteKit's standard Vite build.
- **TimeScore:** the canonical description is the blog post at https://mckoss.com/posts/timescore/. Read it before changing anything in the scoring code, and keep PLAN.md section 3 consistent with it.
- **Versioning:** the root `package.json` version is the single source of truth. Workspace packages are private and move in lockstep. The web UI shows the version in its header.
- **License:** Apache 2.0. New source files don't need license headers.
