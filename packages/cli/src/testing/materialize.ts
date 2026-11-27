// Write a synthetic brain (`@somememos/core/testing/brain`) to disk: its files, or a git repository
// with one commit per step.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { filesAfter } from '@somememos/core/testing/brain';
import type { Step, SyntheticBrain } from '@somememos/core/testing/brain';

export const TEST_AUTHOR = { name: 'Test Author', email: 'test@example.invalid' };

type Timeline = SyntheticBrain | readonly Step[];

const stepsOf = (timeline: Timeline): readonly Step[] =>
  Array.isArray(timeline) ? timeline : (timeline as SyntheticBrain).steps;

export interface MaterializeOptions {
  /** Write the state after this step (inclusive). Default: the last step. */
  upTo?: number;
}

function writeFile(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function assertEmpty(dir: string): void {
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).length > 0) throw new Error(`not an empty directory: ${dir}`);
}

/** Write the brain's files (final state, or after `upTo`) into `dir`, which must be empty or absent. Returns the paths written, sorted. */
export function materializeBrain(
  dir: string,
  timeline: Timeline,
  options: MaterializeOptions = {},
): string[] {
  assertEmpty(dir);
  const steps = stepsOf(timeline);
  const files = filesAfter(steps, options.upTo ?? steps.length - 1);
  const paths = [...files.keys()].sort();
  for (const path of paths) writeFile(dir, path, files.get(path)!);
  return paths;
}

/**
 * An environment for git that ignores the user's and system's git config, so the
 * repository is the same on every machine: same identity, dates and hashes.
 */
export function gitEnv(time?: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: '/nonexistent',
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: TEST_AUTHOR.name,
    GIT_AUTHOR_EMAIL: TEST_AUTHOR.email,
    GIT_COMMITTER_NAME: TEST_AUTHOR.name,
    GIT_COMMITTER_EMAIL: TEST_AUTHOR.email,
  };
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT; // Windows
  if (time !== undefined) {
    env.GIT_AUTHOR_DATE = `@${time} +0000`;
    env.GIT_COMMITTER_DATE = `@${time} +0000`;
  }
  return env;
}

const GIT_CONFIG = [
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.fileMode=false',
  '-c',
  'commit.gpgSign=false',
  '-c',
  'core.hooksPath=/dev/null',
];

/** Run git in `cwd` with the controlled environment; returns stdout. */
export function git(cwd: string, args: string[], time?: number): string {
  return execFileSync('git', [...GIT_CONFIG, ...args], {
    cwd,
    env: gitEnv(time),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A path for a fast-import command, C-style quoted (it may hold spaces). */
function quotePath(path: string): string {
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Build a git repository in `dir` (empty or absent) with one commit per step,
 * dated at the step's time, with the step's message and a fixed author, and
 * check out the last one. Renames are pure (content unchanged), so `git log
 * -M` reports them. Returns the commit hashes, in step order.
 *
 * The whole history goes through one `git fast-import` stream: a handful of
 * git processes in all, instead of two per step. (Spawning ~120 of them took
 * seconds on a loaded machine, enough to time out the tests that build a
 * history.)
 */
export function materializeGitHistory(dir: string, timeline: Timeline): string[] {
  assertEmpty(dir);
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  const steps = stepsOf(timeline);
  const identity = `${TEST_AUTHOR.name} <${TEST_AUTHOR.email}>`;
  const chunks: Buffer[] = [];
  const line = (text: string) => chunks.push(Buffer.from(`${text}\n`, 'utf8'));
  const data = (text: string) => {
    const bytes = Buffer.from(text, 'utf8');
    line(`data ${bytes.length}`);
    chunks.push(bytes, Buffer.from('\n'));
  };
  steps.forEach((step, i) => {
    line('commit refs/heads/main');
    line(`mark :${i + 1}`);
    line(`author ${identity} ${step.time} +0000`);
    line(`committer ${identity} ${step.time} +0000`);
    data(`${step.message}\n`);
    if (i > 0) line(`from :${i}`);
    for (const change of step.changes) {
      if (change.type === 'write') {
        line(`M 100644 inline ${quotePath(change.path)}`);
        data(change.content);
      } else if (change.type === 'delete') {
        line(`D ${quotePath(change.path)}`);
      } else {
        line(`R ${quotePath(change.from)} ${quotePath(change.to)}`);
      }
    }
    line('');
  });
  execFileSync('git', [...GIT_CONFIG, 'fast-import', '--quiet', '--date-format=raw'], {
    cwd: dir,
    env: gitEnv(),
    input: Buffer.concat(chunks),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (steps.length === 0) return [];
  git(dir, ['reset', '--hard', '--quiet']);
  return git(dir, ['rev-list', '--reverse', 'HEAD']).trim().split('\n');
}
