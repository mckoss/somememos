// A lock file for a read-modify-write of a small file shared by several CLI
// processes (a working folder's manifest). Two agents running somememos in
// one working folder at once would otherwise lose an update: both read, both
// write, the second write wins.
//
// - The lock is `<file>.lock`, created with O_EXCL (`wx`), holding the
//   owner's pid, host and a random token. The owner removes it when done,
//   and only if it still holds its own token.
// - A waiter retries with a short, growing pause, for up to `waitMs`.
// - Stale-lock recovery: a lock whose owner process is gone (same host) or
//   that is older than `staleMs` (an update takes milliseconds) is removed
//   and the waiter tries again. A lock file that can't be read is judged by
//   its age alone.
//
// Synchronous on purpose: the manifest update it guards is synchronous.

import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';

export interface LockOptions {
  /** Give up after this long, in ms. Default 30 s. */
  readonly waitMs?: number;
  /** A lock older than this is stale, in ms. Default 30 s. */
  readonly staleMs?: number;
}

/** The lock could not be taken in time. Its message names the lock file. */
export class LockTimeoutError extends Error {
  override name = 'LockTimeoutError';
}

interface LockInfo {
  readonly pid: number;
  readonly host: string;
  readonly token: string;
}

const pause = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms: number): void {
  Atomics.wait(pause, 0, 0, ms);
}

function readLock(path: string): LockInfo | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockInfo>;
    if (typeof value.pid !== 'number' || typeof value.token !== 'string') return null;
    return { pid: value.pid, host: String(value.host ?? ''), token: value.token };
  } catch {
    return null;
  }
}

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** True when the lock at `path` is left over from a process that is gone, or too old. */
function isStale(path: string, staleMs: number): boolean {
  let age: number;
  try {
    age = Date.now() - statSync(path).mtimeMs;
  } catch {
    return false; // gone already: just try again
  }
  if (age > staleMs) return true;
  const info = readLock(path);
  return info !== null && info.host === hostname() && processGone(info.pid);
}

/** Runs `fn` holding the lock for `file` (see the top of this file). */
export function withFileLock<T>(file: string, fn: () => T, options: LockOptions = {}): T {
  const lock = `${file}.lock`;
  const waitMs = options.waitMs ?? 30_000;
  const staleMs = options.staleMs ?? 30_000;
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(lock, 'wx');
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), token }));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (isStale(lock, staleMs)) {
      try {
        unlinkSync(lock);
      } catch {
        // Someone else removed it first.
      }
      continue;
    }
    if (Date.now() > deadline) {
      throw new LockTimeoutError(
        `another somememos command has held ${lock} for more than ${Math.round(waitMs / 1000)} s; if none is running, delete that file`,
      );
    }
    sleep(Math.min(50, 1 + attempt * 2) + Math.random() * 5);
  }
  try {
    return fn();
  } finally {
    if (readLock(lock)?.token === token) {
      try {
        unlinkSync(lock);
      } catch {
        // Already gone.
      }
    }
  }
}
