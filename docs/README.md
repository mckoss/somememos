# somememos documentation

These guides describe somememos 0.5.0 as it is. The design record, with the reasons behind each decision, is [PLAN.md](../PLAN.md).

| Guide | For |
|---|---|
| [concepts.md](concepts.md) | The ideas: folder roles, events, half-lives, hot, trending and neglected, the burst rule, dangling links, the change log, what is synced, and how ranking is set by experiment |
| [web-app.md](web-app.md) | Using the web app on a phone or desktop: importing, searching, writing, publishing, offline use and sync |
| [cli.md](cli.md) | The `somememos` command: installing, local and remote mode, every command with real output, `clone` and `sync`, and `eval` |
| [agents.md](agents.md) | Setting up an AI agent to use a brain: the instructions to paste, cloud sessions, and what gets recorded |
| [server.md](server.md) | The server: what it is, its API in outline, and public blogs |
| [deploy.md](deploy.md) | Deploying the server with Postgres and a persistent disk |

Each guide ends with its known limitations.

## Helper scripts

- [scripts/example-brain.mjs](scripts/example-brain.mjs) writes the invented example brain used in the CLI guide.
- [scripts/screenshots.spec.ts](scripts/screenshots.spec.ts) and [scripts/optimize-images.sh](scripts/optimize-images.sh) regenerate the screenshots in `images/` from the built app (see [scripts/playwright.config.ts](scripts/playwright.config.ts)). They are not part of `npm run check`.
