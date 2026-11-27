// A brain's git repository on the server (PLAN.md section 7, "Version
// history: a git repository per brain"). Git is the server's version store,
// never an interface: every accepted change set becomes exactly one commit,
// made with plumbing (`write-tree`, `commit-tree`, `update-ref`), so no hook,
// editor, pager, prompt or user config ever runs.
//
// The repository's working tree is the brain's content (./git-content.ts).
// Postgres records which commit the repository is at (`server_brains.git_head`)
// in the same transaction as everything else a write changes; `recover` puts
// the repository back to that commit when the two disagree (a crash or a
// failed transaction after the commit was made). See ./brains.ts.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { devNull } from 'node:os';
import { join } from 'node:path';

/**
 * The environment every git call runs with: no system or user config, no
 * pager, no prompts, the C locale, and nothing that points git at another
 * repository (`GIT_DIR`, `GIT_WORK_TREE`, ...) passed on.
 */
export function gitEnvironment(
  extra: Readonly<Record<string, string>> = {},
  base: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  return {
    PATH: base.PATH ?? '/usr/bin:/bin',
    HOME: devNull,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_EDITOR: 'false',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_OPTIONAL_LOCKS: '0',
    ...extra,
  };
}

/** `-c` options for every call, whatever the repository's own config says. */
const GIT_CONFIG = [
  '-c',
  `core.hooksPath=${devNull}`,
  '-c',
  `core.excludesFile=${devNull}`,
  '-c',
  `core.attributesFile=${devNull}`,
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.safecrlf=false',
  '-c',
  'core.quotePath=false',
  '-c',
  'core.precomposeUnicode=false',
  '-c',
  'commit.gpgSign=false',
  '-c',
  'gc.autoDetach=false',
  '-c',
  'advice.detachedHead=false',
];

/** The branch every brain repository commits to. */
export const BRANCH = 'main';
const BRANCH_REF = `refs/heads/${BRANCH}`;
/** Commits made but never recorded by the database are kept under this prefix, not deleted. */
export const ORPHAN_REF_PREFIX = 'refs/somememos/unrecorded/';

/** The server's committer identity. Authors are the clients that sent each change. */
export const COMMITTER = { name: 'somememos server', email: 'server@somememos.invalid' };

/** A git command failed. The message never includes file content. */
export class GitError extends Error {
  override name = 'GitError';
}

export interface GitRunOptions {
  /** Bytes or text for stdin. */
  readonly input?: string | Buffer;
  /** Extra environment variables (author and committer identities). */
  readonly env?: Readonly<Record<string, string>>;
  /** Exit codes that are not errors (default only 0). */
  readonly okCodes?: readonly number[];
}

/** Runs git in `cwd`; resolves with stdout (bytes) and the exit code. */
export function runGitRaw(
  cwd: string,
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<{ stdout: Buffer; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...GIT_CONFIG, ...args], {
      cwd,
      env: gitEnvironment(options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => reject(new GitError(`git could not run: ${error.message}`)));
    child.on('close', (code) => {
      const exit = code ?? -1;
      if (exit === 0 || options.okCodes?.includes(exit)) {
        resolve({ stdout: Buffer.concat(out), code: exit });
      } else {
        const detail = Buffer.concat(err).toString('utf8').trim().split('\n')[0] ?? '';
        reject(new GitError(`git ${args[0] ?? ''} failed (${exit})${detail ? `: ${detail}` : ''}`));
      }
    });
    child.stdin.on('error', () => undefined); // git may exit before reading all of stdin
    child.stdin.end(options.input ?? '');
  });
}

/** Runs git and returns stdout as UTF-8 text. */
export async function runGit(
  cwd: string,
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<string> {
  return (await runGitRaw(cwd, args, options)).stdout.toString('utf8');
}

/** One path a staged change set touches (`git diff --cached --name-status`, exact renames). */
export type StagedChange =
  | { readonly status: 'added' | 'modified' | 'deleted'; readonly path: string }
  | { readonly status: 'renamed'; readonly from: string; readonly to: string };

export interface CommitInput {
  /** The client the change came from: the commit's author. */
  readonly author: string;
  /** When the change was made, Unix seconds: the author date. */
  readonly time: number;
  readonly message: string;
}

export interface CommitInfo {
  readonly commit: string;
  readonly author: string;
  /** Author time, Unix seconds. */
  readonly time: number;
  /** Committer time, Unix seconds. */
  readonly committedAt: number;
  readonly message: string;
}

const HEX = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** True for a full commit id (SHA-1 or SHA-256 hex). */
export function isCommitId(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value);
}

/** Git rejects these in an identity; client ids never contain them, but be sure. */
function identity(name: string): string {
  return name.replace(/[<>\n\r\0]/g, '').trim() || 'unknown';
}

/** A commit message as stored: control characters other than newline and tab become spaces. */
export function commitMessage(message: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = message.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
  return `${clean.trim() === '' ? '(no message)' : clean.trimEnd()}\n`;
}

/** A brain's repository: a working tree (the notes) with its `.git` inside. */
export class BrainRepo {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  private git(args: readonly string[], options?: GitRunOptions): Promise<string> {
    return runGit(this.dir, args, options);
  }

  /** True when the repository exists on disk. */
  exists(): boolean {
    return existsSync(join(this.dir, '.git'));
  }

  /** Creates the directory and an empty repository on `main` (idempotent). */
  async init(): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    if (this.exists()) return;
    await this.git(['init', '-q', '-b', BRANCH]);
    for (const [key, value] of [
      ['core.hooksPath', devNull],
      ['core.autocrlf', 'false'],
      ['core.quotePath', 'false'],
      ['gc.autoDetach', 'false'],
      ['receive.denyCurrentBranch', 'refuse'],
    ] as const) {
      await this.git(['config', key, value]);
    }
  }

  /** The commit `main` points at, or null before the first commit. */
  async head(): Promise<string | null> {
    const { stdout, code } = await runGitRaw(
      this.dir,
      ['rev-parse', '-q', '--verify', `${BRANCH_REF}^{commit}`],
      { okCodes: [1, 128] },
    );
    return code === 0 ? stdout.toString('utf8').trim() : null;
  }

  /** True when the working tree and index equal `main` and nothing is untracked. */
  async isClean(): Promise<boolean> {
    const out = await runGitRaw(this.dir, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]);
    return out.stdout.length === 0;
  }

  /**
   * Puts the repository back to `recorded` (the commit the database says it
   * is at; null for none) when it is anywhere else: a commit the database
   * never recorded is kept under `ORPHAN_REF_PREFIX` (history is not
   * rewritten, nothing is deleted), and the working tree and index are reset
   * to `recorded` with untracked files removed. Returns what it did.
   */
  async recover(
    recorded: string | null,
  ): Promise<{ recovered: boolean; unrecorded: string | null }> {
    const head = await this.head();
    if (head === recorded && (await this.isClean())) return { recovered: false, unrecorded: null };
    let unrecorded: string | null = null;
    if (head !== null && head !== recorded) {
      unrecorded = head;
      await this.git(['update-ref', `${ORPHAN_REF_PREFIX}${head}`, head]);
    }
    if (recorded === null) {
      if (head !== null) await this.git(['update-ref', '-d', BRANCH_REF]);
      await this.git(['read-tree', '--empty']);
    } else {
      if (!isCommitId(recorded)) throw new GitError('the recorded commit is not a commit id');
      const { code } = await runGitRaw(this.dir, ['cat-file', '-e', `${recorded}^{commit}`], {
        okCodes: [1, 128],
      });
      if (code !== 0) {
        throw new GitError(
          'the brain repository does not contain the commit the database records (was the data volume restored from an older backup?)',
        );
      }
      await this.git(['update-ref', BRANCH_REF, recorded]);
      await this.git(['reset', '-q', '--hard', recorded]);
    }
    await this.git(['clean', '-q', '-ffdx']);
    return { recovered: true, unrecorded };
  }

  /** Stages every change in the working tree and lists them (renames detected only for identical content). */
  async stageAll(): Promise<StagedChange[]> {
    await this.git(['add', '-A', '--force', '--', '.']);
    const out = await this.git([
      'diff',
      '--cached',
      '--name-status',
      '-z',
      '--find-renames=100%',
      '--no-ext-diff',
      '--no-color',
    ]);
    const tokens = out.split('\0');
    const changes: StagedChange[] = [];
    for (let i = 0; i < tokens.length - 1;) {
      const status = tokens[i++] as string;
      if (status.startsWith('R')) {
        changes.push({ status: 'renamed', from: tokens[i++] as string, to: tokens[i++] as string });
      } else {
        const path = tokens[i++] as string;
        const kind = status[0] === 'A' ? 'added' : status[0] === 'D' ? 'deleted' : 'modified';
        changes.push({ status: kind, path });
      }
    }
    return changes;
  }

  /**
   * Commits the index (after `stageAll`) as one commit on `main`, authored
   * as `input.author` at `input.time`, committed by the server now. Returns
   * the new commit id.
   */
  async commit(input: CommitInput, committedAt: number): Promise<string> {
    const parent = await this.head();
    const tree = (await this.git(['write-tree'])).trim();
    const author = identity(input.author);
    const env = {
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: `${author.replace(/[^A-Za-z0-9._-]/g, '-')}@clients.somememos.invalid`,
      GIT_AUTHOR_DATE: `@${Math.floor(input.time)} +0000`,
      GIT_COMMITTER_NAME: COMMITTER.name,
      GIT_COMMITTER_EMAIL: COMMITTER.email,
      GIT_COMMITTER_DATE: `@${Math.floor(committedAt)} +0000`,
    };
    const commit = (
      await this.git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-F', '-'], {
        input: commitMessage(input.message),
        env,
      })
    ).trim();
    await this.git(['update-ref', BRANCH_REF, commit, parent ?? '']);
    return commit;
  }

  /** Each `{ commit, path }`'s text, or undefined where the path is not in that commit. One git process. */
  async readAt(
    specs: readonly { commit: string; path: string }[],
  ): Promise<(string | undefined)[]> {
    if (specs.length === 0) return [];
    for (const s of specs) {
      if (!isCommitId(s.commit) || /[\n\r]/.test(s.path)) throw new GitError('bad object name');
    }
    const input = specs.map((s) => `${s.commit}:${s.path}\n`).join('');
    const { stdout } = await runGitRaw(this.dir, ['cat-file', '--batch'], { input });
    const out: (string | undefined)[] = [];
    let at = 0;
    for (let i = 0; i < specs.length; i++) {
      const nl = stdout.indexOf(0x0a, at);
      if (nl < 0) throw new GitError('cat-file output ended early');
      const header = stdout.subarray(at, nl).toString('utf8');
      at = nl + 1;
      const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
      if (!m) {
        out.push(undefined); // "<name> missing" (or ambiguous)
        continue;
      }
      const size = Number(m[2]);
      const body = stdout.subarray(at, at + size);
      at += size + 1;
      out.push(m[1] === 'blob' ? body.toString('utf8') : undefined);
    }
    return out;
  }

  /** Author, times and message of each commit, in the order given. */
  async commitInfo(commits: readonly string[]): Promise<Map<string, CommitInfo>> {
    const info = new Map<string, CommitInfo>();
    const unique = [...new Set(commits)];
    if (unique.length === 0) return info;
    for (const c of unique) if (!isCommitId(c)) throw new GitError('bad commit id');
    const out = await this.git([
      'log',
      '--no-walk=unsorted',
      '--no-decorate',
      '--no-mailmap',
      '--encoding=UTF-8',
      '--format=%x01%H%x00%an%x00%at%x00%ct%x00%B',
      ...unique,
    ]);
    for (const record of out.split('\x01')) {
      if (record === '') continue;
      const [commit, author, at, ct, ...rest] = record.split('\0');
      if (!commit) continue;
      info.set(commit, {
        commit,
        author: author ?? '',
        time: Number(at),
        committedAt: Number(ct),
        message: rest.join('\0').replace(/\n+$/, ''),
      });
    }
    return info;
  }

  /** Runs `git gc --auto` (cheap when there is nothing to do). */
  async maintain(): Promise<void> {
    await this.git(['gc', '--auto', '--quiet']);
  }
}
