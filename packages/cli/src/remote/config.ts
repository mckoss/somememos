// The files a remote client keeps (PLAN.md sections 6 and 7), all CLI-owned
// and separate from core's brain config:
//
// - A remote **working folder** has `.somememos/config.json` of the shape
//   `{ "mode": "remote", server, brainId, clientId, tokenFile? }`. Core's
//   config parser rejects the unknown key `mode`, so a folder's kind is told
//   apart by that key before anything parses the file (`sidecarKind`).
// - `.somememos/manifest.json` in a working folder: each fetched note's path
//   and the content hash it had when fetched (its base).
// - `.somememos/remote.json` in a local-mode brain made by `somememos clone`:
//   the server it syncs with. The brain's own config.json stays core's shape.
//
// No file ever holds the token: it comes from SOMEMEMOS_TOKEN, or from a
// token file outside the working folder whose path may be recorded.

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CommandError } from '../brain/output.js';
import { SIDECAR_DIR } from '../store/open.js';

export const CONFIG_FILE = 'config.json';
export const MANIFEST_FILE = 'manifest.json';
export const REMOTE_FILE = 'remote.json';

/** A brain id, as the server allows. */
export const BRAIN_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A client id, as core's config and the server allow. */
export const CLIENT_ID = /^[A-Za-z0-9._:-]{1,100}$/;

/** The environment variables of remote mode. */
export const ENV = {
  server: 'SOMEMEMOS_SERVER',
  brainId: 'SOMEMEMOS_BRAIN_ID',
  token: 'SOMEMEMOS_TOKEN',
  tokenFile: 'SOMEMEMOS_TOKEN_FILE',
  clientId: 'SOMEMEMOS_CLIENT_ID',
  workdir: 'SOMEMEMOS_WORKDIR',
  allowInsecure: 'SOMEMEMOS_ALLOW_INSECURE',
} as const;

type Env = Readonly<Record<string, string | undefined>>;

/** Hosts a plain `http://` server may be on: this machine only. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether plain http to another host was explicitly allowed: the flag, or SOMEMEMOS_ALLOW_INSECURE=1. */
export function insecureAllowed(env: Env, flag?: boolean): boolean {
  return flag === true || env[ENV.allowInsecure] === '1';
}

/**
 * Refuses to send a token over plain `http://` (security review 2026-11-27,
 * finding 10), except to this machine or when explicitly allowed.
 */
export function checkServerTransport(server: string, allowInsecure: boolean): void {
  const url = new URL(server);
  if (url.protocol === 'https:' || allowInsecure || LOOPBACK_HOSTS.has(url.hostname)) return;
  throw new CommandError(
    `refusing to send the token to ${url.host} over plain http://, where anyone on the network can read it; use https://, or on a network you trust pass --allow-insecure (or set ${ENV.allowInsecure}=1)`,
  );
}

/** Where a remote client talks to. */
export interface RemoteTarget {
  /** The server's base URL, normalized: no trailing slash. */
  readonly server: string;
  readonly brainId: string;
  readonly clientId: string;
  /** An absolute path to a file holding the token, or null (then SOMEMEMOS_TOKEN). */
  readonly tokenFile: string | null;
}

/** A working folder's config file. */
export interface WorkFolderConfig extends RemoteTarget {
  readonly mode: 'remote';
}

/** A clone's `remote.json`. */
export interface CloneRemote {
  readonly server: string;
  readonly brainId: string;
  readonly tokenFile: string | null;
}

/** What `.somememos/config.json` in `dir` is: a local brain, a remote working folder, or absent. */
export type SidecarKind =
  | { readonly kind: 'local' }
  | { readonly kind: 'remote'; readonly config: WorkFolderConfig }
  | { readonly kind: 'none' };

/** The server URL as given, checked and normalized (http or https, no query, no trailing slash). */
export function normalizeServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CommandError(
      `${JSON.stringify(value)} is not a server URL; give one like https://somememos.example.com`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CommandError('the server URL must start with https:// (or http:// for a local test)');
  }
  if (url.username || url.password) {
    throw new CommandError(
      'put no credentials in the server URL; the token comes from SOMEMEMOS_TOKEN',
    );
  }
  if (url.search || url.hash) throw new CommandError('the server URL must have no query or #');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function checkBrainId(value: string): string {
  if (!BRAIN_ID.test(value)) {
    throw new CommandError(
      `${JSON.stringify(value)} is not a brain id: 1 to 63 lower-case letters, digits and dashes, starting with a letter or digit`,
    );
  }
  return value;
}

function readJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CommandError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

/** Writes JSON atomically (a temporary file renamed into place). */
export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses a working folder's config; throws a CommandError naming the file. */
export function parseWorkFolderConfig(value: unknown, path: string): WorkFolderConfig {
  const problems: string[] = [];
  if (!isObject(value)) throw new CommandError(`${path} must be a JSON object`);
  for (const key of Object.keys(value)) {
    if (!['mode', 'server', 'brainId', 'clientId', 'tokenFile'].includes(key)) {
      problems.push(`unknown key "${key}"`);
    }
  }
  if (value.mode !== 'remote') problems.push('mode must be "remote"');
  let server = '';
  if (typeof value.server !== 'string') problems.push('server: required, the server URL');
  else {
    try {
      server = normalizeServerUrl(value.server);
    } catch (error) {
      problems.push(`server: ${(error as Error).message}`);
    }
  }
  if (typeof value.brainId !== 'string' || !BRAIN_ID.test(value.brainId)) {
    problems.push('brainId: required, a brain id');
  }
  if (typeof value.clientId !== 'string' || !CLIENT_ID.test(value.clientId)) {
    problems.push('clientId: required, a client id');
  }
  const tokenFile = value.tokenFile;
  if (tokenFile !== undefined && tokenFile !== null) {
    if (typeof tokenFile !== 'string' || !isAbsolute(tokenFile)) {
      problems.push('tokenFile: an absolute path');
    }
  }
  if (problems.length > 0) throw new CommandError(`${path}: ${problems.join('; ')}`);
  return {
    mode: 'remote',
    server,
    brainId: value.brainId as string,
    clientId: value.clientId as string,
    tokenFile: typeof tokenFile === 'string' ? tokenFile : null,
  };
}

/** Which kind of sidecar config `dir` has, without letting core parse a remote one. */
export function sidecarKind(dir: string): SidecarKind {
  const path = join(dir, SIDECAR_DIR, CONFIG_FILE);
  let value: unknown;
  try {
    value = readJsonFile(path);
  } catch {
    return { kind: 'local' }; // let core's loader report the bad JSON
  }
  if (value === undefined) return { kind: 'none' };
  if (isObject(value) && 'mode' in value && value.mode === 'remote') {
    return { kind: 'remote', config: parseWorkFolderConfig(value, path) };
  }
  return { kind: 'local' };
}

export function writeWorkFolderConfig(dir: string, config: WorkFolderConfig): string {
  const path = join(dir, SIDECAR_DIR, CONFIG_FILE);
  writeJsonFile(path, {
    mode: 'remote',
    server: config.server,
    brainId: config.brainId,
    clientId: config.clientId,
    ...(config.tokenFile ? { tokenFile: config.tokenFile } : {}),
  });
  return path;
}

// ---------------------------------------------------------------------------
// Clones

export function readCloneRemote(brainRoot: string): CloneRemote | null {
  const path = join(brainRoot, SIDECAR_DIR, REMOTE_FILE);
  const value = readJsonFile(path);
  if (value === undefined) return null;
  if (
    !isObject(value) ||
    typeof value.server !== 'string' ||
    typeof value.brainId !== 'string' ||
    !BRAIN_ID.test(value.brainId) ||
    (value.tokenFile !== undefined &&
      value.tokenFile !== null &&
      (typeof value.tokenFile !== 'string' || !isAbsolute(value.tokenFile)))
  ) {
    throw new CommandError(
      `${path} must be {"server": "<url>", "brainId": "<id>", "tokenFile"?: "<absolute path>"}`,
    );
  }
  return {
    server: normalizeServerUrl(value.server),
    brainId: value.brainId,
    tokenFile: typeof value.tokenFile === 'string' ? value.tokenFile : null,
  };
}

export function writeCloneRemote(brainRoot: string, remote: CloneRemote): string {
  const path = join(brainRoot, SIDECAR_DIR, REMOTE_FILE);
  writeJsonFile(path, {
    server: remote.server,
    brainId: remote.brainId,
    ...(remote.tokenFile ? { tokenFile: remote.tokenFile } : {}),
  });
  return path;
}

// ---------------------------------------------------------------------------
// Environment-only mode

/** True when the three variables of environment-only remote mode are all set. */
export function envRemoteConfigured(env: Env): boolean {
  return Boolean(env[ENV.server] && env[ENV.brainId] && env[ENV.token]);
}

/**
 * A stable client id when none is configured: `SOMEMEMOS_CLIENT_ID`, else
 * one derived from this machine, user and working folder (stable for as long
 * as they are).
 */
export function derivedClientId(env: Env, workFolder: string): string {
  const given = env[ENV.clientId];
  if (given) {
    if (!CLIENT_ID.test(given)) {
      throw new CommandError(`${ENV.clientId} must be 1-100 letters, digits, '.', '_', ':' or '-'`);
    }
    return given;
  }
  let user: string;
  try {
    user = userInfo().username;
  } catch {
    user = ''; // no user database entry (some containers)
  }
  const digest = createHash('sha256')
    .update(`${hostname()}\0${user}\0${resolve(workFolder)}`)
    .digest('hex');
  return `cli-${digest.slice(0, 16)}`;
}

/** The working folder of environment-only mode: SOMEMEMOS_WORKDIR, else ~/somememos/<brain id>. */
export function envWorkFolder(env: Env, cwd: string, brainId: string): string {
  const given = env[ENV.workdir];
  if (given) return resolve(cwd, given);
  return join(env.HOME || homedir(), 'somememos', brainId);
}

/** The target of environment-only mode. */
export function envTarget(env: Env, workFolder: string): RemoteTarget {
  return {
    server: normalizeServerUrl(env[ENV.server] as string),
    brainId: checkBrainId(env[ENV.brainId] as string),
    clientId: derivedClientId(env, workFolder),
    tokenFile: null,
  };
}

// ---------------------------------------------------------------------------
// The token

/** True when `path` is `dir` or inside it. */
export function isInside(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The bearer token: SOMEMEMOS_TOKEN, else the token file (recorded, or
 * SOMEMEMOS_TOKEN_FILE). Never printed: errors name the variable or the file,
 * never the value.
 */
export function resolveToken(env: Env, tokenFile: string | null, cwd: string): string {
  const fromEnv = env[ENV.token]?.trim();
  if (fromEnv) return fromEnv;
  const file =
    tokenFile ?? (env[ENV.tokenFile] ? resolve(cwd, env[ENV.tokenFile] as string) : null);
  if (file) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      throw new CommandError(
        `cannot read the token file ${file}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`,
      );
    }
    const token = text.trim();
    if (token === '' || /\s/.test(token)) {
      throw new CommandError(`the token file ${file} must hold one token on one line`);
    }
    return token;
  }
  throw new CommandError(
    `no token: set ${ENV.token} (or pass --token-file <path> to connect or clone)`,
  );
}

/** A `--token-file` value, checked: it must exist and lie outside `folder`. */
export function checkTokenFile(cwd: string, value: string, folder: string): string {
  const file = resolve(cwd, value);
  if (isInside(folder, file)) {
    throw new CommandError(
      `the token file must be outside ${folder}, so it is never committed or synced with the notes`,
    );
  }
  return file;
}
