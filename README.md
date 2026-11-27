# somememos

somememos is a second brain made of plain markdown notes, with keyword search and a sense of time. Besides finding notes by their words, it can tell you what you are working on now, what is heating up, and what used to matter and has gone quiet.

A notes app shows you what you wrote. somememos also remembers how you have used it: every time a note is read, edited or linked to, that counts toward the note's activity, and activity fades with age at several speeds at once. Search ranks by how well a note matches your words *and* how active it is, so the note you were working on yesterday comes before an old one that happens to use the same words. And because the notes stay ordinary markdown files, any editor, script or AI agent can still read them.

It is not RAG in the usual sense. Nothing is cut into fragments or turned into embeddings, and nothing is pasted into a model's prompt behind its back. An agent calls `somememos search` as a tool, sees why each result ranked where it did, and then reads whole notes with `somememos read`, which in turn records the read. Most "AI memory" products have no notion of time; time is the point of this one. It was built first as memory for AI agents, so that an agent starting a fresh session can see at once what is active, instead of orienting itself with `grep`.

The name is a palindrome: *somememos* reads the same forwards and backwards, like a memory that looks both back at what you've done and ahead at what's coming.

## How it works

- **Notes are plain markdown**, linked with `[[wiki-links]]`. somememos never rewrites a note on its own. Folders have roles: lasting **memos**, **dated** diary entries, **sources** kept as they are, **blog** posts, and **excluded** private folders that are never read at all.
- **Every read, edit and mention is an event**: which note, what kind, when, and which client recorded it. Events go into an append-only log, the one part of a brain that can't be rebuilt from the files. Appearing in search results is not an event, and search queries are never logged.
- **Scores fade at four half-lives**: a day, a week, a month and a year. Each event is worth 1 when it happens and half as much one half-life later. This is Mike Koss's [TimeScore](https://mckoss.com/posts/timescore/) algorithm, which stores scores so that they never need updating as time passes.
- **Hot, trending and neglected** come from comparing those scores: the week score for what is hot, week against month for what is rising, year against month for what has gone quiet.
- **Search is keyword relevance times activation**: a BM25 keyword score computed by somememos itself (so every device ranks identically), combined with the note's activity. The weights were chosen by replaying real history with `somememos eval`, not by intuition.

[docs/concepts.md](docs/concepts.md) explains each of these with examples.

## Three ways to use it

### The web app, on a phone or desktop

An installable app that keeps the whole brain in the browser and works offline. It is served by the somememos server, or by the same build on its own; nothing is hosted publicly yet, so you run it yourself:

```sh
npm ci && npm run build
node apps/web/build                 # serves the app on http://localhost:3000
# open it, then More → Import notes → Choose a folder
# mark private folders as Excluded, then Import
```

[docs/web-app.md](docs/web-app.md) covers importing, searching, editing, publishing and sync.

### The CLI, on a folder of notes

The `somememos` command works on a brain in a local folder, entirely offline. AI agents use it the same way.

```sh
npm ci && npm run build && ln -s "$PWD/packages/cli/bin/somememos.js" ~/.local/bin/somememos
cd ~/notes && somememos init         # then declare folder roles in .somememos/config.json
somememos index                      # the first index; then, for a git repository: somememos import-git
somememos hot                        # what is active now
somememos search compost tea         # then: somememos read <path>, edit, somememos commit -m "update why"
```

[docs/cli.md](docs/cli.md) has every command with real output, and [docs/agents.md](docs/agents.md) the setup for AI agents.

### The server, for sync and agents everywhere

One Node process with Postgres and a git repository per brain. It syncs the web app across devices, answers the CLI in remote mode, and serves public blog pages for posts marked `published: true`.

```sh
eval "$(packages/pg-store/scripts/dev-postgres.sh)"       # a throwaway local Postgres
DATABASE_URL="$SOMEMEMOS_TEST_DATABASE_URL" SOMEMEMOS_DATA_DIR="$(mktemp -d)" \
SOMEMEMOS_TOKEN=local-dev-token-0123456789abcdef ORIGIN=http://localhost:3000 \
BODY_SIZE_LIMIT=34M node apps/web/build
curl -X POST localhost:3000/api/brains -H 'Authorization: Bearer local-dev-token-0123456789abcdef' -H 'Content-Type: application/json' -d '{"id":"garden"}'
```

[docs/server.md](docs/server.md) describes the API and blogs; [docs/deploy.md](docs/deploy.md) covers deployment.

## Status

Version **0.5.0** (from the root `package.json`). This is early software.

What works, with automated tests:

- The CLI in local mode: indexing, search, the activity lists, read, commit, the change log, the one-time git history import, export and import of the event log, and the ranking experiments.
- The CLI in remote mode against a server (`connect`, or three environment variables), plus full offline copies with `clone` and `sync`, and note history and restore.
- The web app: on-device storage, import with folder roles, search with rank breakdowns, the activity views, the editor with live preview, publishing control, sync with a server, and conflict handling.
- The server: Postgres storage, a git repository per brain, the sync protocol, the engine over HTTP, version history, and public blog pages.
- The ranking defaults, measured on one real vault (results in [PLAN.md section 5](PLAN.md#5-ranking-and-search)).

What has not been done or tested:

- **Nothing is deployed.** The server has run only locally and in CI. The `Dockerfile` and `railway.json` are written, but **the Docker image has never been built**.
- **Only Chromium has been tested.** Safari 16.4+ and Firefox 114+ should work but are untested.
- **There is no release download** of the CLI; install from a clone or build the one-file bundle.
- **Single user only:** access is a token set in the server's environment. No accounts, no sign-in.
- **`somememos rm` fails against the real server** in remote mode (the web server's cross-site check refuses its delete request); see [docs/cli.md](docs/cli.md#known-limitations).
- **Not built yet:** an MCP server, a packaged agent skill, a screen for blog settings, folder roles that sync between devices, export of notes from the web app, images on blog pages.
- The weight of a read is unmeasured, because imported history contains no reads.

The design and its decisions are in [PLAN.md](PLAN.md), the task list in [IMPLEMENTATION.md](IMPLEMENTATION.md), and open questions in [QUESTIONS.md](QUESTIONS.md).

## Documentation

- [docs/concepts.md](docs/concepts.md): the ideas (roles, events, half-lives, the lists, sync)
- [docs/web-app.md](docs/web-app.md): using the web app
- [docs/cli.md](docs/cli.md): the command-line tool
- [docs/agents.md](docs/agents.md): setting up an AI agent
- [docs/server.md](docs/server.md): the server, its API and blogs
- [docs/deploy.md](docs/deploy.md): deploying the server

## Development

Requires Node 26, the current LTS line (`.nvmrc` pins 26), and the npm that ships with it. The server and the web app need Node 26; the CLI, and the two packages it bundles (`packages/core` and `packages/sqlite-store`), still run on Node 22.13 or later. CI checks both: the full check on Node 26, and the unit tests of those three packages plus the bundle on Node 22.

```sh
npm ci                     # install all workspaces
npm run check              # privacy guard, lint, type-check, tests, build and browser tests
npm test                   # unit tests only (Vitest, every workspace)
npm run lint               # ESLint and Prettier
npm run format             # Prettier and ESLint fixes
npm run build              # build every package and the web app
```

The workspace: `packages/core` (isomorphic logic: TimeScore, keyword scoring, markdown, indexing, ranking, the engine, sync, evaluation; no Node-only imports), `packages/sqlite-store` (SQLite storage for Node and the browser), `packages/pg-store` (Postgres storage), `packages/server` (the HTTP API), `packages/cli` (the `somememos` command) and `apps/web` (the SvelteKit server and web app).

**Postgres-backed tests** (the Postgres store, the server, the CLI's remote mode) are skipped unless `SOMEMEMOS_TEST_DATABASE_URL` is set. To run them with a throwaway cluster (needs the Postgres 16 server binaries; under root it runs as the `postgres` user):

```sh
eval "$(packages/pg-store/scripts/dev-postgres.sh)"
npm test
packages/pg-store/scripts/stop-dev-postgres.sh          # uses $SOMEMEMOS_DEV_PG_DIR
```

**Browser tests** use Playwright with Chromium: `npm run e2e` builds and runs all of them (the sync and blog suites start their own server and need Postgres, found as above or skipped with a note). Run the dev server with `npm run dev -w @somememos/web`.

The version lives only in the root `package.json`; the CLI and the web header read it from there.

This repository is public and a brain is private: never commit anything from a real brain. Tests and examples use the invented brain from `@somememos/core/testing/brain` (`node docs/scripts/example-brain.mjs <dir>` writes one to disk). See [AGENTS.md](AGENTS.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The TimeScore algorithm is courtesy of Mike Koss.
