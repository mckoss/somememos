# Deploying the somememos server

The server is the SvelteKit app in `apps/web`, built with `adapter-node`. One process serves the offline web app and the API under `/api`. These notes are for Railway (PLAN.md section 9), but nothing in them is Railway-only: any host that runs a container, gives it a Postgres database and a persistent disk will do. The project's own server runs this way at https://web-production-04386931.up.railway.app (first deployed 2026-11-27, v0.6.2).

## What the server stores, and where

- **Postgres** holds the event log, change records, the keyword index and scores (`@somememos/pg-store`), and the server's own tables: `server_brains` (each brain's owner, config, and the git commit the database has recorded) and `note_versions` (every note version by mutation number and commit). Migrations run at start-up, safely from several processes at once.
- **The data directory** (`SOMEMEMOS_DATA_DIR`) holds one git repository per brain, at `brains/<brain id>/`. Its working tree is the brain's notes; git is the only copy of note text. Every accepted change set is one commit, authored by the client that sent it.
- The database transaction is the single commit point of every write. If the process dies after a git commit but before the database commit, the next request for that brain resets the repository to the commit the database recorded, and keeps the unrecorded commit under `refs/somememos/unrecorded/` (nothing is deleted). The client never got a response, so it retries.

## Railway setup

1. **Service.** Create a service from this repository. `railway.json` selects the `Dockerfile` build (Node 26 with `git`, the whole workspace built, `node apps/web/build`) and sets the health check. The container starts as root only long enough to give the volume to the unprivileged `node` user, then runs the server as that user (`scripts/docker-start.sh`); no `RAILWAY_RUN_UID` setting is needed.
2. **Postgres.** Add Railway's managed Postgres to the project. In the service's variables, set `DATABASE_URL` to a reference to it: `${{Postgres.DATABASE_URL}}`. Railway backs the database up.
3. **Volume.** Attach a volume to the service, mounted at `/data` (the Dockerfile sets `SOMEMEMOS_DATA_DIR=/data`). This is where the brains' repositories live; without a volume they are lost on every deploy.
4. **Token.** Set `SOMEMEMOS_TOKEN` (below). Every API request needs it as `Authorization: Bearer <token>`.
5. **Proxy headers.** Set `ADDRESS_HEADER=X-Forwarded-For` and `XFF_DEPTH=1` so the server sees each client's address (failed sign-in attempts are limited per address), and `ORIGIN=https://<your domain>` so request URLs carry the public origin.
6. **Health check.** `GET /api/health` (no token). It answers 200 with `{ version, status: "ok", database: { configured, connected, migration: { current, expected } } }` (or `database: { configured: false }` when `DATABASE_URL` is unset, since the web app still works), and 503 when the database is unreachable, migrations are pending, or the configuration is invalid (with the problems listed). A deploy whose configuration is wrong therefore fails its health check instead of going live.
7. **Create a brain.** `curl -X POST https://<domain>/api/brains -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"id":"main"}'`. Pass `"config": { "roles": { ... } }` to use folder roles other than the default layout; clients must use the same roles.

8. **Domain port.** Railway sets `PORT` itself (8080 on the first deploy), overriding the Dockerfile's 3000. A generated domain must target the port the start log reports (`Listening on http://0.0.0.0:<port>`), or it answers 502 while the health check passes.
9. **Deploy after CI.** In the service's settings, connect the repository's `main` branch and turn on **Wait for CI**. A push to `main` then deploys only once its GitHub Actions run has passed; a failed run deploys nothing.

Do not use the Railway CLI for any of this; the dashboard (or Railway's API) is enough, and GitHub is the control plane: merging to `main` is how a release ships. After a merge, check that `/api/health` reports the new version before calling it live.

The Postgres service runs the Postgres 16 image (`ghcr.io/railwayapp-templates/postgres-ssl:16`), the version CI tests against.

## Variables

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | for the API | `postgres://…` URL of the server's database. Unset: the app serves the offline web app and the API answers 503. |
| `SOMEMEMOS_DATA_DIR` | with `DATABASE_URL` | Absolute path of the directory holding the brains' repositories; on a persistent volume. |
| `SOMEMEMOS_TOKEN` | with `DATABASE_URL` | Bearer token(s), comma-separated. Each is a raw token of at least 24 characters, or `sha256:<64 hex digits>`, the SHA-256 of one, so the raw token need not be stored in the environment. |
| `PORT` | no | The HTTP port; Railway sets it. The Dockerfile defaults to 3000. |
| `BODY_SIZE_LIMIT` | no | adapter-node's request size limit. The Dockerfile sets `34M`, since a sync request may carry up to 32 MiB. |
| `ADDRESS_HEADER`, `XFF_DEPTH`, `ORIGIN` | recommended | adapter-node's proxy settings (above). |
| `SOMEMEMOS_MAX_PAGE` | no | Mutations per sync response page (default 2000). |

To make a token and its hashed form:

```sh
TOKEN=$(openssl rand -base64 33 | tr -d '/+=')
printf 'sha256:%s\n' "$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)"
```

Give clients `$TOKEN`; put the `sha256:…` line in `SOMEMEMOS_TOKEN`. The configuration is checked at start-up and every problem is logged; the API answers 503 until it is fixed.

## Backups

Two things need backing up, and they must be restored as a pair.

- **The database:** Railway's managed Postgres backups.
- **The volume:** Railway volume backups (scheduled in the volume's settings), or a copy of each repository, for example `git -C /data/brains/<id> bundle create /somewhere/<id>.bundle --all` from a one-off command.

Restore a volume backup **at least as new as** the database backup. A repository ahead of the database is fine (the server resets it to the recorded commit and keeps the extra commits under a ref). A repository behind the database is missing commits the database refers to: requests for that brain then fail with a clear error instead of guessing.

The event log is the brain's original data; the index and scores can always be rebuilt from it and the notes. A user's own export (the markdown plus `events.jsonl`) is a third copy.

## Running it locally

```sh
eval "$(packages/pg-store/scripts/dev-postgres.sh)"     # a throwaway Postgres 16
npm run build
DATABASE_URL="$SOMEMEMOS_TEST_DATABASE_URL" \
SOMEMEMOS_DATA_DIR="$(mktemp -d)" \
SOMEMEMOS_TOKEN=local-dev-token-0123456789abcdef \
ORIGIN=http://localhost:3000 \
BODY_SIZE_LIMIT=34M PORT=3000 node apps/web/build
curl localhost:3000/api/health                          # in another shell
packages/pg-store/scripts/stop-dev-postgres.sh          # after stopping the server; uses $SOMEMEMOS_DEV_PG_DIR
```

Without `ORIGIN`, adapter-node assumes HTTPS, so the public blog pages' canonical and feed links say `https://` even over plain HTTP. [server.md](server.md) describes the API and blogs.

Never put a data directory that holds a real brain inside this checkout: this repository is public.
