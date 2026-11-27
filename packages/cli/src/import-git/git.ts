// Reading a git history for `import-git`: a controlled environment, a
// streaming parser for `git log -z --raw`, and a `git cat-file --batch` reader
// for blob contents. Nothing here knows about notes or events.

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { devNull } from 'node:os';

/**
 * The environment every git call runs with: no system or user config, no
 * pager, no prompts, the C locale. Variables that would point git at another
 * repository (`GIT_DIR`, `GIT_WORK_TREE`, ...) are not passed on. The
 * repository's own `.git/config` still applies, so every option that changes
 * the output is also given on the command line.
 */
export function gitEnvironment(
  base: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: base.PATH ?? base.Path ?? '/usr/bin:/bin',
    HOME: base.HOME ?? devNull,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
  };
  if (base.SYSTEMROOT) env.SYSTEMROOT = base.SYSTEMROOT; // Windows
  return env;
}

/** `-c` options that pin down everything in the output a repository config could change. */
const GIT_CONFIG = [
  '-c',
  'core.quotePath=false',
  '-c',
  'diff.renameLimit=0',
  '-c',
  'diff.noprefix=false',
  '-c',
  'log.showSignature=false',
  '-c',
  'log.showRoot=true',
  '-c',
  'i18n.logOutputEncoding=UTF-8',
  '-c',
  'core.precomposeUnicode=true',
];

/** A git command failed. The message never includes file content. */
export class GitError extends Error {
  override name = 'GitError';
}

/** Runs a short git command in `cwd` and returns its stdout (UTF-8). */
export function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...GIT_CONFIG, ...args],
      { cwd, env: gitEnvironment(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim().split('\n')[0] ?? '';
          reject(new GitError(`git ${args[0] ?? ''} failed${detail ? `: ${detail}` : ''}`));
        } else resolve(stdout);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// The log

/** One file change in a commit, from `git log --raw`. */
export interface RawChange {
  /** The status letter: A, C, D, M, R, T, U or X. */
  readonly status: string;
  /** The similarity score for R and C (0-100); null otherwise. */
  readonly score: number | null;
  /** The file modes as octal strings: `000000` when absent. */
  readonly oldMode: string;
  readonly newMode: string;
  /** Blob ids; all zeros when absent. */
  readonly oldSha: string;
  readonly newSha: string;
  /** Paths relative to the directory the log ran in. For A, `oldPath === newPath`. */
  readonly oldPath: string;
  readonly newPath: string;
}

export interface LogCommit {
  readonly hash: string;
  readonly parents: readonly string[];
  /** Author time, Unix seconds. */
  readonly authorTime: number;
  /** Committer time, Unix seconds. */
  readonly committerTime: number;
  /** The full message (subject and body), without the trailing newline. */
  readonly message: string;
  readonly changes: readonly RawChange[];
}

const COMMIT_MARK = '\x01';

/**
 * The arguments of the one `git log` call: first-parent history, oldest
 * first, each commit (merges too) diffed against its first parent, renames
 * detected, NUL-separated raw output, paths relative to the brain and
 * limited to it.
 */
export const LOG_ARGS: readonly string[] = [
  'log',
  '--first-parent',
  '--reverse',
  '--diff-merges=first-parent',
  '--root',
  '-M',
  '--raw',
  '-z',
  '--no-abbrev',
  '--relative',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-notes',
  '--no-show-signature',
  '--no-mailmap',
  '--encoding=UTF-8',
  `--format=${COMMIT_MARK}%H%x00%P%x00%at%x00%ct%x00%B%x00`,
];

/**
 * Splits a byte stream into NUL-terminated tokens, decoding each as UTF-8
 * only once it is complete (so a character is never cut in half).
 */
async function* nulTokens(stream: AsyncIterable<Buffer>): AsyncGenerator<string> {
  let rest: Buffer = Buffer.alloc(0);
  for await (const chunk of stream) {
    let buf: Buffer = rest.length > 0 ? Buffer.concat([rest, chunk]) : chunk;
    let start = 0;
    for (;;) {
      const end = buf.indexOf(0, start);
      if (end < 0) break;
      yield buf.toString('utf8', start, end);
      start = end + 1;
    }
    buf = buf.subarray(start);
    rest = Buffer.from(buf);
  }
  if (rest.length > 0) yield rest.toString('utf8');
}

function parseRawHeader(token: string): Omit<RawChange, 'oldPath' | 'newPath'> {
  // ":<oldmode> <newmode> <oldsha> <newsha> <status><score>"
  const fields = token.slice(1).split(' ');
  if (fields.length !== 5) throw new GitError('unexpected git log output');
  const [oldMode, newMode, oldSha, newSha, statusField] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const status = statusField.charAt(0);
  const score = statusField.length > 1 ? Number(statusField.slice(1)) : null;
  return { status, score, oldMode, newMode, oldSha, newSha };
}

/**
 * Parses the tokens of `git log` with `LOG_ARGS`. Header fields and paths are
 * read by position, so a message or file name may hold any character git
 * allows (none can hold NUL).
 */
export async function* parseLog(tokens: AsyncIterable<string>): AsyncGenerator<LogCommit> {
  const it = tokens[Symbol.asyncIterator]();
  const next = async (): Promise<string> => {
    const r = await it.next();
    if (r.done) throw new GitError('git log output ended early');
    return r.value;
  };

  let pending: string | undefined;
  const take = async (): Promise<string | undefined> => {
    if (pending !== undefined) {
      const t = pending;
      pending = undefined;
      return t;
    }
    const r = await it.next();
    return r.done ? undefined : r.value;
  };

  for (;;) {
    let token = await take();
    // Separators between sections: empty tokens and newlines.
    while (token !== undefined && token.replace(/^\n+/, '') === '') token = await take();
    if (token === undefined) return;
    token = token.replace(/^\n+/, '');
    if (!token.startsWith(COMMIT_MARK)) throw new GitError('unexpected git log output');

    const hash = token.slice(1);
    const parentsField = await next();
    const authorTime = Number(await next());
    const committerTime = Number(await next());
    const message = (await next()).replace(/\n+$/, '');
    const changes: RawChange[] = [];

    for (;;) {
      let t = await take();
      while (t !== undefined && t.replace(/^\n+/, '') === '') t = await take();
      if (t === undefined) break;
      const stripped = t.replace(/^\n+/, '');
      if (stripped.startsWith(COMMIT_MARK)) {
        pending = stripped;
        break;
      }
      if (!stripped.startsWith(':')) throw new GitError('unexpected git log output');
      const header = parseRawHeader(stripped);
      const oldPath = await next();
      const newPath = header.status === 'R' || header.status === 'C' ? await next() : oldPath;
      changes.push({ ...header, oldPath, newPath });
    }

    yield {
      hash,
      parents: parentsField === '' ? [] : parentsField.split(' '),
      authorTime,
      committerTime,
      message,
      changes,
    };
  }
}

/** A running `git log` whose commits are read one at a time. */
export interface LogStream extends AsyncIterable<LogCommit> {
  /** Stops git early (when the caller has seen enough). */
  stop(): void;
  /** Resolves when git exits; rejects with a `GitError` if it failed (and was not stopped). */
  done(): Promise<void>;
}

/** Streams `git log` with `LOG_ARGS`, limited to `cwd`, plus any extra revision arguments. */
export function streamLog(cwd: string, revisions: readonly string[] = []): LogStream {
  const child = spawn('git', [...GIT_CONFIG, ...LOG_ARGS, ...revisions, '--', '.'], {
    cwd,
    env: gitEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stopped = false;
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (s: string) => {
    if (stderr.length < 4096) stderr += s;
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  return {
    [Symbol.asyncIterator]: () => parseLog(nulTokens(child.stdout))[Symbol.asyncIterator](),
    stop() {
      stopped = true;
      child.stdout.destroy();
      child.kill();
    },
    async done() {
      const code = await exited;
      if (code !== 0 && !stopped) {
        // git's message names no file content; keep only its first line.
        const detail = stderr.trim().split('\n')[0] ?? '';
        throw new GitError(`git log failed (exit ${code})${detail ? `: ${detail}` : ''}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Trees

/** One file in a commit's tree, from `git ls-tree`. */
export interface TreeEntry {
  /** The file mode as an octal string (`100644`, `100755`, `120000`, …). */
  readonly mode: string;
  readonly sha: string;
  /** Relative to the directory the command ran in. */
  readonly path: string;
}

/**
 * Every blob in `commit`'s tree under `cwd`, with paths relative to `cwd`
 * (one `git ls-tree -r -z` call; submodules and trees are left out).
 */
export async function listTree(cwd: string, commit: string): Promise<TreeEntry[]> {
  if (!/^[0-9a-f]{4,64}$/.test(commit)) throw new GitError(`not a commit id: ${commit}`);
  const out = await runGit(cwd, ['ls-tree', '-r', '-z', '--no-abbrev', commit, '--', '.']);
  const entries: TreeEntry[] = [];
  for (const record of out.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    if (tab < 0) throw new GitError('unexpected git ls-tree output');
    const [mode, type, sha] = record.slice(0, tab).split(' ') as [string, string, string];
    if (type !== 'blob') continue;
    entries.push({ mode, sha, path: record.slice(tab + 1) });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Blobs

/** Buffered reads of exact byte counts and lines from a stream. */
class ByteReader {
  private chunks: Buffer[] = [];
  private length = 0;
  private ended = false;
  private failure: Error | null = null;
  private waiter: (() => void) | null = null;

  constructor(stream: NodeJS.ReadableStream) {
    stream.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.length += chunk.length;
      this.wake();
    });
    stream.on('end', () => {
      this.ended = true;
      this.wake();
    });
    stream.on('error', (error: Error) => {
      this.failure = error;
      this.wake();
    });
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  private async fill(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.ended) throw new GitError('git cat-file ended early');
    await new Promise<void>((resolve) => (this.waiter = resolve));
  }

  private flat(): Buffer {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)];
    return this.chunks[0] ?? Buffer.alloc(0);
  }

  private consume(n: number): Buffer {
    const buf = this.flat();
    const out = buf.subarray(0, n);
    const rest = buf.subarray(n);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.length -= n;
    return out;
  }

  async line(): Promise<string> {
    for (;;) {
      if (this.length > 0) {
        const at = this.flat().indexOf(0x0a);
        if (at >= 0) return this.consume(at + 1).toString('utf8', 0, at);
      }
      await this.fill();
    }
  }

  /** Reads `n` bytes; keeps them only when `keep` (otherwise returns null and discards them). */
  async bytes(n: number, keep: boolean): Promise<Buffer | null> {
    if (!keep) {
      let left = n;
      while (left > 0) {
        if (this.length === 0) await this.fill();
        const k = Math.min(left, this.length);
        this.consume(k);
        left -= k;
      }
      return null;
    }
    while (this.length < n) await this.fill();
    return Buffer.from(this.consume(n));
  }
}

/** What a blob read found. */
export type BlobResult =
  | { readonly kind: 'text'; readonly text: string }
  /** Larger than the limit, or not a blob, or missing: its content is unknown. */
  | { readonly kind: 'skipped'; readonly reason: 'large' | 'binary' | 'missing' };

/** A long-running `git cat-file --batch`. Reads are serialized. */
export class BlobReader {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly reader: ByteReader;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly maxBytes: number;

  constructor(cwd: string, maxBytes: number) {
    this.maxBytes = maxBytes;
    this.child = spawn('git', [...GIT_CONFIG, 'cat-file', '--batch'], {
      cwd,
      env: gitEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.resume();
    this.child.on('error', () => {});
    this.reader = new ByteReader(this.child.stdout);
  }

  /** Reads several blobs with one round trip. */
  read(shas: readonly string[]): Promise<BlobResult[]> {
    const run = async (): Promise<BlobResult[]> => {
      if (shas.length === 0) return [];
      this.child.stdin.write(shas.map((s) => `${s}\n`).join(''));
      const out: BlobResult[] = [];
      for (let i = 0; i < shas.length; i++) {
        const header = await this.reader.line();
        const parts = header.split(' ');
        if (parts.length !== 3) {
          out.push({ kind: 'skipped', reason: 'missing' });
          continue;
        }
        const type = parts[1];
        const size = Number(parts[2]);
        const keep = type === 'blob' && size <= this.maxBytes;
        const content = await this.reader.bytes(size, keep);
        await this.reader.bytes(1, false); // the newline after the content
        if (type !== 'blob') out.push({ kind: 'skipped', reason: 'missing' });
        else if (content === null) out.push({ kind: 'skipped', reason: 'large' });
        else if (content.includes(0)) out.push({ kind: 'skipped', reason: 'binary' });
        else out.push({ kind: 'text', text: content.toString('utf8') });
      }
      return out;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}
