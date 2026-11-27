// The context the query commands run in, in either mode (PLAN.md section 6,
// "Two modes, one flow"):
//
// - local: the brain's directory is here (`withBrain`);
// - remote: the brain is on a server, reached with core's engine over HTTP
//   (`remote/engine.ts`), and the working folder holds the notes this agent
//   has read.
//
// Where the brain is: `--brain <dir>` or SOMEMEMOS_BRAIN, else the nearest
// folder at or above the working directory holding `.somememos/config.json`;
// that file says which mode (a remote working folder's has `"mode":
// "remote"`). With no such folder, SOMEMEMOS_SERVER, SOMEMEMOS_BRAIN_ID and
// SOMEMEMOS_TOKEN select remote mode with no files at all; its working
// folder is SOMEMEMOS_WORKDIR, else ~/somememos/<brain id>.

import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type engine as engineApi, markdown } from '@somememos/core';
import { type Context } from '../context.js';
import { createRemoteClient, type RemoteClient } from '../remote/client.js';
import {
  ENV,
  type RemoteTarget,
  envRemoteConfigured,
  envTarget,
  envWorkFolder,
  resolveToken,
  sidecarKind,
} from '../remote/config.js';
import { type RemoteEngine, createRemoteEngine } from '../remote/engine.js';
import {
  type FileState,
  type WorkFolder,
  openWorkFolder,
  pendingFiles,
} from '../remote/workfolder.js';
import { SIDECAR_DIR } from '../store/open.js';
import { type Brain, BrainNotFoundError, type WithBrainOptions, withBrain } from './brain.js';
import { plural } from './output.js';

/** What a command needs from the brain, in either mode. */
export interface Session {
  readonly mode: 'local' | 'remote';
  /** The brain's root (local) or the working folder (remote). */
  readonly root: string;
  readonly engine: engineApi.Engine;
  readonly ctx: Context;
  /** A user path as a brain-relative path, or null when outside `root`. */
  brainPath(userPath: string): string | null;
  /** A brain-relative path for display: relative to the working directory when inside `root`. */
  displayPath(path: string): string;
  /** Local mode only. */
  readonly local: Brain | null;
  /** Remote mode only. */
  readonly remote: RemoteSession | null;
}

export interface RemoteSession {
  readonly target: RemoteTarget;
  readonly client: RemoteClient;
  readonly engine: RemoteEngine;
  readonly folder: WorkFolder;
  /** True when the folder has a config file (`connect`); false in environment-only mode. */
  readonly connected: boolean;
  /** Edited and new working-folder files that a commit would send (excluded paths left out). */
  uncommitted(): Promise<FileState[]>;
}

export type BrainLocation =
  | { readonly mode: 'local'; readonly root: string }
  | {
      readonly mode: 'remote';
      readonly root: string;
      readonly target: RemoteTarget;
      readonly connected: boolean;
    };

/**
 * Where the brain is and which mode it is in (see the top of this file).
 * Throws `BrainNotFoundError`.
 */
export function locateBrain(ctx: Context, explicit?: string): BrainLocation {
  const given = explicit ?? ctx.env.SOMEMEMOS_BRAIN;
  const at = (dir: string): BrainLocation | null => {
    const kind = sidecarKind(dir);
    if (kind.kind === 'none') return null;
    if (kind.kind === 'local') return { mode: 'local', root: dir };
    return { mode: 'remote', root: dir, target: kind.config, connected: true };
  };
  if (given !== undefined && given !== '') {
    const dir = resolve(ctx.cwd, given);
    const found = at(dir);
    if (!found) {
      const how = explicit !== undefined ? '--brain' : 'SOMEMEMOS_BRAIN';
      throw new BrainNotFoundError(
        `${how} names ${dir}, which is not a brain (no ${SIDECAR_DIR}/config.json); run 'somememos init ${given}' to create one`,
      );
    }
    return found;
  }
  let dir = resolve(ctx.cwd);
  for (;;) {
    const found = at(dir);
    if (found) return found;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (envRemoteConfigured(ctx.env)) {
    const brainId = ctx.env[ENV.brainId] as string;
    const root = envWorkFolder(ctx.env, ctx.cwd, brainId);
    return { mode: 'remote', root, target: envTarget(ctx.env, root), connected: false };
  }
  throw new BrainNotFoundError(
    `no brain found in ${resolve(ctx.cwd)} or any folder above it; run 'somememos init' to create one, pass --brain <dir>, or for a brain on a server set ${ENV.server}, ${ENV.brainId} and ${ENV.token} (see 'somememos help setup')`,
  );
}

function pathHelpers(root: string, cwd: string) {
  const cwdInside = cwd === root || cwd.startsWith(root + sep);
  return {
    brainPath(userPath: string): string | null {
      const abs = isAbsolute(userPath) ? userPath : resolve(cwd, userPath);
      const rel = relative(root, abs);
      if (rel === '') return '';
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
      return rel.split(sep).join('/');
    },
    displayPath(path: string): string {
      if (!cwdInside) return join(root, path);
      return relative(cwd, join(root, path)).split(sep).join('/');
    },
  };
}

/** Opens a remote session for a location (no request is made yet). */
export function openRemote(
  ctx: Context,
  location: Extract<BrainLocation, { mode: 'remote' }>,
): RemoteSession {
  const token = resolveToken(ctx.env, location.target.tokenFile, ctx.cwd);
  const timeout = Number(ctx.env.SOMEMEMOS_TIMEOUT_MS);
  const client = createRemoteClient({
    server: location.target.server,
    brainId: location.target.brainId,
    clientId: location.target.clientId,
    token,
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
  });
  const engine = createRemoteEngine(client);
  const folder = openWorkFolder(location.root, location.target);
  return {
    target: location.target,
    client,
    engine,
    folder,
    connected: location.connected,
    async uncommitted() {
      const pending = pendingFiles(await folder.scan());
      if (!pending.some((s) => s.kind === 'new')) return pending;
      // New files in excluded folders are never sent, so they are not pending.
      const classifier = markdown.createRoleClassifier((await engine.brainConfig()).roles);
      return pending.filter(
        (s) => s.kind !== 'new' || classifier.classify(s.path)?.role !== 'excluded',
      );
    },
  };
}

/**
 * Runs `fn` in the brain's mode: local through `withBrain` (index pass,
 * reminder), remote over HTTP, with the same reminder about uncommitted
 * working-folder files on stderr afterwards (not with `--json`, not when
 * `remind` is false).
 */
export async function withSession<T>(
  ctx: Context,
  options: WithBrainOptions,
  fn: (session: Session) => T | Promise<T>,
): Promise<T> {
  const location = locateBrain(ctx, options.brain);
  if (location.mode === 'local') {
    return withBrain(ctx, { ...options, brain: location.root }, (brain) =>
      fn({
        mode: 'local',
        root: brain.root,
        engine: brain.engine,
        ctx,
        brainPath: brain.brainPath,
        displayPath: brain.displayPath,
        local: brain,
        remote: null,
      }),
    );
  }
  const remote = openRemote(ctx, location);
  const session: Session = {
    mode: 'remote',
    root: location.root,
    engine: remote.engine,
    ctx,
    ...pathHelpers(location.root, resolve(ctx.cwd)),
    local: null,
    remote,
  };
  const result = await fn(session);
  if (options.remind !== false && !options.json) await remindRemote(ctx, remote);
  return result;
}

/** The forgotten-commit reminder for a working folder: one line on stderr, or nothing. */
export async function remindRemote(ctx: Context, remote: RemoteSession): Promise<void> {
  let n: number;
  try {
    n = (await remote.uncommitted()).length;
  } catch {
    return; // a reminder never fails a command
  }
  if (n === 0) return;
  ctx.stderr(
    `somememos: ${plural(n, 'changed note')} not committed; run somememos commit -m "<why>"\n`,
  );
}
