// The server's HTTP API, on web-standard `Request` and `Response`, so the
// SvelteKit app mounts it with one catch-all route (apps/web/src/routes/api)
// and tests call it directly. Routes (all JSON; all but health need
// `Authorization: Bearer <token>`):
//
//   GET    /api/health
//   GET    /api/brains                         → { brains: BrainInfo[] }
//   POST   /api/brains        { id, config? }  → 201 BrainInfo
//   GET    /api/brains/{b}                     → BrainInfo & { config }
//   POST   /api/brains/{b}/sync   SyncRequest  → SyncResponse
//   GET    /api/brains/{b}/search?q=&mode=&limit=&since=&until=  → SearchResponse
//   GET    /api/brains/{b}/list?mode=&limit=                     → SearchResponse
//   GET    /api/brains/{b}/notes/{path}?record=false             → NoteView (logs a read)
//   PUT    /api/brains/{b}/notes/{path}  { text, baseHash?, message? } → SaveResult (409 on conflict)
//   DELETE /api/brains/{b}/notes/{path}?message=                 → DeleteResult
//   POST   /api/brains/{b}/rename { from, to, message? }         → RenameResult
//   GET    /api/brains/{b}/notes/{path}/history?limit=           → NoteHistory
//   GET    /api/brains/{b}/notes/{path}/versions/{commit}        → PastVersion
//   GET    /api/brains/{b}/notes/{path}/versions?hash=           → PastVersion (the latest with that hash)
//   POST   /api/brains/{b}/notes/{path}/restore { commit, baseHash?, message? } → SaveResult
//   GET    /api/brains/{b}/log?path=&op=&since=&until=&limit=&all=  → { changes }
//   GET    /api/brains/{b}/status                                → EngineStatus
//   GET    /api/brains/{b}/titles                                → { notes: NoteTitle[] }
//   GET    /api/brains/{b}/dangling                              → { dangling: DanglingCount[] }
//   GET    /api/brains/{b}/diary?date=                           → DiaryPath
//   POST   /api/brains/{b}/diary  { date? }                      → DiaryEntry
//   GET    /api/brains/{b}/blog                                  → BlogSettingsView
//   PUT    /api/brains/{b}/blog   BlogSettings                   → BlogSettingsView (409 slug-taken)
//
// The public blog pages themselves are not here: `App.blogs` (./blog.ts)
// serves their data and apps/web renders them under /blog.
//
// A request may name its client with `X-Somememos-Client: <client id>`: the
// server's engine records events and change records under it, and git
// commits are authored by it.
//
// Errors are `{ error: { code, message, path? } }` with a proper status.
// Cross-origin browser requests are refused: there are no CORS headers, and
// a request whose Origin is another host gets 403.

import { VERSION, engine as coreEngine, markdown, storage, sync } from '@somememos/core';
import { ensureMigrated, MIGRATIONS } from '@somememos/pg-store';
import pg from 'pg';
import { FailureLimiter, tokenAuthorizer, type Authorizer } from './auth.js';
import { PublicBlogs } from './blog.js';
import { parseBlogSettings, readBlogSettings, writeBlogSettings } from './blog-settings.js';
import { BrainError, BrainService, CLIENT_ID, type BrainContext } from './brains.js';
import { loadServerConfig, type ServerConfig } from './config.js';
import { ENGINE_ERROR_STATUS, HttpError } from './errors.js';
import { noteHistory, pastVersion } from './history.js';
import { parseSyncRequest, runSync } from './sync.js';

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
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid-json', 'the request body is not valid JSON');
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

/** A note path from the URL or a body, checked as sync checks it (no `..`, no dot folders, …). */
function notePath(value: unknown): string {
  const problem = sync.syncPathProblem(value);
  if (problem !== null) throw new HttpError(400, 'invalid-path', problem);
  return value as string;
}

function intParam(params: URLSearchParams, name: string): number | undefined {
  const v = params.get(name);
  if (v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n))
    throw new HttpError(400, 'invalid-argument', `${name} must be an integer`);
  return n;
}

function boolParam(params: URLSearchParams, name: string): boolean | undefined {
  const v = params.get(name);
  if (v === null || v === '') return undefined;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new HttpError(400, 'invalid-argument', `${name} must be true or false`);
}

function stringParam(params: URLSearchParams, name: string): string | undefined {
  const v = params.get(name);
  return v === null ? undefined : v;
}

function object(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'invalid-request', 'the body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function optionalString(body: Record<string, unknown>, name: string): string | undefined {
  const v = body[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string')
    throw new HttpError(400, 'invalid-argument', `${name} must be a string`);
  if (v.length > sync.SYNC_LIMITS.maxMessageLength) {
    throw new HttpError(400, 'invalid-argument', `${name} is too long`);
  }
  return v;
}

function baseHashOf(body: Record<string, unknown>): { baseHash?: string | null } {
  if (!('baseHash' in body)) return {};
  const v = body.baseHash;
  if (v === null) return { baseHash: null };
  if (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) return { baseHash: v };
  throw new HttpError(400, 'invalid-argument', 'baseHash must be null or a SHA-256 hex hash');
}

const MODES = new Set(['hot', 'trending', 'neglected', 'all']);
function modeParam(params: URLSearchParams): coreEngine.RankMode | undefined {
  const mode = params.get('mode');
  if (mode === null || mode === '') return undefined;
  if (!MODES.has(mode))
    throw new HttpError(400, 'invalid-argument', 'mode must be hot, trending, neglected or all');
  return mode as coreEngine.RankMode;
}

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
        const body = object(await readJson(request, SMALL_BODY));
        for (const key of Object.keys(body)) {
          if (key !== 'id' && key !== 'config')
            throw new HttpError(400, 'invalid-request', `unknown field "${key}"`);
        }
        return json(201, await svc.create(owner, body.id, body.config));
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
        await withBrain((ctx) => {
          const classifier = markdown.createRoleClassifier(ctx.config.roles);
          return runSync(ctx, parseSyncRequest(body, classifier, ctx.now), pageSize);
        }),
      );
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
        const limit = intParam(params, 'limit') ?? 200;
        if (limit < 1 || limit > 1000)
          throw new HttpError(400, 'invalid-argument', 'limit must be 1 to 1000');
        return json(200, await withBrain((ctx) => noteHistory(ctx, checkRole(ctx, path), limit)));
      }
      if (decoded.length > 2 && decoded.at(-2) === 'versions') {
        allow('GET');
        const path = notePath(decoded.slice(0, -2).join('/'));
        return json(200, await withBrain((ctx) => pastVersion(ctx, checkRole(ctx, path), last)));
      }
      if (last === 'versions' && decoded.length > 1) {
        allow('GET');
        const path = notePath(decoded.slice(0, -1).join('/'));
        const hash = params.get('hash') ?? '';
        if (!/^[0-9a-f]{64}$/.test(hash))
          throw new HttpError(400, 'invalid-argument', 'hash must be a SHA-256 hex hash');
        return json(
          200,
          await withBrain(async (ctx) => {
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
        const body = object(await readJson(request, SMALL_BODY));
        const commit = body.commit;
        const message = optionalString(body, 'message');
        const base = baseHashOf(body);
        const result = await withBrain(async (ctx) => {
          const past = await pastVersion(ctx, checkRole(ctx, path), String(commit));
          return ctx.engine.saveNote(path, past.text, {
            ...base,
            message: message ?? `restore ${path} to its version of ${past.commit.slice(0, 12)}`,
          });
        });
        return json(result.status === 'conflict' ? 409 : 200, result);
      }
      const path = notePath(decoded.join('/'));
      if (method === 'GET') {
        const record = boolParam(params, 'record');
        return json(
          200,
          await withBrain((ctx) =>
            ctx.engine.readNote(path, record === undefined ? {} : { record }),
          ),
        );
      }
      if (method === 'PUT') {
        const body = object(await readJson(request, SMALL_BODY));
        if (typeof body.text !== 'string')
          throw new HttpError(400, 'invalid-argument', 'text must be a string');
        if (Buffer.byteLength(body.text, 'utf8') > sync.SYNC_LIMITS.maxNoteBytes) {
          throw new HttpError(413, 'too-large', 'the note is too large');
        }
        const message = optionalString(body, 'message');
        const opts = { ...baseHashOf(body), ...(message !== undefined ? { message } : {}) };
        const text = body.text;
        const result = await withBrain((ctx) => ctx.engine.saveNote(path, text, opts));
        return json(result.status === 'conflict' ? 409 : 200, result);
      }
      if (method === 'DELETE') {
        const message = stringParam(params, 'message');
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
        const q = params.get('q') ?? '';
        const mode = modeParam(params);
        const limit = intParam(params, 'limit');
        const since = stringParam(params, 'since');
        const until = stringParam(params, 'until');
        return json(
          200,
          await withBrain((ctx) =>
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
        const mode = modeParam(params);
        const limit = intParam(params, 'limit');
        return json(
          200,
          await withBrain((ctx) =>
            ctx.engine.list(mode ?? 'hot', limit !== undefined ? { limit } : {}),
          ),
        );
      }
      case 'rename': {
        allow('POST');
        const body = object(await readJson(request, SMALL_BODY));
        const from = notePath(body.from);
        const to = notePath(body.to);
        const message = optionalString(body, 'message');
        return json(
          200,
          await withBrain((ctx) =>
            ctx.engine.renameNote(from, to, message !== undefined ? { message } : {}),
          ),
        );
      }
      case 'log': {
        allow('GET');
        const path = stringParam(params, 'path');
        const op = stringParam(params, 'op');
        const since = intParam(params, 'since');
        const until = intParam(params, 'until');
        const limit = intParam(params, 'limit');
        const all = boolParam(params, 'all');
        const changes = await withBrain((ctx) =>
          ctx.engine.log({
            ...(path !== undefined ? { path: notePath(path) } : {}),
            ...(op !== undefined ? { op } : {}),
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
        return json(200, await withBrain((ctx) => ctx.engine.status()));
      case 'titles':
        allow('GET');
        return json(200, { notes: await withBrain((ctx) => ctx.engine.noteTitles()) });
      case 'dangling':
        allow('GET');
        return json(200, { dangling: await withBrain((ctx) => ctx.engine.danglingLinks()) });
      case 'diary': {
        const date =
          method === 'POST'
            ? optionalString(object(await readJson(request, SMALL_BODY)), 'date')
            : stringParam(params, 'date');
        if (method === 'GET')
          return json(200, await withBrain((ctx) => ctx.engine.diaryPath(date)));
        allow('POST');
        return json(200, await withBrain((ctx) => ctx.engine.ensureDiary(date)));
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
      const wait = limiter.blockedFor(address);
      if (wait > 0) {
        throw new HttpError(429, 'too-many-attempts', 'too many failed attempts; try again later', {
          'retry-after': String(wait),
        });
      }
      const principal = await (authorizer as Authorizer).authorize(request);
      if (!principal) {
        limiter.fail(address);
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
        return errorResponse(error.status, error.code, error.message, {}, error.headers);
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
