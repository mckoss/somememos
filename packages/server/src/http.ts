// The server's HTTP API, on web-standard `Request` and `Response`, so the
// SvelteKit app mounts it with one catch-all route (apps/web/src/routes/api)
// and tests call it directly. Routes (all JSON; all but health need
// `Authorization: Bearer <token>`):
//
//   GET    /api/health
//   GET    /api/brains                         → { brains: BrainInfo[] }
//   POST   /api/brains        { id, config? }  → 201 BrainInfo
//   GET    /api/brains/{b}                     → BrainInfo & { config, configRevision }
//   GET    /api/brains/{b}/config              → { revision, config }
//   PUT    /api/brains/{b}/config { baseRevision, config } → { status, revision, config } (409 config-conflict)
//   POST   /api/brains/{b}/sync   SyncRequest  → SyncResponse (409 config-changed when its configRevision is stale)
//   GET    /api/brains/{b}/search?q=&mode=&limit=&since=&until=  → SearchResponse
//   GET    /api/brains/{b}/list?mode=&limit=                     → SearchResponse
//   GET    /api/brains/{b}/notes/{path}?record=false             → NoteView (logs a read)
//   PUT    /api/brains/{b}/notes/{path}  { text, baseHash?, message? } → SaveResult (409 on conflict)
//   DELETE /api/brains/{b}/notes/{path}?message=                 → DeleteResult
//   POST   /api/brains/{b}/rename { from, to, message? }         → RenameResult
//   POST   /api/brains/{b}/changes { message?, ops }             → BatchResult (409: nothing applied, stale files listed)
//   GET    /api/brains/{b}/notes/{path}/history?limit=           → NoteHistory
//   GET    /api/brains/{b}/notes/{path}/versions/{commit}        → PastVersion
//   GET    /api/brains/{b}/notes/{path}/versions?hash=           → PastVersion (the latest with that hash)
//   POST   /api/brains/{b}/notes/{path}/restore { commit, baseHash?, message? } → SaveResult
//   GET    /api/brains/{b}/log?path=&op=&since=&until=&limit=&all=&q=  → { changes } (q: message words)
//   GET    /api/brains/{b}/status                                → EngineStatus
//   GET    /api/brains/{b}/titles                                → { notes: NoteTitle[] }
//   GET    /api/brains/{b}/dangling                              → { dangling: DanglingCount[] }
//   GET    /api/brains/{b}/diary?date=                           → DiaryPath
//   POST   /api/brains/{b}/diary  { date? }                      → DiaryEntry
//   GET    /api/brains/{b}/blog                                  → BlogSettingsView
//   PUT    /api/brains/{b}/blog   BlogSettings                   → BlogSettingsView (409 slug-taken)
//   GET    /api/brains/{b}/blog/slug?slug=                       → { slug, available, taken, problem }
//   GET    /api/brains/{b}/blog/address?path=                    → { url } (null unless the blog is on and path is a post)
//
// The public blog pages themselves are not here: `App.blogs` (./blog.ts)
// serves their data and apps/web renders them under /blog.
//
// A request may name its client with `X-Somememos-Client: <client id>`: the
// server's engine records events and change records under it, and git
// commits are authored by it.
//
// Requests that log nothing (search, list, log, status, titles, dangling,
// history and versions, GET diary, a note read with `record=false`) run
// without the brain's lock on a read-only snapshot (`BrainService.readBrain`);
// everything else is serialized per brain (`BrainService.withBrain`).
//
// Every body, query string and path parameter is checked by a schema
// (./requests.ts and core's sync schemas) before a route does anything.
//
// Errors are `{ error: { code, message, path? } }` with a proper status.
// Cross-origin browser requests are refused: there are no CORS headers, and
// a request whose Origin is another host gets 403.

import { VERSION, engine as coreEngine, markdown, storage, sync } from '@somememos/core';
import { ensureMigrated, MIGRATIONS } from '@somememos/pg-store';
import pg from 'pg';
import type * as v from 'valibot';
import { FailureLimiter, tokenAuthorizer, type Authorizer } from './auth.js';
import { PublicBlogs } from './blog.js';
import { parseBlogSettings, readBlogSettings, writeBlogSettings } from './blog-settings.js';
import { checkBlogSlug, postAddress } from './blog-owner.js';
import { applyBatch, parseBatch } from './batch.js';
import { BrainError, BrainService, CLIENT_ID, type BrainContext } from './brains.js';
import { loadServerConfig, type ServerConfig } from './config.js';
import { ENGINE_ERROR_STATUS, HttpError } from './errors.js';
import { noteHistory, pastVersion } from './history.js';
import { parseSyncRequest, runSync } from './sync.js';
import {
  AddressQuery,
  CommitIdSchema,
  CreateBrainBody,
  DeleteQuery,
  DiaryBody,
  DiaryQuery,
  HistoryQuery,
  ListQuery,
  LogQuery,
  ReadQuery,
  RenameBody,
  RestoreBody,
  SaveNoteBody,
  SearchQuery,
  SlugQuery,
  VersionQuery,
  fieldCodes,
  parseQuery,
  parseRequest,
} from './requests.js';
import {
  checkSyncConfigRevision,
  parseConfigPut,
  putSharedConfig,
  readSharedConfig,
} from './config-sync.js';

export interface RequestInfo {
  /** The client's address, for rate limiting failed attempts. */
  readonly clientAddress?: string;
}

export interface App {
  handle(request: Request, info?: RequestInfo): Promise<Response>;
  /** Validates, connects and migrates; logs and keeps serving (503) on failure. */
  start(): Promise<void>;
  close(): Promise<void>;
  readonly service: BrainService | null;
  /** The public blogs (./blog.ts), when there is a database. */
  readonly blogs: PublicBlogs | null;
}

export interface AppOptions {
  /** A valid config, or the problems found in it (the API then answers 503). */
  readonly config: ServerConfig | { readonly problems: readonly string[] };
  /** Defaults to a pool on `config.databaseUrl`. */
  readonly pool?: pg.Pool;
  /** Defaults to the token authorizer over `config.tokens`. */
  readonly authorizer?: Authorizer;
  readonly limiter?: FailureLimiter;
  readonly now?: () => number;
  /** Passed to the brain service (tests). */
  readonly beforeDatabaseCommit?: (brainId: string) => void | Promise<void>;
  /** Where to log; default `console`. */
  readonly log?: Pick<Console, 'error' | 'info' | 'warn'>;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  extra: object = {},
  headers = {},
) {
  return json(status, { error: { code, message, ...extra } }, headers);
}

/** The request body as JSON, refusing a body over `limit` bytes or not declared as JSON. */
async function readJson(request: Request, limit: number): Promise<unknown> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(type)) {
    throw new HttpError(
      415,
      'unsupported-media-type',
      'send a JSON body (Content-Type: application/json)',
    );
  }
  const declared = Number(request.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, 'too-large', `the request body is larger than ${limit} bytes`);
  }
  if (!request.body) throw new HttpError(400, 'invalid-request', 'the request has no body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, 'too-large', `the request body is larger than ${limit} bytes`);
    }
    chunks.push(value);
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid-json', 'the request body is not valid UTF-8 JSON');
  }
}

/** Small bodies (everything but sync). */
const SMALL_BODY = sync.SYNC_LIMITS.maxNoteBytes * 2 + 64 * 1024;

function decodeSegments(segments: readonly string[]): string[] {
  try {
    return segments.map((s) => decodeURIComponent(s));
  } catch {
    throw new HttpError(400, 'invalid-path', 'the URL is not correctly percent-encoded');
  }
}

/** A note path from the URL, checked as sync checks it (no `..`, no dot folders, …). */
function notePath(value: string): string {
  return parseRequest(sync.NotePathSchema, value, () => [400, 'invalid-path'], 'the note path');
}

/** A request body checked by `schema`, with the usual codes (./requests.ts). */
const body = async <S extends v.GenericSchema>(
  request: Request,
  schema: S,
): Promise<v.InferOutput<S>> =>
  parseRequest(schema, await readJson(request, SMALL_BODY), fieldCodes());

/** Creates the API from a config (see `createAppFromEnv` for the usual way). */
export function createApp(options: AppOptions): App {
  const log = options.log ?? console;
  const problems = 'problems' in options.config ? options.config.problems : null;
  const config = 'problems' in options.config ? null : options.config;
  const pool =
    options.pool ??
    (config?.databaseUrl ? new pg.Pool({ connectionString: config.databaseUrl, max: 10 }) : null);
  pool?.on('error', (error) => log.error(`somememos: database connection error: ${error.message}`));
  const service =
    pool && config?.dataDir
      ? new BrainService({
          pool,
          dataDir: config.dataDir,
          ...(options.now ? { now: options.now } : {}),
          ...(options.beforeDatabaseCommit
            ? { beforeDatabaseCommit: options.beforeDatabaseCommit }
            : {}),
        })
      : null;
  const blogs = service
    ? new PublicBlogs({ pool: service.pool, repoDir: (id) => service.repoDir(id) })
    : null;
  const authorizer = options.authorizer ?? (config ? tokenAuthorizer(config.tokens) : null);
  const limiter = options.limiter ?? new FailureLimiter();
  const pageSize = config?.pageSize ?? 2000;

  const unavailable = (): Response | null => {
    if (problems) {
      return errorResponse(
        503,
        'server-misconfigured',
        `the server's configuration is invalid: ${problems.join('; ')}`,
      );
    }
    if (!service) {
      return errorResponse(
        503,
        'no-database',
        'this server has no database (DATABASE_URL is not set), so it offers no API; the web app works on its own',
      );
    }
    return null;
  };

  const health = async (): Promise<Response> => {
    const body: Record<string, unknown> = { version: VERSION };
    if (problems) {
      return json(503, { ...body, status: 'misconfigured', problems });
    }
    if (!pool) {
      return json(200, { ...body, status: 'ok', database: { configured: false } });
    }
    try {
      const { rows } = await pool.query<{ v: number | null }>(
        `SELECT max(version) AS v FROM schema_migrations`,
      );
      const current = rows[0]?.v ?? 0;
      const expected = Math.max(...MIGRATIONS.map((m) => m.version));
      const ok = current === expected;
      return json(ok ? 200 : 503, {
        ...body,
        status: ok ? 'ok' : 'migrations-pending',
        database: { configured: true, connected: true, migration: { current, expected } },
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      const missing = code === '42P01'; // schema_migrations does not exist yet
      return json(503, {
        ...body,
        status: missing ? 'migrations-pending' : 'database-unreachable',
        database: {
          configured: true,
          connected: missing,
          ...(missing
            ? { migration: { current: 0, expected: Math.max(...MIGRATIONS.map((m) => m.version)) } }
            : { error: 'cannot reach the database' }),
        },
      });
    }
  };

  const route = async (request: Request, segments: string[], owner: string): Promise<Response> => {
    const svc = service as BrainService;
    const method = request.method;
    const url = new URL(request.url);
    const params = url.searchParams;

    if (segments.length === 1) {
      if (method === 'GET') return json(200, { brains: await svc.list(owner) });
      if (method === 'POST') {
        const { id, config } = await body(request, CreateBrainBody);
        return json(201, await svc.create(owner, id, config));
      }
      throw new HttpError(405, 'method-not-allowed', 'use GET or POST');
    }

    const brainId = segments[1] as string;
    const rest = segments.slice(2);
    const clientHeader = request.headers.get('x-somememos-client');
    if (clientHeader !== null && !CLIENT_ID.test(clientHeader)) {
      throw new HttpError(400, 'invalid-argument', 'X-Somememos-Client must be a client id');
    }
    const clientId = clientHeader ?? undefined;
    const withBrain = <T>(fn: (ctx: BrainContext) => Promise<T>): Promise<T> =>
      svc.withBrain(owner, brainId, clientId ? { clientId } : {}, fn);
    // A pure read that logs nothing: no brain lock, no repository check (brains.ts).
    const readBrain = <T>(fn: (ctx: BrainContext) => Promise<T>): Promise<T> =>
      svc.readBrain(owner, brainId, clientId ? { clientId } : {}, fn);
    const allow = (...methods: string[]) => {
      if (!methods.includes(method)) {
        throw new HttpError(405, 'method-not-allowed', `use ${methods.join(' or ')}`, {
          allow: methods.join(', '),
        });
      }
    };

    if (rest.length === 0) {
      allow('GET');
      return json(200, await svc.get(owner, brainId));
    }
    const [action, ...tail] = rest as [string, ...string[]];

    if (action === 'sync' && tail.length === 0) {
      allow('POST');
      const body = await readJson(request, sync.SYNC_LIMITS.maxRequestBytes);
      return json(
        200,
        await withBrain(async (ctx) => {
          const classifier = markdown.createRoleClassifier(ctx.config.roles);
          const parsed = parseSyncRequest(body, classifier, ctx.now);
          await checkSyncConfigRevision(ctx, parsed.configRevision);
          return runSync(ctx, parsed, pageSize);
        }),
      );
    }

    if (action === 'changes' && tail.length === 0) {
      // One change set of writes, deletes and renames, all or none (./batch.ts).
      allow('POST');
      const batch = parseBatch(await readJson(request, sync.SYNC_LIMITS.maxRequestBytes));
      const result = await withBrain((ctx) => applyBatch(ctx, batch));
      return json(result.status === 'conflict' ? 409 : 200, result);
    }

    if (action === 'config' && tail.length === 0) {
      // The brain's shared config (./config-sync.ts).
      allow('GET', 'PUT');
      if (method === 'GET') return json(200, await readBrain((ctx) => readSharedConfig(ctx)));
      const put = parseConfigPut(await readJson(request, SMALL_BODY));
      return json(200, await withBrain((ctx) => putSharedConfig(ctx, put)));
    }

    if (action === 'blog' && tail.length === 1 && (tail[0] === 'slug' || tail[0] === 'address')) {
      // The owner's slug check and a post's public address (./blog-owner.ts).
      allow('GET');
      await svc.get(owner, brainId);
      if (tail[0] === 'slug') {
        const { slug } = parseQuery(SlugQuery, params);
        return json(200, await checkBlogSlug(svc.pool, brainId, slug));
      }
      const { path } = parseQuery(AddressQuery, params);
      return json(200, await postAddress(svc.pool, brainId, path));
    }

    if (action === 'blog' && tail.length === 0) {
      // The brain's blog settings (./blog-settings.ts); the owner only.
      allow('GET', 'PUT');
      await svc.get(owner, brainId);
      if (method === 'GET') return json(200, await readBlogSettings(svc.pool, brainId));
      const settings = parseBlogSettings(await readJson(request, SMALL_BODY));
      const now = (options.now ?? storage.unixNow)();
      return json(200, await writeBlogSettings(svc.pool, brainId, settings, now));
    }

    if (action === 'notes' && tail.length > 0) {
      const decoded = decodeSegments(tail);
      const last = decoded.at(-1) as string;
      // .../{path}/history, .../{path}/versions[/{commit}], .../{path}/restore
      if (last === 'history' && decoded.length > 1) {
        allow('GET');
        const path = notePath(decoded.slice(0, -1).join('/'));
        const { limit } = parseQuery(HistoryQuery, params);
        return json(200, await readBrain((ctx) => noteHistory(ctx, checkRole(ctx, path), limit)));
      }
      if (decoded.length > 2 && decoded.at(-2) === 'versions') {
        allow('GET');
        const path = notePath(decoded.slice(0, -2).join('/'));
        const commit = parseRequest(
          CommitIdSchema,
          last,
          () => [400, 'invalid-argument'],
          'the commit',
        );
        return json(200, await readBrain((ctx) => pastVersion(ctx, checkRole(ctx, path), commit)));
      }
      if (last === 'versions' && decoded.length > 1) {
        allow('GET');
        const path = notePath(decoded.slice(0, -1).join('/'));
        const { hash } = parseQuery(VersionQuery, params);
        return json(
          200,
          await readBrain(async (ctx) => {
            const rows = await ctx.query<{ commit: string }>(
              `SELECT commit FROM note_versions WHERE brain_id = $1 AND path = $2 AND hash = $3
               ORDER BY mutation DESC LIMIT 1`,
              [ctx.brainId, checkRole(ctx, path), hash],
            );
            if (!rows[0])
              throw new HttpError(404, 'not-found', 'no version of that note has that hash');
            return pastVersion(ctx, path, rows[0].commit);
          }),
        );
      }
      if (last === 'restore' && decoded.length > 1) {
        allow('POST');
        const path = notePath(decoded.slice(0, -1).join('/'));
        const { commit, baseHash, message } = await body(request, RestoreBody);
        const result = await withBrain(async (ctx) => {
          const past = await pastVersion(ctx, checkRole(ctx, path), commit);
          return ctx.engine.saveNote(path, past.text, {
            ...(baseHash !== undefined ? { baseHash } : {}),
            message: message ?? `restore ${path} to its version of ${past.commit.slice(0, 12)}`,
          });
        });
        return json(result.status === 'conflict' ? 409 : 200, result);
      }
      const path = notePath(decoded.join('/'));
      if (method === 'GET') {
        const { record } = parseQuery(ReadQuery, params);
        // A read that logs nothing needs no lock; one that logs a read event does.
        const run = record === false ? readBrain : withBrain;
        return json(
          200,
          await run((ctx) => ctx.engine.readNote(path, record === undefined ? {} : { record })),
        );
      }
      if (method === 'PUT') {
        const { text, baseHash, message } = await body(request, SaveNoteBody);
        const opts = {
          ...(baseHash !== undefined ? { baseHash } : {}),
          ...(message != null ? { message } : {}),
        };
        const result = await withBrain((ctx) => ctx.engine.saveNote(path, text, opts));
        return json(result.status === 'conflict' ? 409 : 200, result);
      }
      if (method === 'DELETE') {
        const { message } = parseQuery(DeleteQuery, params);
        return json(
          200,
          await withBrain((ctx) =>
            ctx.engine.deleteNote(path, message !== undefined ? { message } : {}),
          ),
        );
      }
      throw new HttpError(405, 'method-not-allowed', 'use GET, PUT or DELETE', {
        allow: 'GET, PUT, DELETE',
      });
    }

    if (tail.length > 0) throw new HttpError(404, 'not-found', 'no such route');
    switch (action) {
      case 'search': {
        allow('GET');
        const { q, mode, limit, since, until } = parseQuery(SearchQuery, params);
        return json(
          200,
          await readBrain((ctx) =>
            ctx.engine.search(q, {
              ...(mode ? { mode } : {}),
              ...(limit !== undefined ? { limit } : {}),
              ...(since !== undefined ? { since } : {}),
              ...(until !== undefined ? { until } : {}),
            }),
          ),
        );
      }
      case 'list': {
        allow('GET');
        const { mode, limit } = parseQuery(ListQuery, params);
        return json(
          200,
          await readBrain((ctx) =>
            ctx.engine.list(mode ?? 'hot', limit !== undefined ? { limit } : {}),
          ),
        );
      }
      case 'rename': {
        allow('POST');
        const { from, to, message } = await body(request, RenameBody);
        return json(
          200,
          await withBrain((ctx) =>
            ctx.engine.renameNote(from, to, message != null ? { message } : {}),
          ),
        );
      }
      case 'log': {
        allow('GET');
        const { path, op, since, until, limit, all, q: query } = parseQuery(LogQuery, params);
        const changes = await readBrain((ctx) =>
          ctx.engine.log({
            ...(path !== undefined ? { path } : {}),
            ...(op !== undefined ? { op } : {}),
            ...(query !== undefined ? { query } : {}),
            ...(since !== undefined ? { since } : {}),
            ...(until !== undefined ? { until } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(all !== undefined ? { all } : {}),
          }),
        );
        return json(200, { changes });
      }
      case 'status':
        allow('GET');
        return json(200, await readBrain((ctx) => ctx.engine.status()));
      case 'titles':
        allow('GET');
        return json(200, { notes: await readBrain((ctx) => ctx.engine.noteTitles()) });
      case 'dangling':
        allow('GET');
        return json(200, { dangling: await readBrain((ctx) => ctx.engine.danglingLinks()) });
      case 'diary': {
        const date =
          method === 'POST'
            ? ((await body(request, DiaryBody)).date ?? undefined)
            : parseQuery(DiaryQuery, params).date;
        if (method === 'GET')
          return json(200, await readBrain((ctx) => ctx.engine.diaryPath(date)));
        allow('POST');
        // The server records every file it writes: the new entry gets a change record.
        return json(
          200,
          await withBrain((ctx) => ctx.engine.ensureDiary(date, { uncommitted: true })),
        );
      }
      default:
        throw new HttpError(404, 'not-found', 'no such route');
    }
  };

  const handle = async (request: Request, info: RequestInfo = {}): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return errorResponse(400, 'invalid-request', 'bad URL');
    }
    const raw = url.pathname.replace(/\/+$/, '').split('/').slice(1); // ['api', ...]
    if (raw[0] !== 'api') return errorResponse(404, 'not-found', 'no such route');
    const segments = raw.slice(1);
    try {
      // Same origin only: browsers on other origins get no CORS headers, and
      // a cross-origin request that would not need a preflight is refused here.
      const origin = request.headers.get('origin');
      if (origin !== null) {
        let host: string | null = null;
        try {
          host = new URL(origin).host;
        } catch {
          host = null; // "null" (a sandboxed page or file) or garbage
        }
        if (host !== url.host)
          throw new HttpError(403, 'cross-origin', 'cross-origin requests are not allowed');
      }
      if (request.method === 'OPTIONS') {
        throw new HttpError(405, 'method-not-allowed', 'cross-origin requests are not allowed');
      }

      if (segments.length === 1 && segments[0] === 'health') {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          throw new HttpError(405, 'method-not-allowed', 'use GET', { allow: 'GET' });
        }
        return await health();
      }
      if (segments[0] !== 'brains') throw new HttpError(404, 'not-found', 'no such route');

      const down = unavailable();
      if (down) return down;

      const address = info.clientAddress ?? 'unknown';
      const admission = limiter.admit(address);
      if (admission.kind === 'refuse') {
        throw new HttpError(429, 'too-many-attempts', 'too many failed attempts; try again later', {
          'retry-after': String(admission.retryAfter),
        });
      }
      // A throttled address waits for its turn before its token is compared,
      // so it learns nothing sooner by giving up on a slow answer.
      if (admission.delayMs > 0) await new Promise((r) => setTimeout(r, admission.delayMs));
      const principal = await (authorizer as Authorizer).authorize(request);
      if (!principal) {
        limiter.fail(address);
        if (limiter.throttled(address)) {
          throw new HttpError(
            429,
            'too-many-attempts',
            'too many failed attempts; try again later',
            {
              'retry-after': String(limiter.retryAfter()),
            },
          );
        }
        throw new HttpError(401, 'unauthorized', 'a valid bearer token is required', {
          'www-authenticate': 'Bearer realm="somememos"',
        });
      }
      return await route(
        request,
        decodeSegments(segments.slice(0, 2)).concat(segments.slice(2)),
        principal.userId,
      );
    } catch (error) {
      if (error instanceof HttpError) {
        return errorResponse(error.status, error.code, error.message, error.extra, error.headers);
      }
      if (error instanceof BrainError)
        return errorResponse(error.status, error.code, error.message);
      if (error instanceof coreEngine.EngineError) {
        const status = ENGINE_ERROR_STATUS[error.code] ?? 400;
        return errorResponse(
          status,
          error.code,
          error.message,
          error.path !== null ? { path: error.path } : {},
        );
      }
      log.error(
        `somememos: ${request.method} ${url.pathname.split('/').slice(0, 4).join('/')} failed: ${(error as Error)?.stack ?? String(error)}`,
      );
      return errorResponse(500, 'internal', 'the server failed to handle this request');
    }
  };

  return {
    handle,
    service,
    blogs,
    async start() {
      if (problems) {
        log.error(
          `somememos: the server configuration is invalid, so the API answers 503:\n  - ${problems.join('\n  - ')}`,
        );
        return;
      }
      if (!service) {
        log.info('somememos: DATABASE_URL is not set; serving the web app without an API');
        return;
      }
      try {
        await service.migrate();
        await ensureMigrated(service.pool);
        log.info(`somememos ${VERSION}: database ready`);
      } catch (error) {
        log.error(`somememos: could not prepare the database: ${(error as Error).message}`);
      }
    },
    async close() {
      if (pool && !options.pool) await pool.end();
    },
  };
}

/**
 * The role check the engine makes, for routes that read git and the version
 * table directly: an excluded path is refused without being named, a path
 * with no role is not found.
 */
function checkRole(ctx: BrainContext, path: string): string {
  const role = markdown.createRoleClassifier(ctx.config.roles).classify(path)?.role;
  if (role === 'excluded') {
    throw new coreEngine.EngineError('excluded', 'that path is excluded from somememos', null);
  }
  if (role === undefined) {
    throw new coreEngine.EngineError(
      'not-found',
      "that path has no role in this brain's config",
      null,
    );
  }
  return path;
}

/** The app for this process's environment. */
export function createAppFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): App {
  const result = loadServerConfig(env);
  return createApp({ config: result.ok ? result.config : { problems: result.problems } });
}
