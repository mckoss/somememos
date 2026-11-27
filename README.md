# somememos

A second brain made of plain markdown files, with a sidecar database that adds keyword search and time-aware working memory.

somememos ranks your notes by what you're working on now, what's heating up, and what you've let go quiet. It uses the [TimeScore](https://mckoss.com/posts/timescore/) algorithm: every bit of activity adds to a note's score, and scores fade with a half-life at several time scales (a day, a week, a month, a year).

- **Your notes stay plain markdown.** The sidecar can always be exported alongside them.
- **Works offline where it matters.** The web app keeps a local copy and syncs to the server. Agents use a command-line tool that talks to the server and fetches only what they read.
- **Built for agents.** A command-line tool lets any AI agent with a shell search and read your brain. An MCP server follows for agents without one.

Status: the workspace scaffold exists (CLI, core library and web app skeletons, CI); the features are not built yet. See [PLAN.md](PLAN.md) and [IMPLEMENTATION.md](IMPLEMENTATION.md).

The name is a palindrome: *somememos* reads the same forwards and backwards, like a memory that looks both back at what you've done and ahead at what's coming.

## Development

Requires Node 22.13 or later (`.nvmrc` pins 22) and npm.

```sh
npm ci                     # install all workspaces
npm run check              # privacy guard, lint, type-check, tests and build
npm test                   # tests only (Vitest, every workspace)
npm run format             # Prettier and ESLint fixes
npm run build              # build packages/core, packages/cli and apps/web
```

The workspace has three packages: `packages/core` (isomorphic logic, no Node-only imports), `packages/cli` (the `somememos` command) and `apps/web` (the SvelteKit server and PWA).

Run the CLI after a build:

```sh
npx somememos --version
npx somememos --help
```

Run the web app:

```sh
npm run dev -w @somememos/web                          # dev server with hot reload
npm run build && node apps/web/build                   # production server on port 3000
```

The version lives only in the root `package.json`; the CLI and the web header read it from there.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
