// The CLI's HTTP client for the somememos server (packages/server/src/http.ts):
// JSON requests with the bearer token, the client id in `X-Somememos-Client`,
// a timeout, one retry on a network failure for idempotent requests, and the
// server's `{ error: { code, message, path? } }` bodies turned back into
// `EngineError`s (same codes) or one-line `CommandError`s.
//
// The token is only ever placed in the Authorization header. No message this
// module builds contains it, and none echoes a request body (note text).

import { engine } from '@somememos/core';
import { CommandError } from '../brain/output.js';

/** The engine's error codes: a server error with one of these becomes an `EngineError`. */
const ENGINE_CODES: ReadonlySet<string> = new Set<engine.EngineErrorCode>([
  'invalid-path',
  'invalid-argument',
  'excluded',
  'not-found',
  'exists',
  'source-immutable',
  'no-dated-pattern',
]);

/** A failure talking to the server: unreachable, refused, or an error it answered with. */
export class RemoteError extends CommandError {
  override name = 'RemoteError';
  constructor(
    message: string,
    /** The HTTP status, or 0 when no response arrived. */
    readonly status: number,
    /** The server's error code, or a client-side one (`unreachable`, `timeout`, `bad-response`). */
    readonly code: string,
    /** The error body's other fields (a 409's current config and revision). */
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/** Default time to wait for one response, in ms. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Time to wait for one sync round, in ms (a page of a large brain). */
export const SYNC_TIMEOUT_MS = 180_000;

export interface RemoteClientOptions {
  readonly server: string;
  readonly brainId: string;
  /** The bearer token. Kept in a closure; never exposed as a property. */
  readonly token: string;
  readonly clientId: string;
  /** Per-request timeout in ms. Default `DEFAULT_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** For tests. Default the global `fetch`. */
  readonly fetch?: typeof fetch;
}

export interface RequestOptions {
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
  /** Safe to send twice: retried once after a network failure. Default: GET only. */
  readonly idempotent?: boolean;
  readonly timeoutMs?: number;
  /** HTTP statuses (besides 2xx) whose JSON body is a result, not an error (409 for a conflict). */
  readonly resultStatuses?: readonly number[];
  /** Send no token (the health route). */
  readonly anonymous?: boolean;
}

export interface RemoteClient {
  readonly server: string;
  readonly brainId: string;
  readonly clientId: string;
  /** A request to `<server>/api/<path>`; resolves to the JSON body. */
  request<T>(method: string, path: string, options?: RequestOptions): Promise<T>;
  /** A request under `/api/brains/<brain id>`. */
  brain<T>(method: string, path: string, options?: RequestOptions): Promise<T>;
}

/** `memos/a b.md` → `memos/a%20b.md`: each path segment encoded. */
export function encodeNotePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** The most specific reason a fetch failed: an error code (ECONNREFUSED), else the cause's message. */
function causeCode(error: unknown): string {
  let e: unknown = error;
  let message = '';
  for (let i = 0; i < 4 && e; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
    const m = (e as { message?: unknown }).message;
    if (i > 0 && typeof m === 'string' && m !== '') message = m;
    e = (e as { cause?: unknown }).cause;
  }
  return message || 'network error';
}

/** Creates a client. Requests are independent; nothing is cached. */
export function createRemoteClient(options: RemoteClientOptions): RemoteClient {
  const { server, brainId, clientId } = options;
  const token = options.token;
  const doFetch = options.fetch ?? fetch;
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const origin = new URL(server).host;

  const once = async (
    method: string,
    url: string,
    init: { headers: Record<string, string>; body?: string },
    timeoutMs: number,
  ): Promise<Response> => {
    try {
      return await doFetch(url, {
        method,
        headers: init.headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new RemoteError(
          `the server at ${origin} did not answer within ${Math.round(timeoutMs / 1000)} s`,
          0,
          'timeout',
        );
      }
      throw new RemoteError(
        `cannot reach the server at ${origin} (${causeCode(error)})`,
        0,
        'unreachable',
      );
    }
  };

  const request = async <T>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> => {
    const url = new URL(`${server}/api/${path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    // Content-Type on every request, with or without a body: SvelteKit, in
    // front of the API, refuses a cross-site POST, PUT, PATCH or DELETE whose
    // content type is missing or form-like ("Cross-site … form submissions
    // are forbidden"), and a CLI request has no Origin to make it same-site.
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-somememos-client': clientId,
    };
    if (!opts.anonymous) headers.authorization = `Bearer ${token}`;
    let body: string | undefined;
    if (opts.body !== undefined) body = JSON.stringify(opts.body);
    const timeoutMs = opts.timeoutMs ?? defaultTimeout;
    const idempotent = opts.idempotent ?? method === 'GET';
    let response: Response;
    try {
      response = await once(
        method,
        url.href,
        { headers, ...(body !== undefined ? { body } : {}) },
        timeoutMs,
      );
    } catch (error) {
      if (!idempotent || !(error instanceof RemoteError)) throw error;
      response = await once(
        method,
        url.href,
        { headers, ...(body !== undefined ? { body } : {}) },
        timeoutMs,
      );
    }
    const text = await response.text().catch(() => '');
    let parsed: unknown = undefined;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    const ok =
      (response.status >= 200 && response.status < 300) ||
      (opts.resultStatuses ?? []).includes(response.status);
    const errorBody = (parsed as { error?: { code?: unknown; message?: unknown; path?: unknown } })
      ?.error;
    if (ok && parsed !== undefined && !errorBody) return parsed as T;
    throw toError(response.status, errorBody, origin);
  };

  return {
    server,
    brainId,
    clientId,
    request,
    brain: (method, path, opts) =>
      request(
        method,
        `brains/${encodeURIComponent(brainId)}${path === '' ? '' : `/${path}`}`,
        opts,
      ),
  };
}

function toError(
  status: number,
  body: { code?: unknown; message?: unknown; path?: unknown } | undefined,
  origin: string,
): Error {
  const code = typeof body?.code === 'string' ? body.code : '';
  const message = typeof body?.message === 'string' ? body.message : '';
  if (status === 401) {
    return new RemoteError(
      `the server refused the token (check SOMEMEMOS_TOKEN or the token file)`,
      status,
      'unauthorized',
    );
  }
  if (code !== '' && ENGINE_CODES.has(code)) {
    return new engine.EngineError(
      code as engine.EngineErrorCode,
      message || code,
      typeof body?.path === 'string' ? body.path : null,
    );
  }
  if (status === 503) {
    return new RemoteError(
      `the server at ${origin} is unavailable: ${message || 'service unavailable'}`,
      status,
      code || 'unavailable',
    );
  }
  if (code === 'brain-not-found') {
    return new RemoteError(`the server has no brain by that id`, status, code);
  }
  if (code === 'too-many-attempts') {
    return new RemoteError(`the server says: ${message}`, status, code);
  }
  if (code !== '') {
    const { code: _c, message: _m, path: _p, ...details } = body as Record<string, unknown>;
    return new RemoteError(
      `the server refused the request: ${message || code}`,
      status,
      code,
      details,
    );
  }
  if (status === 404) {
    return new RemoteError(
      `${origin} has no somememos API at that address (HTTP 404); check the server URL`,
      status,
      'not-found',
    );
  }
  return new RemoteError(
    `the server at ${origin} answered HTTP ${status} without a somememos response; check the server URL`,
    status,
    'bad-response',
  );
}
