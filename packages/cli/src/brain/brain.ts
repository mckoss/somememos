// The brain context every command runs in: find the brain, load its config,
// open its stores, create the engine over them and the files, run the
// automatic index pass, remind about uncommitted changes, and always close
// the stores.

import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { engine as engineApi, indexing, markdown, storage } from '@somememos/core';
import { type Context, clockOf } from '../context.js';
import { createFsContentStore } from '../indexer/index.js';
import { type BrainStores, SIDECAR_DIR, loadBrainConfig, openBrainStores } from '../store/index.js';
import type { GlobalOptions } from './args.js';
import { CommandError, plural, warn } from './output.js';

type IndexSummary = indexing.IndexSummary;

/** No brain was found. Exit code 1; the message names `somememos init`. */
export class BrainNotFoundError extends CommandError {
  override name = 'BrainNotFoundError';
}

/** How long a command waits for another process's write lock on a database, in ms. */
export const BRAIN_BUSY_TIMEOUT_MS = 30_000;

/** True when `dir` holds `.somememos/config.json`. */
export function isBrainRoot(dir: string): boolean {
  return existsSync(join(dir, SIDECAR_DIR, 'config.json'));
}

/**
 * The brain's root directory. In order: `explicit` (`--brain`, relative to
 * the working directory), `$SOMEMEMOS_BRAIN`, else the nearest folder at or
 * above `ctx.cwd` holding `.somememos/config.json`. An explicit or environment
 * directory must itself be a brain root. Throws `BrainNotFoundError`.
 */
export function findBrainRoot(ctx: Context, explicit?: string): string {
  const given = explicit ?? ctx.env.SOMEMEMOS_BRAIN;
  if (given !== undefined && given !== '') {
    const dir = resolve(ctx.cwd, given);
    if (!isBrainRoot(dir)) {
      const how = explicit !== undefined ? '--brain' : 'SOMEMEMOS_BRAIN';
      throw new BrainNotFoundError(
        `${how} names ${dir}, which is not a brain (no ${SIDECAR_DIR}/config.json); run 'somememos init ${given}' to create one`,
      );
    }
    return dir;
  }
  let dir = resolve(ctx.cwd);
  for (;;) {
    if (isBrainRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new BrainNotFoundError(
    `no brain found in ${resolve(ctx.cwd)} or any folder above it; run 'somememos init' to create one, or pass --brain <dir>`,
  );
}

/** Everything a command needs about the brain it runs in. */
export interface Brain {
  /** Absolute path of the brain's root directory. */
  readonly root: string;
  readonly config: storage.BrainConfig;
  /** `markdown.createRoleClassifier(config.roles)`. */
  readonly classifier: markdown.RoleClassifier;
  /** The open stores; `withBrain` closes them. */
  readonly stores: BrainStores;
  /** The brain's files, as core's content store. */
  readonly content: storage.ContentStore;
  /** Core's engine over `stores` and `content`: what commands call. */
  readonly engine: engineApi.Engine;
  /** The clock (whole Unix seconds); the same one the stores use. */
  readonly now: () => number;
  /** The command's context. */
  readonly ctx: Context;
  /** The result of this command's index pass, or null if none ran (`--no-index` or opted out). */
  readonly index: IndexSummary | null;
  /**
   * Runs an index pass now (printing its warnings to stderr) and records it
   * in `index`. `withBrain` calls it before the command unless skipped.
   */
  reindex(options?: { readonly rebuild?: boolean }): Promise<IndexSummary>;
  /**
   * A user-supplied path (absolute, or relative to the working directory) as
   * a brain-relative path with `/` separators, or null when it is outside the
   * brain.
   */
  brainPath(userPath: string): string | null;
  /** A brain-relative path for display: relative to the working directory when it is inside the brain. */
  displayPath(path: string): string;
}

export interface WithBrainOptions {
  /** `--brain`. */
  readonly brain?: string;
  /** `--no-index`: skip the automatic index pass. */
  readonly noIndex?: boolean;
  /** False for commands that must not index first (they may call `brain.reindex` themselves). Default true. */
  readonly autoIndex?: boolean;
  /**
   * After the command, print a one-line reminder on stderr when changed
   * notes are not committed. Default true; `commit`, `status` and `init` turn
   * it off. Never printed with `json`.
   */
  readonly remind?: boolean;
  /** `--json`: no reminder. */
  readonly json?: boolean;
}

/** `WithBrainOptions` from parsed global options. */
export function brainOptions(globals: GlobalOptions, extra: Partial<WithBrainOptions> = {}) {
  return {
    ...(globals.brain === undefined ? {} : { brain: globals.brain }),
    noIndex: globals.noIndex,
    json: globals.json,
    ...extra,
  } satisfies WithBrainOptions;
}

/**
 * Opens the brain, runs the automatic index pass (an incremental index plus
 * fold, fast when nothing changed) unless `noIndex` is set or `autoIndex` is
 * false, calls `fn`, and always closes the stores.
 *
 * ```ts
 * return withBrain(ctx, brainOptions(globals), async (brain) => {
 *   const notes = await brain.stores.notes.listNotes({ role: 'memo' });
 *   emit(ctx, globals.json, { count: notes.length }, (r) => `${r.count} memos`);
 *   return EXIT_OK;
 * });
 * ```
 */
export async function withBrain<T>(
  ctx: Context,
  options: WithBrainOptions,
  fn: (brain: Brain) => T | Promise<T>,
): Promise<T> {
  const root = findBrainRoot(ctx, options.brain);
  const config = loadBrainConfig(root);
  const classifier = markdown.createRoleClassifier(config.roles);
  const now = clockOf(ctx);
  const stores = openBrainStores(root, {
    analyzer: config.analyzer,
    now,
    busyTimeoutMs: BRAIN_BUSY_TIMEOUT_MS,
  });
  const cwd = resolve(ctx.cwd);
  const cwdInside = cwd === root || cwd.startsWith(root + sep);
  const content = createFsContentStore(root);
  const engine = engineApi.createEngine({ stores, content, config, now });

  let index: IndexSummary | null = null;
  const brain: Brain = {
    root,
    config,
    classifier,
    stores,
    content,
    engine,
    now,
    ctx,
    get index() {
      return index;
    },
    async reindex(opts = {}) {
      const summary = await engine.index(opts.rebuild ? { rebuild: true } : {});
      for (const w of summary.warnings) warn(ctx, w);
      index = summary;
      return summary;
    },
    brainPath(userPath) {
      const abs = isAbsolute(userPath) ? userPath : resolve(cwd, userPath);
      const rel = relative(root, abs);
      if (rel === '') return '';
      if (rel.startsWith('..') || isAbsolute(rel)) return null;
      return rel.split(sep).join('/');
    },
    displayPath(path) {
      if (!cwdInside) return join(root, path);
      const rel = relative(cwd, join(root, path));
      return rel.split(sep).join('/');
    },
  };

  try {
    if (options.autoIndex !== false && !options.noIndex) await brain.reindex();
    const result = await fn(brain);
    if (options.remind !== false && !options.json) await remindUncommitted(ctx, stores);
    return result;
  } finally {
    await stores.close();
  }
}

/** The forgotten-commit reminder (PLAN.md section 6): one line on stderr, or nothing. */
export async function remindUncommitted(ctx: Context, stores: storage.Stores): Promise<void> {
  const n = (await indexing.readUncommitted(stores.meta)).length;
  if (n === 0) return;
  ctx.stderr(
    `somememos: ${plural(n, 'changed note')} not committed; run somememos commit -m "<why>"\n`,
  );
}

/** True when `dir` exists and is a directory. */
export function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
