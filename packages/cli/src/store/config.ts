// Reading and writing `<brain>/.somememos/config.json` (IMPLEMENTATION.md
// task 1.1). The types, defaults and validation live in core
// (`storage.parseBrainConfig`); this module only touches the file.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { storage } from '@somememos/core';
import { brainPaths } from './open.js';

export const CONFIG_FILE = 'config.json';

/** The brain has no `.somememos/config.json` (it was never initialized). */
export class ConfigNotFoundError extends Error {
  override name = 'ConfigNotFoundError';
  readonly path: string;
  constructor(path: string) {
    super(`No somememos config at ${path}. Run 'somememos init' in the brain's directory first.`);
    this.path = path;
  }
}

/** The path of a brain's config file. */
export function configPath(brainDir: string): string {
  return join(brainPaths(brainDir).sidecarDir, CONFIG_FILE);
}

/**
 * Reads and validates a brain's config, filling in defaults. Throws
 * `ConfigNotFoundError` when the file is missing, and `storage.ConfigError`
 * (listing every problem, including unknown keys) when it is invalid.
 */
export function loadBrainConfig(brainDir: string): storage.BrainConfig {
  const path = configPath(brainDir);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ConfigNotFoundError(path);
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new storage.ConfigError([`not valid JSON: ${(error as Error).message}`], path);
  }
  return storage.parseBrainConfig(parsed, path);
}

export interface WriteDefaultConfigOptions {
  /** The client id to record. Default: a new random UUID. */
  readonly clientId?: string;
  /** Replace an existing config. Default false: an existing file is an error. */
  readonly overwrite?: boolean;
}

/**
 * Writes the default config for `somememos init` (the `memos/`, `diary/`,
 * `sources/` layout and a new client id), creating `.somememos/` if needed.
 * Refuses to replace an existing file unless `overwrite` is set. Returns the
 * config written.
 */
export function writeDefaultConfig(
  brainDir: string,
  options: WriteDefaultConfigOptions = {},
): storage.BrainConfig {
  const config = storage.defaultBrainConfig(options.clientId ?? randomUUID());
  mkdirSync(brainPaths(brainDir).sidecarDir, { recursive: true });
  writeFileSync(configPath(brainDir), storage.serializeBrainConfig(config), {
    encoding: 'utf8',
    flag: options.overwrite ? 'w' : 'wx',
  });
  return config;
}
