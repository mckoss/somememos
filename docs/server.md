# The somememos server

The server is where a brain lives when it is used from more than one place. It keeps each brain as a git repository of markdown on its disk, plus an event log, change records, a keyword index and scores in Postgres. The web app syncs with it, the CLI uses it in remote mode, and it serves public blog pages for posts their author has published.

It is one Node process: the SvelteKit app in `apps/web`, which serves the web app itself, the JSON API under `/api`, and the public pages under `/blog`. Deploying it is described in [deploy.md](deploy.md).

## What it is and isn't

It is:

- **A single-user server.** Access is one or more bearer tokens set in the server's environment. Anyone holding a token can read and change every brain on that server. There are no accounts, sign-in pages or per-brain permissions yet.
- **The version store.** Every accepted change is a git commit in that brain's repository, with the change's message and the client that sent it. Notes can be listed by version and restored.
- **An engine over HTTP.** Search, the activity lists, reading, saving, renaming and the change log run on the server with the same code as the CLI and the web app, so results are identical everywhere.

It isn't:

- **A git server.** Clients never speak git to it; they send whole notes with content hashes over its own JSON protocol.
- **Multi-user or hosted.** That, real sign-in, and an MCP endpoint are later milestones (PLAN.md section 10).
- **Deployed anywhere yet.** It has been run and tested locally and in CI only, and the Docker image in the repository has never been built.

Without `DATABASE_URL`, the same process still serves the offline web app, and the API answers 503.

## Running it locally

From a built checkout, with a throwaway Postgres (it needs the Postgres 16 server binaries installed, and runs the cluster as the `postgres` user when you are root):

```sh
eval "$(packages/pg-store/scripts/dev-postgres.sh)"     # prints export lines for a temporary cluster
npm run build
DATABASE_URL="$SOMEMEMOS_TEST_DATABASE_URL" \
SOMEMEMOS_DATA_DIR="$(mktemp -d)" \
SOMEMEMOS_TOKEN=local-dev-token-0123456789abcdef \
ORIGIN=http://localhost:3000 \
BODY_SIZE_LIMIT=34M PORT=3000 node apps/web/build
```

It prints `somememos 0.5.0: database ready` and `Listening on http://0.0.0.0:3000`. Stop it with Ctrl-C, and the database with `packages/pg-store/scripts/stop-dev-postgres.sh` (it finds the cluster from `$SOMEMEMOS_DEV_PG_DIR`). Set `ORIGIN` locally too: without it the public pages' canonical and feed links say `https://`. Never put a data directory holding a real brain inside the checkout: the repository is public.

The examples below use `T=local-dev-token-0123456789abcdef` and were run against such a server.

## The API in outline

Every route is under `/api`, takes and returns JSON, and, except for the health check, needs `Authorization: Bearer <token>`. The full list, with parameters, is in the comment at the top of [packages/server/src/http.ts](../packages/server/src/http.ts).

Common rules:

- **Errors** are `{"error": {"code", "message"}}` with a fitting status, for example 400 `invalid-argument`, 401 `unauthorized`, 404 `not-found`, 409 on a stale save, 503 `no-database`.
- **Same origin only.** There are no CORS headers, and a request whose `Origin` header names another host gets 403.
- **Failed tokens are throttled, never the right one:** after 20 failures from one address within 10 minutes (or once 200 have failed in all, for any address that has failed in that window), that address's requests are answered one per second and its failures get 429 with `Retry-After`. A request with a valid token always succeeds, and an address with no failures is never slowed.
- **`X-Somememos-Client: <id>`** names the client: the server records events and change records under that id and authors git commits with it. Without it they are recorded as `server`.
- **Paths** are brain-relative note paths ending in `.md`, with no `..` or dot folders. Notes are at most 2 MiB.

### Health

`GET /api/health` needs no token. It answers 200 when the database is reachable and migrated, and 503 otherwise (or when the configuration is invalid), so a broken deploy fails its health check.

```
$ curl localhost:3000/api/health
{"version":"0.5.0","status":"ok","database":{"configured":true,"connected":true,"migration":{"current":4,"expected":4}}}
```

Without `DATABASE_URL` it answers 200 with `"database":{"configured":false}`, since the web app still works.

### Authentication

```
$ curl localhost:3000/api/brains
{"error":{"code":"unauthorized","message":"a valid bearer token is required"}}
```

`SOMEMEMOS_TOKEN` holds one or more tokens, comma-separated, each either a raw token of at least 24 characters or `sha256:<hex>`, the SHA-256 of one; see [deploy.md](deploy.md#variables).

### Brains

| Route | Does |
|---|---|
| `GET /api/brains` | List the brains: `{brains: [{id, createdAt, mutation}]}` |
| `POST /api/brains` `{id, config?}` | Create one (201). `config.roles` sets its folder roles; the default is `memos/`, `diary/…`, `sources/`, `blog/` |
| `GET /api/brains/{brain}` | One brain, with its config |

A brain id is 1 to 63 lower-case letters, digits and dashes. Folder roles are fixed when the brain is created; there is no route to change them afterwards.

```
$ curl -X POST localhost:3000/api/brains -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"id":"garden"}'
{"id":"garden","createdAt":1795773654,"mutation":0}
```

### Sync

`POST /api/brains/{brain}/sync` is the whole sync protocol in one request: the client sends `since` (the last mutation number it applied), its new `events`, `changes` and `edits` (each edit with the hash it was based on), and gets back the result of each edit and everything newer than `since`. The web app and `somememos clone`/`sync` use it; the shapes are in PLAN.md section 7. A response holds at most `SOMEMEMOS_MAX_PAGE` mutations (2000) and says `"more": true` when there are more. Requests can be up to 32 MiB.

```
$ curl -X POST localhost:3000/api/brains/garden/sync -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"since":0,"events":[],"changes":[],"edits":[]}'
{"mutation":5,"more":false,"results":[],"notes":[{"path":"memos/compost-tea.md","hash":"8deb63…","text":"# Compost tea\n\nSteep for two days. See [[aeration]].\n"}],"events":[{"id":"ix-4870…","kind":"edit","item":"memos/compost-tea.md","time":1795773654,"client":"server"},…],"changes":[…]}
```

### The engine

These routes map one-to-one onto the engine the CLI uses, and the server records the events (the CLI in remote mode uses exactly these).

| Route | Does |
|---|---|
| `GET /api/brains/{brain}/search?q=&mode=&limit=&since=&until=` | Keyword search; `mode` is `hot` (default), `trending`, `neglected` or `all` |
| `GET /api/brains/{brain}/list?mode=&limit=` | An activity list |
| `GET /api/brains/{brain}/notes/{path}` | Read a note; records a read unless `?record=false` |
| `PUT /api/brains/{brain}/notes/{path}` `{text, baseHash?, message?}` | Save; `baseHash: null` means "create; must not exist". 409 with the current text if `baseHash` is stale |
| `DELETE /api/brains/{brain}/notes/{path}?message=` | Delete |
| `POST /api/brains/{brain}/rename` `{from, to, message?}` | Rename |
| `GET /api/brains/{brain}/log?path=&op=&q=&since=&until=&limit=&all=` | The change log; `since` and `until` are Unix seconds |
| `GET /api/brains/{brain}/status` | Counts and config |
| `GET /api/brains/{brain}/titles`, `/dangling` | Every note's title; dangling links with counts |
| `GET` or `POST /api/brains/{brain}/diary` `{date?}` | Today's (or a given day's) diary path; `POST` creates it |

#### Notes

```
$ curl -X PUT localhost:3000/api/brains/garden/notes/memos/compost-tea.md \
    -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
    -d '{"text":"# Compost tea\n\nSteep for two days. See [[aeration]].\n","baseHash":null,"message":"ingest first notes"}'
{"status":"saved","path":"memos/compost-tea.md","hash":"8deb6363…","created":true,"mtime":1795773654,"change":{"seq":1,…,"message":"ingest first notes","op":"ingest","paths":["memos/compost-tea.md"]},"index":{…}}

$ curl "localhost:3000/api/brains/garden/search?q=compost&limit=5" -H "Authorization: Bearer $T"
{"mode":"hot","query":"compost","at":1795773654,"results":[{"item":"memos/compost-tea.md","path":"memos/compost-tea.md","title":"Compost tea","role":"memo",…,"snippet":{"text":"Compost tea Steep for two days. See aeration.",…},"rankKey":1028.40…,"components":{…},"now":{…}}]}
```

A `DELETE` must carry `Content-Type: application/json` (with no body) to get past the web server's cross-site form check; without it the web server answers a plain-text 403, "Cross-site DELETE form submissions are forbidden":

```
$ curl -X DELETE "localhost:3000/api/brains/garden/notes/memos/aeration-pump.md?message=lint" \
    -H "Authorization: Bearer $T" -H 'Content-Type: application/json'
{"status":"deleted","path":"memos/aeration-pump.md","change":{…,"message":"lint","op":"lint",…},"index":{…}}
```

### History

| Route | Does |
|---|---|
| `GET /api/brains/{brain}/notes/{path}/history?limit=` | The note's versions, newest first, following renames |
| `GET /api/brains/{brain}/notes/{path}/versions/{commit}` | The note's text at a commit |
| `GET /api/brains/{brain}/notes/{path}/versions?hash=` | The latest version with that content hash |
| `POST /api/brains/{brain}/notes/{path}/restore` `{commit, baseHash?, message?}` | Make that version current, as a new version |

```
$ curl localhost:3000/api/brains/garden/notes/memos/compost-tea.md/history -H "Authorization: Bearer $T"
{"path":"memos/compost-tea.md","versions":[{"path":"memos/compost-tea.md","mutation":1,"commit":"dd2aab2e0014cb882a422d2e4748271d6a0bc953","hash":"8deb6363…","renamedTo":null,"time":1795773654,"client":"server","message":"ingest first notes"}]}
```

### Blog settings

`GET` and `PUT /api/brains/{brain}/blog` read and change a brain's blog settings. There is no screen for them in the web app yet.

```
$ curl localhost:3000/api/brains/garden/blog -H "Authorization: Bearer $T"
{"enabled":false,"slug":null,"title":null,"description":null,"author":null,"language":"en","url":null}

$ curl -X PUT localhost:3000/api/brains/garden/blog -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
    -d '{"enabled":true,"slug":"garden-notes","title":"Garden notes","author":"A. Gardener"}'
{"enabled":true,"slug":"garden-notes","title":"Garden notes","description":null,"author":"A. Gardener","language":"en","url":"/blog/garden-notes/"}
```

A `PUT` replaces all the settings: `enabled` (required, `true` or `false`), `slug`, `title`, and optionally `description` (up to 300 characters), `author` (100) and `language` (a language tag, default `en`). A blog needs a slug and a title to be turned on. The slug is 2 to 40 lower-case letters, digits and single hyphens, must be unique on the server, and may not be a reserved word such as `blog`, `api` or `admin` (409 `slug-taken`, 400 `invalid-slug`).

## Blogs

A brain's `blog` folder holds posts, written and edited like any other note. A blog is the one public part of an otherwise private brain, so its rules are strict.

**Turning one on.** A blog is off until its owner sets `enabled`, a slug and a title through the API above. The slug names the blog in public addresses and is never the brain's id.

**Publishing a post.** A post is public only when its front matter says `published: true`:

```markdown
---
title: First frost
published: true
---

The first frost came early. See [[compost-tea]] and [[winter-prep]].
```

Anything else in the blog folder is a draft and stays private. Removing the line, or setting it to `false`, takes the post down. The web app's editor has a Publish control that writes or removes exactly that line. Saving the note on the server (by sync, the CLI or the API) is what publishes it: the public pages read the brain's git repository at the commit the database has recorded, so a change shows on the next request.

**Addresses.**

| Address | What |
|---|---|
| `/blog/{slug}/` | The index, newest first (`?page=2` and so on) |
| `/blog/{slug}/{YYYY}/{MM}/{DD}/{post}` | A post dated by its path, such as `blog/2026/2026-11-20-first-frost.md` → `/blog/garden-notes/2026/11/20/first-frost` |
| `/blog/{slug}/p/{post}` | A post without a date in its path |
| `/blog/{slug}/feed.xml` | An Atom feed |
| `/blog/{slug}/sitemap.xml` | A sitemap |
| `/robots.txt` | Allows `/blog/`, disallows everything else, and lists each enabled blog's sitemap |

An address depends only on the file's path, so editing a post never moves it. Renaming a post makes its old address a 404; there are no redirects.

**What is public.** Only published posts in the blog folder of a blog that is turned on: their title, date, text and the blog's own settings. Front matter is never shown. A `[[link]]` to another published post becomes a link; a link to anything else (a memo, a draft, a note that doesn't exist) is shown as its plain text, so whether a private note of that name exists cannot change a page. In the example above, `[[compost-tea]]` is a private memo and appears only as the words "compost-tea". Images and attachments are not served: an image shows its alt text.

**What is not.** Everything else. A draft, a private note, an excluded file, a post in a disabled blog and an address that never existed all get the same 404 page, with the same headers. Public page views are not events and never change a score. Pages are plain server-rendered HTML with no script, raw HTML in markdown is switched off, and a strict content security policy is sent. Public requests are rate-limited (240 a minute per address).

**Caching.** Pages may stay in a browser or proxy cache for up to a minute, so an unpublished post can remain visible that long.

```
$ curl -s localhost:3000/blog/garden-notes/ | grep -o '<h2><a href="[^"]*">[^<]*'
<h2><a href="/blog/garden-notes/2026/11/20/first-frost">First frost
$ curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/blog/garden-notes/2026/11/21/draft
404
```

## Known limitations

- **Not deployed, and the Docker image has never been built.** Expect small fixes on the first real build (QUESTIONS.md).
- **Single user.** One shared token set; no accounts, no per-brain access.
- **`DELETE` needs a JSON content type** to get past the web server's cross-site check, which is why `somememos rm` fails against it in 0.5.0.
- **Folder roles can't be changed** after a brain is created, and changes made on a device are not pushed to the server.
- **No screen for blog settings** in the web app; use the API.
- **No images or attachments** on public pages, and **no redirects** after a post is renamed.
- **`robots.txt` lists every enabled blog's sitemap**, so anyone can see which blogs a server hosts.
- **Without `ORIGIN`, public links say `https://`** even when the server is reached over plain HTTP.
