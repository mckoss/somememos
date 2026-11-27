# Security review, 27 November 2026

An independent review of the somememos server, its public blog and the web client at version 0.5.0 (the sync server, public blog pages and web sync), before the first deployment on Railway as a single-user server with a bearer token. One reviewer, one night. Everything below was checked against the code and, where marked, demonstrated with a test or a request; nothing was tested against a deployed server or a real brain.

## Scope and method

The attacker models were: (a) anyone on the internet with no token, sending any HTTP request; (b) a user with a valid token for their own brain on a future multi-user server, after someone else's data; (c) someone who controls a note's content or a sync request (for example a compromised agent or device); (d) someone who can make the owner open a malicious web page.

Read in full: `packages/server/src` (routes, access, brains, git, content store, history, sync, blog, blog settings and limits, config), `packages/core/src/sync`, the sync parts of `packages/core/src/engine`, the pg-store queries, `apps/web/src/hooks.server.ts`, `apps/web/src/lib/server`, the `/api` and `/blog` routes, the service worker, the web client's token handling (`sync-controller.ts`), the app's markdown renderer, the Dockerfile, `railway.json` and `docs/deploy.md`.

Method: the route table was enumerated and every route was called without a token, with a wrong token, and (with a test authorizer that knows two users) as a second user against the first user's brain. Path handling was traced from the URL and the sync body to the file system and to every `git` process. Every parser that sees note text (front matter, block scanner, links, tokenizer, the inline-markdown stripper, both markdown renderers) was timed on hostile inputs of 20 KB to 400 KB. The blog was read for every way a private note could reach an anonymous response. The browser suites were run with the new headers.

## Findings

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Stripping inline markdown from a heading took quadratic time: one note freezes the server | High | Fixed (`e0e3d76`) |
| 2 | Both markdown renderers took quadratic time on many unclosed `[[` | Medium | Fixed (`2e8e9a0`) |
| 3 | Failed-login limits can lock the owner out of the API | Medium | Fixed: failures are throttled, a valid token always passes |
| 4 | The app had no content security policy and could be framed | Low | Fixed (`0865d33`) |
| 5 | The container ran the server as root | Low | Fixed (`60b4fa9`) |
| 6 | A file or folder name over 255 bytes failed with a 500, logged the note's path, and jammed a device's sync | Low | Fixed (`7919aac`) |
| 7 | A note sharing its name with a folder failed with a 500 and logged the note's path | Low | Fixed for save and rename (`55f7884`) and for sync (`name-clash` refusal) |
| 8 | HTML comments in a published post appear as visible text on the public blog | Low | Fixed: dropped from the page, title and summary |
| 9 | Notes can load images from any https address | Low | Left for the owner |
| 10 | The CLI sends its token to an `http://` server | Low | Fixed: refused unless local or `--allow-insecure` |
| 11 | Brain ids and blog slugs are one namespace across users | Low | Accepted (single-user server) |

### 1. Quadratic heading stripping (high, fixed)

`stripInlineMarkdown` (core) removed links, images, reference links, autolinks and HTML tags with regular expressions such as `/\[([^\]]*)\]\([^)]*\)/g` and `/<\/?[A-Za-z][^>]*>/g`. On a line with many openers and no closer each start position scans the rest of the line, so the time is quadratic in its length. Headings are stripped when a note is indexed, which the server does inside the request that saves or syncs the note, on Node's single event loop.

Demonstration: a note whose first line is `# ` followed by `[[` repeated 200,000 times (400 KB, well under the 2 MiB note limit) took 137 seconds in `stripInlineMarkdown` plus `chunkNote`; 2 MiB would take about an hour. One `PUT /api/brains/{b}/notes/memos/x.md` or one sync carrying such a note stops the server answering anyone, health check included. Any token holder can send it, and so can a compromised device simply by syncing a note. Blog post titles and summaries go through the same function.

Fix: the five rules are now linear scans with exactly the old output; a randomized comparison against the old expressions is part of the test (`packages/core/src/markdown/inline.test.ts`), along with a time limit on hostile headings.

### 2. Quadratic `[[` search in the renderers (medium, fixed)

The app's note view (`apps/web/src/lib/ui/markdown.ts`) and the public blog's renderer (`apps/web/src/lib/server/blog/render.ts`) searched the whole rest of the text for `]]` at every `[[`. Demonstration: a 400 KB body of `[a][` repeated took 78 to 80 seconds to render in each. In the app this freezes the owner's tab when they open a note synced from a compromised device; on the server it blocks the process the first time anyone requests such a published post (rendering is then cached per commit). Fix: the scan stops at the first bracket or line break, which cannot be inside a link anyway, so the same links render. Tests in both renderers' test files.

### 3. Failed-login limits as a lockout lever (medium, fixed)

`FailureLimiter` (`packages/server/src/auth.ts`) refuses every request with 429 once 200 failed attempts were made by all addresses together in a 10-minute window, or 20 by one address, "even with a valid token, so guessing gains nothing". Demonstration (by reading; not run as a test): an anonymous client sends `GET /api/brains` with `Authorization: Bearer x` 200 times from any addresses; for the rest of the window every request, including the owner's with the right token, gets 429. Twenty such requests a minute keep the API closed indefinitely. If `ADDRESS_HEADER` is not set (docs/deploy.md asks for it), every client shares the proxy's address and 20 failures suffice.

This trades availability for brute-force resistance, a choice the code makes deliberately, so it is not changed here. Tokens are at least 24 characters and the documented way to make one gives about 190 bits, so guessing is already hopeless; the limiter is defence in depth. Options, in order of preference: let a request with a valid token through when only the total limit is reached (per-address limits still cap each address's guesses); or count the total limit only toward addresses that have failed before; or raise the total limit substantially. Whatever is chosen, keep `ADDRESS_HEADER=X-Forwarded-For` and `XFF_DEPTH=1` in the deployment.

**Fixed afterwards.** The limiter no longer refuses; it throttles. An address over its own limit (20 failures in the window), or any address that has failed in the window once the total (200) is reached, has its requests spaced one second apart *before* the token is compared, and its failures answer 429 instead of 401. Every admitted request is compared in constant time, so a valid token always passes, and an address with no failures is never slowed by anyone else's. Guessing stays bounded: a throttled address learns at most one result per second however many connections it opens, and abandoning a slow answer reveals nothing because the comparison has not yet happened; past the total, each fresh address gets one guess before it is throttled too. The only outright refusal left is for an address whose own queue is over 30 seconds long. Without `ADDRESS_HEADER`, everyone shares the proxy's address, so a flooding attacker slows the owner to one request a second (and can fill that queue) rather than locking them out completely; the header remains required. Tests: `packages/server/src/config.test.ts` and `http.test.ts`.

### 4. No content security policy or frame protection on the app (low, fixed)

The app's pages had no CSP and could be framed by any site (clickjacking under model d). No script injection was found (notes are sanitized with DOMPurify), so this is hardening. SvelteKit now sends a policy with each page, and writes it as a meta tag into the offline shell:

`default-src 'self'; script-src 'self' 'wasm-unsafe-eval' <hash of the start-up script>; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`

`hooks.server.ts` adds `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and `X-Frame-Options: DENY` to every rendered response that does not set its own. The API already sent `Cache-Control: no-store` and `nosniff` on every JSON response, including errors, and the blog already had a strict policy of its own; both are unchanged. All four browser suites pass with the policy. `style-src` keeps `'unsafe-inline'` because the app shell and Svelte use inline styles. Not added: `Strict-Transport-Security`, which belongs to the deployment's domain decision; it is recommended once the custom domain is settled (`max-age=31536000`).

### 5. Server running as root (low, fixed)

The Dockerfile ran `node` as root so it could write to a root-owned volume. It now starts `scripts/docker-start.sh`, which gives the data directory to the image's `node` user (recursively, only while its top folder belongs to someone else, as a freshly mounted volume does), then drops root with `setpriv` and starts the server. The app's own files stay root-owned. `railway.json`'s start command is the same script. The script was tested locally (privilege drop, ownership hand-over); **the image itself was not built** (no Docker daemon in the review environment), so the first deploy should be watched: the health check fails clearly if something is wrong.

### 6. Over-long file or folder names (low, fixed)

The path rule allowed any segment length within the 1024-byte path limit. Demonstration: `PUT /api/brains/{b}/notes/memos/<300 × "x">.md` answered 500, and the server log line carried the note's full file system path; a sync carrying such a note failed as a whole, every time, so that device could never sync again. `syncPathProblem` (core, shared by server and clients) now refuses a segment over 255 UTF-8 bytes: the server answers 400 and devices leave the note out of sync, as they do for other paths sync cannot carry.

### 7. A note and a folder with the same name (low, fixed)

Saving `memos/a.md/b.md` next to an existing `memos/a.md` (or `memos/a.md` where a folder `memos/a.md/` exists) answered 500 and logged the full path. The content store now refuses it as `exists` (409). **Left for the owner:** a sync that carries such a note still fails as a whole (now with 409 instead of 500), so a device holding both a note and a "folder" of the same name stays stuck. Answering `refused` for just that edit is the natural fix, but the client then keeps a conflict copy beside the note, which clashes again, and would create a new copy on every sync. It needs a protocol decision (for example a refusal code the client does not copy, or conflict copies placed outside the clashing folder).

**Fixed afterwards.** The server judges such an edit (a new note, or a rename's target, that clashes with a file or folder on the server or with another new path in the same request) as `refused` with code `name-clash`, so the rest of the sync goes through. A client that gets that code makes no conflict copy: it keeps the note where it is, records the path in its sync state, leaves it out of later requests while a note is at that path, and reports it like a note too large to sync (`runSync`'s `nameClash`, the CLI's `sync` warning and JSON, the app's sync details). Renaming the note clears it. A server note that would land inside such a kept note's name is skipped on that copy (a copy that keeps files could not store it); it arrives with a sync from the start once the clash is renamed. Tested over several syncs in `packages/server/src/sync.test.ts` and through the CLI in `packages/cli/src/remote/remote.test.ts`.

### 8. HTML comments in published posts (low, fixed)

The public renderer runs with raw HTML off, so `<!-- remark -->` in a published post is shown as the literal text `<!-- remark -->`, while the app (which allows sanitized HTML) shows nothing. An author who keeps private remarks in comments, a common markdown habit, would publish them. Options: drop HTML comments (and Obsidian-style `%% … %%` comments, if supported) from blog bodies before rendering, or document that everything in a published post is public.

**Fixed afterwards.** The public renderer now reads HTML comments as CommonMark does and drops them: a block comment (a line starting `<!--`, through the line holding `-->`, blank lines included) and inline comments within a paragraph; text in code spans and code blocks is untouched, and an unclosed inline `<!--` stays visible text, as in the app. The post's title and summary (page title, feed, meta description) leave comments out too, including a heading inside a multi-line comment. The app's preview already showed nothing for comments (it passes them to the browser as comments), so both now show the same visible text. Obsidian-style `%% … %%` comments are not handled. Tests: `apps/web/src/lib/server/blog/render.test.ts`, `packages/server/src/blog.test.ts`, `packages/core/src/markdown/inline.test.ts`.

### 9. Images from any https address (low, left for the owner)

Notes may embed `<img src="https://…">` or `![](https://…)`, and the app's CSP allows `img-src https:` to keep that working. A note synced from a compromised device can therefore make the owner's browser contact a chosen host when the note is opened (revealing the owner's address and when they read it). Restricting `img-src` to `'self' data: blob:` closes this, at the cost of remote images in notes.

### 10. The CLI accepts `http://` servers (low, fixed)

`packages/cli/src/remote/config.ts` accepts `http:` server URLs, so the bearer token can be sent in clear over a network. Suggest refusing `http:` except for `localhost`, `127.0.0.1` and `::1`. (Left alone: another change to the CLI is in progress.)

**Fixed afterwards.** Every remote client the CLI makes (connect, clone, sync, working folders, environment-only mode, history, config) refuses an `http://` server before sending anything, unless its host is `localhost`, `127.0.0.1` or `[::1]`, with a one-line error naming the override: `--allow-insecure` on `connect`, `clone` and `sync`, or `SOMEMEMOS_ALLOW_INSECURE=1`. The override is not recorded, so it stays a choice made each time. Redirects were already refused, so an `https://` server cannot downgrade a request. Tests: `packages/cli/src/remote/client.test.ts`, `packages/cli/src/commands/commands.test.ts`.

### 11. Shared namespaces (low, accepted)

On a future multi-user server, `POST /api/brains` answers `brain-exists` for another user's brain id, and `PUT …/blog` answers `slug-taken` for another user's (even disabled) blog slug, so a user can learn that an id or slug is in use. Nothing else about the other brain is reachable (verified below). Accepted for a single-user server; per-user id namespaces would remove it later.

## Checked and found sound

- **Access on every route.** Every `/api/brains…` route requires a token (the existing test covers them all; health is the only open route). Token comparison hashes the presented token and compares SHA-256 digests with `timingSafeEqual` against every configured token, so neither length nor content leaks through timing. The configuration never echoes a secret; `/api/health` shows the version and migration state only.
- **Brain isolation.** With two users, all 21 brain routes (including blog settings, history, versions by commit and by hash, restore and sync) answered 404 for the other user's brain, and restoring or reading another brain's commit through one's own brain answered 404. Every SQL query in the server and pg-store is parameterized and filtered by `brain_id`; the only interpolated identifiers are internal table names.
- **Paths.** URL segments are decoded once and checked by the shared path rule: no absolute paths, `..`, empty segments, dot folders (`.git`, `.somememos`), backslashes, control characters or NUL, non-NFC Unicode, non-`.md` names, and (now) no over-long names. Encoded slashes in a brain id are refused by the id pattern. The content store re-checks every path, never follows a user-chosen symlink (notes are only ever written as regular files), and lists no dot entries.
- **Git.** Every `git` call runs with a minimal environment (no `GIT_*` variables passed on, no system or global config, no pager, editor or prompts) and `-c` overrides that disable hooks, attributes and excludes files. Commits are made with plumbing; messages go through stdin, author names through the environment after removing `<`, `>`, newlines and NUL; commit ids are checked as full hex before use; paths never appear as arguments (only as `commit:path` lines on `cat-file --batch` stdin, with newlines refused). No argument injection was found.
- **Requests.** Bodies are size-limited while streaming (32 MiB for sync, about 4 MiB otherwise) and must be declared JSON; sync requests are validated field by field with counts limited. (Since this review, every body, query string and path parameter is checked by a valibot schema instead of hand-written code; a test pins each route's accepted and refused inputs. The change also refused what had slipped through: unknown fields in note save, rename, restore and diary bodies, over-long delete messages, non-decimal numbers in query strings, note paths with a lone UTF-16 surrogate, and a body that is not UTF-8, which had been a 500.) Cross-origin requests are refused (no CORS headers; a foreign `Origin` gets 403), and the token is never sent automatically by a browser, so cross-site request forgery has nothing to use. Errors never name a note except to the brain's owner.
- **The public blog boundary.** A blog is found only by its public slug when enabled; posts come only from the recorded commit, only from `blog`-role paths, only with `published: true` (unquoted), and drafts are dropped before address collisions are settled, so a draft can never take or reveal an address. `[[links]]` resolve only among published posts; other links, embeds and images show the author's text only; relative links are dropped; raw HTML is escaped. Every non-public address gets the same 404 bytes and headers, decided before any brain-specific work beyond the slug lookup, and a disabled blog is indistinguishable from a missing one. ETags hash the rendered page only. The feed, sitemap and `robots.txt` list published posts and enabled blogs only. The blog's CSP allows no scripts at all.
- **Parsers.** Front matter detection, the block scanner, link extraction, the publish check, the keyword tokenizer and markdown-it itself are linear on every hostile input tried.
- **Web client.** The token is kept in the brain's own database on the device (same origin), sent only to the app's own `/api`, scrubbed from error messages, and shown only as its last four characters. The service worker never caches API responses or blog pages; it serves only precached build files. Rendered notes are sanitized with DOMPurify (no scripts, forms or style elements).
- **Dependencies.** `npm audit --omit=dev` reports no known vulnerabilities. CI runs on `pull_request` (not `pull_request_target`) with no secrets.

## Not checked

- The CLI beyond its token handling and server URL check, the importer in the web app, `packages/sqlite-store`, and the evaluation tooling.
- The Docker image was not built or run, and nothing was deployed; Railway's proxy behaviour (`X-Forwarded-For`) was taken from its documentation.
- Denial of service by an authenticated owner against their own server (unbounded `limit` parameters on search and log, very large brains) was considered out of scope for a single-user server.
- Front-end interactions beyond rendering (the editor, import panel and settings screens) were not reviewed for logic errors.
- A note's inline `style` attributes are kept by the app's sanitizer, so a hostile synced note can restyle its own area of the page (for example an overlay inside the note view). This was not judged worth changing tonight; forbidding `style` in `renderMarkdown` would remove it.

## What the owner must decide

1. ~~The lockout trade-off in finding 3.~~ Settled: throttle failures, never refuse a valid token.
2. ~~How sync should treat a note and folder with the same name (finding 7).~~ Settled: a `name-clash` refusal the client does not copy.
3. ~~Whether HTML comments in published posts should be dropped (finding 8).~~ Settled: dropped.
4. Whether remote images in notes are worth the tracking risk (finding 9).
5. ~~Whether the CLI should refuse plain `http://` servers (finding 10).~~ Settled: refused, with an explicit override.
6. A contact line in `SECURITY.md`, and HSTS once the domain is settled.
