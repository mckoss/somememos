// Test helpers for commands: a fake context that captures output, and a
// throwaway brain directory. Test-only; nothing here touches a real brain.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { storage } from '@somememos/core';
import type { markdown } from '@somememos/core';
import type { Context } from '../context.js';
import { CONFIG_FILE, SIDECAR_DIR } from '../store/index.js';

export interface FakeContext {
  readonly ctx: Context;
  stdout(): string;
  stderr(): string;
  /** Forget captured output. */
  clear(): void;
}

/** A context that captures stdout and stderr. `now` is fixed unless given a function. */
export function fakeContext(
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    now?: number | (() => number);
  } = {},
): FakeContext {
  const out: string[] = [];
  const err: string[] = [];
  const now = options.now;
  const ctx: Context = {
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
    cwd: options.cwd ?? '/nonexistent',
    env: options.env ?? {},
    ...(now === undefined ? {} : { now: typeof now === 'number' ? () => now : now }),
  };
  return {
    ctx,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    clear: () => {
      out.length = 0;
      err.length = 0;
    },
  };
}

/** A temporary directory; call `remove` when done. */
export function tempDir(prefix = 'somememos-test-'): { dir: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Writes `.somememos/config.json` with the given roles (default: none) and client id. */
export function writeTestConfig(
  dir: string,
  config: { roles?: markdown.FolderRolesConfig; clientId?: string } & Record<string, unknown> = {},
): storage.BrainConfig {
  const parsed = storage.parseBrainConfig({ clientId: 'test-client', ...config });
  mkdirSync(join(dir, SIDECAR_DIR), { recursive: true });
  writeFileSync(join(dir, SIDECAR_DIR, CONFIG_FILE), storage.serializeBrainConfig(parsed));
  return parsed;
}

/** Writes a file under `dir`, creating folders, optionally with an mtime (Unix seconds). */
export function writeNote(dir: string, path: string, content: string, mtime?: number): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  if (mtime !== undefined) utimesSync(full, mtime, mtime);
}
