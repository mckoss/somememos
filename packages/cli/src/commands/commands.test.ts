// The first real commands, run through `run` with a fake context: output,
// --json shapes, exit codes and the global options. All content is invented.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeContext, tempDir, writeNote, writeTestConfig } from '../brain/testing.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, run } from '../index.js';
import { openBrainStores } from '../store/index.js';
import { commands } from './index.js';
import { localDate } from './diary.js';
import { GITIGNORE_LINE, ensureGitignoreLine } from './init.js';

const NOW = 1_760_000_000;
const ROLES = {
  memo: ['memos/'],
  dated: ['diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md'],
  source: ['sources/'],
  excluded: ['private/'],
};

let tmp: ReturnType<typeof tempDir>;
let dir: string;

beforeEach(() => {
  tmp = tempDir();
  dir = tmp.dir;
});
afterEach(() => tmp.remove());

async function cli(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const io = fakeContext({ cwd: options.cwd ?? dir, env: options.env ?? {}, now: NOW });
  const code = await run(args, io.ctx);
  return { code, stdout: io.stdout(), stderr: io.stderr() };
}

async function json<T = Record<string, unknown>>(args: string[], cwd = dir): Promise<T> {
  const r = await cli([...args, '--json'], { cwd });
  expect(r.code, r.stderr).toBe(EXIT_OK);
  return JSON.parse(r.stdout) as T;
}

/** A brain with roles and a few notes, already indexed (baseline). */
async function seededBrain(): Promise<void> {
  writeTestConfig(dir, { roles: ROLES });
  writeNote(dir, 'memos/apple.md', '# Apple\n\nGrafting notes, see [[pear]].\n', NOW - 500);
  writeNote(dir, 'memos/pear.md', '# Pear\n', NOW - 500);
  writeNote(dir, 'sources/manual.md', '# Manual\n', NOW - 500);
  expect((await cli(['index'])).code).toBe(EXIT_OK);
}

describe('help', () => {
  it('lists every command and the global options', async () => {
    const r = await cli(['--help']);
    for (const c of commands) expect(r.stdout).toContain(`  ${c.name} `);
    expect(r.stdout).toContain('--brain <dir>');
    expect(r.stdout).toContain('--no-index');
  });

  it.each(commands.map((c) => c.name))('%s has complete help with examples', async (name) => {
    for (const args of [
      [name, '--help'],
      ['help', name],
      ['--help', name],
    ]) {
      const r = await cli(args);
      expect(r.code).toBe(EXIT_OK);
      expect(r.stdout).toContain(`Usage: somememos ${name}`);
      expect(r.stdout).toMatch(/\nExamples?:\n/);
      expect(r.stdout).toContain('--json');
    }
  });
});

describe('init', () => {
  it('in an empty directory: default layout, folders, baseline index', async () => {
    const r = await cli(['init']);
    expect(r.code).toBe(EXIT_OK);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain(`initialized a brain in ${dir}`);
    expect(r.stdout).toContain('created folders: memos/, diary/, sources/');
    for (const f of ['memos', 'diary', 'sources']) expect(existsSync(join(dir, f))).toBe(true);
    const config = JSON.parse(readFileSync(join(dir, '.somememos/config.json'), 'utf8'));
    expect(config.roles).toEqual({
      source: ['sources/'],
      dated: ['diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md'],
      memo: ['memos/'],
    });
    expect(config.clientId).toMatch(/^[0-9a-f-]{36}$/);
    // The baseline was taken, so the first memo written is logged.
    writeNote(dir, 'memos/first.md', '# First\n', NOW - 5);
    const status = await json<{ events: { edit: number } }>(['status']);
    expect(status.events.edit).toBe(1);
  });

  it('in a directory with markdown: no folders, no roles, a hint, no index yet', async () => {
    writeNote(dir, 'Inbox.md', '# Inbox\n');
    writeNote(dir, 'projects/kite.md', '# Kite\n');
    const r = await cli(['init']);
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toContain('roles: none declared (every note is a memo)');
    expect(r.stdout).toContain('hint: No folder roles are declared');
    expect(existsSync(join(dir, 'memos'))).toBe(false);
    expect(readdirSync(join(dir, '.somememos'))).toEqual(['config.json']);
    const config = JSON.parse(readFileSync(join(dir, '.somememos/config.json'), 'utf8'));
    expect(config.roles).toEqual({});
  });

  it('takes a directory argument, creating it, and prints a stable --json record', async () => {
    const target = join(dir, 'new-brain');
    const record = await json(['init', 'new-brain']);
    expect(Object.keys(record).sort()).toEqual(
      [
        'clientId',
        'config',
        'createdFolders',
        'gitignore',
        'hint',
        'index',
        'roles',
        'root',
      ].sort(),
    );
    expect(record.root).toBe(target);
    expect(record.gitignore).toBeNull();
  });

  it('refuses an initialized brain with exit 1 and one line on stderr', async () => {
    await cli(['init']);
    const before = readFileSync(join(dir, '.somememos/config.json'), 'utf8');
    const r = await cli(['init']);
    expect(r.code).toBe(EXIT_FAILURE);
    expect(r.stdout).toBe('');
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
    expect(r.stderr).toContain('already a brain');
    expect(readFileSync(join(dir, '.somememos/config.json'), 'utf8')).toBe(before);
  });

  it('adds the databases to .gitignore inside a git repository, once', async () => {
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.gitignore'), 'node_modules/');
    const r = await cli(['init']);
    expect(r.stdout).toContain(`added '${GITIGNORE_LINE}' to ${join(dir, '.gitignore')}`);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe(
      `node_modules/\n${GITIGNORE_LINE}\n`,
    );
    expect(ensureGitignoreLine(dir, GITIGNORE_LINE)).toBe(false);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe(
      `node_modules/\n${GITIGNORE_LINE}\n`,
    );
  });

  it('rejects two directories with exit 2', async () => {
    expect((await cli(['init', 'a', 'b'])).code).toBe(EXIT_USAGE);
  });
});

describe('index', () => {
  it('prints a summary line, and --json the summary record', async () => {
    writeTestConfig(dir, { roles: ROLES });
    writeNote(dir, 'memos/a.md', '# A\n', NOW - 50);
    const first = await cli(['index']);
    expect(first.stdout).toMatch(
      /^baseline: indexed 1 note; the first index of a brain logs no events \(.+ ms\)\n$/,
    );
    const same = await cli(['index']);
    expect(same.stdout).toMatch(/^up to date: 1 note \(.+ ms\)\n$/);
    writeNote(dir, 'memos/a.md', '# A\n\n[[b]]\n', NOW - 5);
    const changed = await cli(['index']);
    expect(changed.stdout).toMatch(
      /^indexed 1 note \(1 scanned\); logged 1 edit, 1 mention \(.+ ms\)\n$/,
    );
    const record = await json(['index', '--rebuild']);
    expect(Object.keys(record).sort()).toEqual(
      [
        'baseline',
        'changed',
        'events',
        'folded',
        'indexed',
        'ms',
        'relinked',
        'removed',
        'renamed',
        'rebuilt',
        'scanned',
        'warnings',
      ].sort(),
    );
    expect(record).toMatchObject({ rebuilt: true, indexed: 1, folded: { events: 2, renames: 0 } });
  });

  it('prints a changed source as a warning on stderr', async () => {
    await seededBrain();
    writeNote(dir, 'sources/manual.md', '# Manual\n\nRevised.\n', NOW - 5);
    const r = await cli(['index']);
    expect(r.code).toBe(EXIT_OK);
    expect(r.stderr).toBe(
      'somememos: warning: source changed: sources/manual.md (re-indexed; sources are immutable, no event logged)\n',
    );
  });
});

describe('commit', () => {
  beforeEach(seededBrain);

  it('with no changes says so and exits 0', async () => {
    const r = await cli(['commit', '-m', 'update nothing']);
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toBe('nothing to commit: no changes since the last commit\n');
    const store = openBrainStores(dir);
    expect(await store.events.changes()).toEqual([]);
    store.close();
  });

  it('writes one change record for the changes the pass found', async () => {
    writeNote(dir, 'memos/apple.md', '# Apple\n\nGrafting notes, revised.\n', NOW - 20);
    writeNote(dir, 'memos/quince.md', '# Quince\n', NOW - 10);
    const r = await cli(['commit', '-m', 'update test the orchard notes']);
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toBe(
      'committed 2 notes (update): update test the orchard notes\n  memos/apple.md\n  memos/quince.md\n',
    );
    const store = openBrainStores(dir);
    const changes = await store.events.changes();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      time: NOW,
      client: 'test-client',
      message: 'update test the orchard notes',
      op: 'update',
      paths: ['memos/apple.md', 'memos/quince.md'],
    });
    store.close();
    expect((await cli(['commit'])).stdout).toContain('nothing to commit');
  });

  it('covers changes an earlier automatic pass already logged', async () => {
    writeNote(dir, 'memos/pear.md', '# Pear\n\nRipening.\n', NOW - 20);
    const status = await json<{ uncommitted: string[]; events: { edit: number } }>(['status']);
    expect(status.uncommitted).toEqual(['memos/pear.md']);
    expect(status.events.edit).toBe(1);
    const record = await json<{ committed: boolean; change: { paths: string[]; op: null } }>([
      'commit',
      '-m',
      'ripening notes',
    ]);
    expect(record.committed).toBe(true);
    expect(record.change.paths).toEqual(['memos/pear.md']);
    expect(record.change.op).toBeNull();
    const after = await json<{ uncommitted: string[]; events: { edit: number } }>(['status']);
    expect(after.uncommitted).toEqual([]);
    expect(after.events.edit).toBe(1); // the commit logged no second edit
  });

  it('commits only the given paths (files or folders, relative to the working directory)', async () => {
    writeNote(dir, 'memos/apple.md', '# Apple\n\nOne.\n', NOW - 20);
    writeNote(dir, 'memos/deep/plum.md', '# Plum\n', NOW - 20);
    writeNote(dir, 'diary/2025/10/2025-10-08.md', '# Day\n', NOW - 20);
    const r = await cli(['commit', '-m', 'ingest plums', 'deep'], { cwd: join(dir, 'memos') });
    expect(r.stdout).toBe(
      'committed 1 note (ingest): ingest plums\n  memos/deep/plum.md\n2 other changed notes not committed\n',
    );
    const record = await json<{
      remaining: string[];
      change: { paths: string[]; message: string };
    }>(['commit', '-m', 'first paragraph', '-m', 'second', 'memos/apple.md']);
    expect(record.change.paths).toEqual(['memos/apple.md']);
    expect(record.change.message).toBe('first paragraph\n\nsecond');
    expect(record.remaining).toEqual(['diary/2025/10/2025-10-08.md']);
    expect((await cli(['commit', 'memos/pear.md'])).stdout).toBe(
      'nothing to commit among the given paths; 1 other changed note not committed\n',
    );
  });

  it('records deletes and renames as changed paths', async () => {
    renameSync(join(dir, 'memos/pear.md'), join(dir, 'memos/renamed-pear.md'));
    rmSync(join(dir, 'memos/apple.md'));
    const record = await json<{ change: { paths: string[] } }>(['commit', '-m', 'lint tidy']);
    expect(record.change.paths).toEqual([
      'memos/apple.md',
      'memos/pear.md',
      'memos/renamed-pear.md',
    ]);
  });

  it('refuses a path outside the brain with exit 2', async () => {
    const r = await cli(['commit', '/somewhere/else.md']);
    expect(r.code).toBe(EXIT_USAGE);
    expect(r.stderr).toContain('outside the brain');
  });

  it('prints a stable --json record', async () => {
    writeNote(dir, 'memos/pear.md', '# Pear\n\nx\n', NOW - 20);
    const record = await json<Record<string, unknown> & { change: Record<string, unknown> }>([
      'commit',
      '-m',
      'session pears',
    ]);
    expect(Object.keys(record).sort()).toEqual(['change', 'committed', 'index', 'remaining']);
    expect(Object.keys(record.change).sort()).toEqual(
      ['client', 'id', 'message', 'op', 'paths', 'time'].sort(),
    );
  });
});

describe('status', () => {
  beforeEach(seededBrain);

  it('prints counts, uncommitted changes and the config', async () => {
    writeNote(dir, 'memos/pear.md', '# Pear\n\nSee [[apple]] and [[medlar]].\n', NOW - 20);
    const r = await cli(['status']);
    expect(r.code).toBe(EXIT_OK);
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines).toEqual([
      `brain: ${dir}`,
      'notes: 3 (memo 2, dated 0, source 1); 3 sections; 1 dangling link target',
      'events: 1 edit, 2 mention, 0 read, 0 rename; 0 change records',
      'folded: through 3 of 3',
      'uncommitted: 1 changed note (somememos commit -m "<why>")',
      '  memos/pear.md',
      'weights: read 1, edit 1, mention 1; alpha 1',
      'half-lives: day 1d, week 7d, month 30d, year 365d',
      'roles: excluded private/; source sources/; dated diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md; memo memos/',
    ]);
  });

  it('prints a stable --json record', async () => {
    const record = await json<Record<string, unknown>>(['status']);
    expect(Object.keys(record).sort()).toEqual(
      [
        'changes',
        'clientId',
        'config',
        'dangling',
        'events',
        'firstIndexedAt',
        'fold',
        'index',
        'notes',
        'root',
        'sections',
        'uncommitted',
      ].sort(),
    );
    expect(record.notes).toEqual({ total: 3, memo: 2, dated: 0, source: 1 });
    expect(record.events).toEqual({ read: 0, edit: 0, mention: 0, rename: 0 });
    expect(record.firstIndexedAt).toBe(NOW);
    expect(Object.keys(record.config as object).sort()).toEqual(
      ['alpha', 'analyzer', 'changeOps', 'halfLives', 'roles', 'weights'].sort(),
    );
  });
});

describe('diary', () => {
  it("prints today's entry path, creating it with a heading once", async () => {
    writeTestConfig(dir, { roles: ROLES });
    const today = localDate(NOW);
    const expected = `diary/${today.slice(0, 4)}/${today.slice(5, 7)}/${today}.md`;
    const r = await cli(['diary']);
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toBe(`${expected}\n`);
    expect(readFileSync(join(dir, expected), 'utf8')).toBe(`# ${today}\n`);
    writeFileSync(join(dir, expected), `# ${today}\n\nNotes.\n`);
    const again = await json<{ created: boolean; path: string; file: string; date: string }>([
      'diary',
    ]);
    expect(again).toEqual({
      path: expected,
      file: join(dir, expected),
      date: today,
      created: false,
    });
    expect(readFileSync(join(dir, expected), 'utf8')).toBe(`# ${today}\n\nNotes.\n`);
  });

  it('takes --date, and prints a path relative to the working directory', async () => {
    writeTestConfig(dir, { roles: ROLES });
    mkdirSync(join(dir, 'memos'));
    const r = await cli(['diary', '--date', '2025-02-28'], { cwd: join(dir, 'memos') });
    expect(r.stdout).toBe('../diary/2025/02/2025-02-28.md\n');
  });

  it('rejects a bad date with exit 2', async () => {
    writeTestConfig(dir, { roles: ROLES });
    const r = await cli(['diary', '--date', '2025-02-30']);
    expect(r.code).toBe(EXIT_USAGE);
    expect(r.stderr).toContain('--date must be a calendar date');
  });

  it('fails clearly when the brain declares no dated pattern', async () => {
    writeTestConfig(dir, {});
    const r = await cli(['diary']);
    expect(r.code).toBe(EXIT_FAILURE);
    expect(r.stderr).toContain('declares no dated pattern');
  });
});

describe('global behaviour', () => {
  it('finds the brain from a subfolder', async () => {
    await seededBrain();
    const record = await json<{ root: string }>(['status'], join(dir, 'memos'));
    expect(record.root).toBe(dir);
  });

  it('takes --brain before or after the command, and SOMEMEMOS_BRAIN', async () => {
    await seededBrain();
    const elsewhere = tempDir();
    try {
      for (const args of [
        ['--brain', dir, 'status', '--json'],
        ['status', '--brain', dir, '--json'],
        [`--brain=${dir}`, '--json', 'status'],
      ]) {
        const r = await cli(args, { cwd: elsewhere.dir });
        expect(r.code, r.stderr).toBe(EXIT_OK);
        expect(JSON.parse(r.stdout).root).toBe(dir);
      }
      const r = await cli(['status', '--json'], {
        cwd: elsewhere.dir,
        env: { SOMEMEMOS_BRAIN: dir },
      });
      expect(JSON.parse(r.stdout).root).toBe(dir);
    } finally {
      elsewhere.remove();
    }
  });

  it('a missing brain exits 1 with one line naming somememos init', async () => {
    for (const args of [['status'], ['--brain', dir, 'status'], ['commit', '-m', 'x']]) {
      const r = await cli(args);
      expect(r.code).toBe(EXIT_FAILURE);
      expect(r.stdout).toBe('');
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
      expect(r.stderr).toContain('somememos init');
    }
  });

  it('--no-index skips the automatic pass', async () => {
    await seededBrain();
    writeNote(dir, 'memos/pear.md', '# Pear\n\nChanged.\n', NOW - 20);
    const skipped = await json<{ index: null; events: { edit: number } }>(['--no-index', 'status']);
    expect(skipped.index).toBeNull();
    expect(skipped.events.edit).toBe(0);
    const ran = await json<{ index: { indexed: number }; events: { edit: number } }>(['status']);
    expect(ran.index.indexed).toBe(1);
    expect(ran.events.edit).toBe(1);
  });

  it('an invalid config is a one-line error, with a stack only under SOMEMEMOS_DEBUG', async () => {
    writeTestConfig(dir, {});
    writeFileSync(
      join(dir, '.somememos/config.json'),
      '{"clientId": "x", "wieghts": {}, "alpha": -1}',
    );
    const r = await cli(['status']);
    expect(r.code).toBe(EXIT_FAILURE);
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
    expect(r.stderr).toContain('unknown key "wieghts"');
    expect(r.stderr).toContain('alpha');
    const debug = await cli(['status'], { env: { SOMEMEMOS_DEBUG: '1' } });
    expect(debug.stderr.split('\n').length).toBeGreaterThan(3);
    expect(debug.stderr).toContain('    at ');
  });

  it('unknown options exit 2', async () => {
    expect((await cli(['--frob', 'status'])).code).toBe(EXIT_USAGE);
    expect((await cli(['status', '--frob'])).code).toBe(EXIT_USAGE);
    expect((await cli(['--brain'])).code).toBe(EXIT_USAGE);
  });
});
