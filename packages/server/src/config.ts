// Server configuration from environment variables, validated once at
// startup. A server without `DATABASE_URL` still serves the offline web app;
// its API then answers 503 (the web app works without a server).
//
//   DATABASE_URL         postgres://… — the server's database. Unset: no API.
//   SOMEMEMOS_DATA_DIR   where brains' git repositories live (`<dir>/brains/<id>/`).
//                        Required with DATABASE_URL. Put it on a persistent volume.
//   SOMEMEMOS_TOKEN      the bearer token(s), comma-separated. Each is a raw token of
//                        at least 24 characters, or `sha256:<64 hex>`, the SHA-256 of
//                        one, so the raw token need not sit in the environment.
//                        Required with DATABASE_URL.
//   PORT                 the HTTP port (read by adapter-node itself; checked here).
//   SOMEMEMOS_MAX_PAGE   optional: mutations per sync response page (default 2000).

import { isAbsolute, resolve } from 'node:path';
import { type TokenSet, parseTokens } from './auth.js';

export interface ServerConfig {
  /** Null when `DATABASE_URL` is unset: the API is off. */
  readonly databaseUrl: string | null;
  /** Absolute. Null without a database. */
  readonly dataDir: string | null;
  readonly tokens: TokenSet;
  readonly port: number | null;
  /** Mutations per sync response page. */
  readonly pageSize: number;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: ServerConfig }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Reads and validates the server's configuration. Never echoes a secret. */
export function loadServerConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConfigResult {
  const problems: string[] = [];
  const raw = (name: string): string | null => {
    const v = env[name];
    return v === undefined || v.trim() === '' ? null : v.trim();
  };

  const databaseUrl = raw('DATABASE_URL');
  if (databaseUrl !== null) {
    let url: URL | null = null;
    try {
      url = new URL(databaseUrl);
    } catch {
      problems.push(
        'DATABASE_URL is not a URL (expected postgres://user:password@host:port/database)',
      );
    }
    if (url && url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
      problems.push('DATABASE_URL must start with postgres:// or postgresql://');
    }
  }

  let dataDir: string | null = null;
  const dir = raw('SOMEMEMOS_DATA_DIR');
  if (dir !== null) {
    dataDir = isAbsolute(dir) ? dir : resolve(dir);
  } else if (databaseUrl !== null) {
    problems.push(
      "SOMEMEMOS_DATA_DIR is not set: set it to a directory on a persistent volume, where the brains' git repositories are kept",
    );
  }

  const tokenText = raw('SOMEMEMOS_TOKEN');
  const parsed = parseTokens(tokenText ?? '');
  problems.push(...parsed.problems.map((p) => `SOMEMEMOS_TOKEN: ${p}`));
  if (databaseUrl !== null && tokenText === null) {
    problems.push(
      'SOMEMEMOS_TOKEN is not set: every API request needs a bearer token (a random string of 24 or more characters, or sha256:<hex of one>)',
    );
  }

  let port: number | null = null;
  const portText = raw('PORT');
  if (portText !== null) {
    port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      problems.push('PORT must be an integer from 1 to 65535');
      port = null;
    }
  }

  let pageSize = 2000;
  const pageText = raw('SOMEMEMOS_MAX_PAGE');
  if (pageText !== null) {
    pageSize = Number(pageText);
    if (!Number.isInteger(pageSize) || pageSize < 10 || pageSize > 100_000) {
      problems.push('SOMEMEMOS_MAX_PAGE must be an integer from 10 to 100000');
      pageSize = 2000;
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: {
      databaseUrl,
      dataDir: databaseUrl === null ? null : dataDir,
      tokens: parsed.tokens,
      port,
      pageSize,
    },
  };
}
