// Errors the HTTP layer turns into responses, and how engine errors map to
// HTTP statuses. A response body is always `{ error: { code, message } }`,
// plus `path` only where the engine gives one (it never does for an
// excluded path).

import { engine as coreEngine } from '@somememos/core';

/** A refused request: its status, a stable code and a message that names no note. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Readonly<Record<string, string>>;
  /** More fields for the error body (e.g. the current config of a refused config change). */
  readonly extra: Readonly<Record<string, unknown>>;
  override name = 'HttpError';
  constructor(
    status: number,
    code: string,
    message: string,
    headers: Readonly<Record<string, string>> = {},
    extra: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
    this.extra = extra;
  }
}

/** The HTTP status for each `EngineError` code. */
export const ENGINE_ERROR_STATUS: Readonly<Record<coreEngine.EngineErrorCode, number>> = {
  'invalid-path': 400,
  'invalid-argument': 400,
  excluded: 403,
  'not-found': 404,
  exists: 409,
  'source-immutable': 409,
  'no-dated-pattern': 422,
};
