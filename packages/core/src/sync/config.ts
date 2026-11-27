// A brain's shared config (PLAN.md section 4, "Folder roles"): everything in
// `BrainConfig` but the per-device client id. The server stores it with a
// revision number; every copy keeps it in step through
// `GET`/`PUT /api/brains/{brain}/config` and the `configRevision` field of a
// sync request (./protocol.ts). Isomorphic, plain JSON.

import {
  ConfigError,
  parseBrainConfig,
  serializeBrainConfig,
  type BrainConfig,
} from '../storage/config.js';

/** A brain's config without its client id: the part every copy shares. */
export type SharedConfig = Omit<BrainConfig, 'clientId'>;

/** The brain's shared config as the server has it. */
export interface ConfigView {
  /** Starts at 1 and goes up by one on every change. */
  readonly revision: number;
  readonly config: SharedConfig;
}

/** `PUT /api/brains/{brain}/config`: replace the shared config, if it is still at `baseRevision`. */
export interface ConfigPutRequest {
  readonly baseRevision: number;
  readonly config: SharedConfig;
}

/**
 * The answer to a put. `saved`: the config is now the given one, at a new
 * revision. `unchanged`: the server already had exactly this config (at any
 * revision). `conflict`: the server's config changed since `baseRevision`;
 * nothing was stored and `config` is the server's (HTTP 409).
 */
export interface ConfigPutResult extends ConfigView {
  readonly status: 'saved' | 'unchanged' | 'conflict';
}

/** The shared part of a config, as plain JSON (every default filled in). */
export function sharedConfigOf(config: BrainConfig | SharedConfig): SharedConfig {
  const full = { clientId: 'x', ...config } as BrainConfig;
  const { clientId: _clientId, ...rest } = JSON.parse(serializeBrainConfig(full)) as BrainConfig;
  return rest;
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** A canonical text of the shared part of a config: equal exactly when two configs agree. */
export function sharedConfigKey(config: BrainConfig | SharedConfig): string {
  return JSON.stringify(sortDeep(sharedConfigOf(config)));
}

/**
 * A full config from a shared one and this copy's client id; throws
 * `ConfigError` when the shared config is invalid or carries a client id.
 */
export function configWithClient(
  shared: unknown,
  clientId: string,
  source = 'config',
): BrainConfig {
  if (shared === null || typeof shared !== 'object' || Array.isArray(shared)) {
    throw new ConfigError(['the shared config must be a JSON object'], source);
  }
  if ('clientId' in shared) {
    throw new ConfigError(['the shared config must not carry a clientId'], source);
  }
  return parseBrainConfig({ ...(shared as object), clientId }, source);
}

/**
 * A sync round was refused because the server's shared config is at another
 * revision than the request said (HTTP 409 `config-changed`). Nothing was
 * applied; take `view` (or resolve a conflict) and sync again.
 */
export class ConfigChangedError extends Error {
  override name = 'ConfigChangedError';
  constructor(readonly view: ConfigView) {
    super(`the brain's shared config changed on the server (now revision ${view.revision})`);
  }
}

/**
 * This copy changed the shared config, and so did another copy since: the
 * two are never merged or overwritten silently. Choose one with
 * `resolveConfigConflict` ('mine' replaces the server's, 'theirs' takes it).
 */
export class ConfigConflictError extends Error {
  override name = 'ConfigConflictError';
  constructor(
    /** This copy's shared config. */
    readonly local: SharedConfig,
    /** The server's. */
    readonly server: ConfigView,
  ) {
    super(
      `the brain's shared config was changed both here and on another device (the server is at revision ${server.revision}); choose which to keep`,
    );
  }
}
