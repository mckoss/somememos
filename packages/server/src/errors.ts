// Errors the HTTP layer turns into responses, and how engine errors map to
// HTTP statuses. A response body is always `{ error: { code, message } }`,
// plus `path` only where the engine gives one (it never does for an
// excluded path).

import { engine as coreEngine } from '@somememos/core';

/** A refused request: its status, a stable code and a message that names no note. */
export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
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
