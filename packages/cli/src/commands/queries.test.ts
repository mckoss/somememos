// The query commands (search, hot, trending, neglected, read, log, export,
// import-log, help agents) on temp brains: text output, --json shapes, exit
// codes, and what they log. All content is invented (the synthetic brain
// generator, or notes written here).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectScoresClose } from '@somememos/core/testing/storage';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeContext, tempDir, writeNote, writeTestConfig } from '../brain/testing.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, run } from '../index.js';
import { openBrainStores } from '../store/index.js';
import {
  EXCLUDED_FOLDER,
  type SyntheticBrain,
  filesAfter,
  generateBrain,
  materializeGitHistory,
} from '../testing/index.js';
import { formatLocalTime } from './log.js';

const NOW = 1_760_000_000;
const ROLES = {
  memo: ['memos/'],
  dated: ['diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md'],
  source: ['sources/'],
  blog: ['blog/{YYYY}/{YYYY}-{MM}-{DD}-*.md', 'blog/'],
  excluded: [`${EXCLUDED_FOLDER}/`],
};

async function cli(dir: string, args: string[], now = NOW) {
  const io = fakeContext({ cwd: dir, now });
  const code = await run(args, io.ctx);
  return { code, stdout: io.stdout(), stderr: io.stderr() };
}

async function json<T>(dir: string, args: string[]): Promise<T> {
  const r = await cli(dir, [...args, '--json']);
  expect(r.code, r.stderr).toBe(EXIT_OK);
  return JSON.parse(r.stdout) as T;
}

async function eventCounts(dir: string): Promise<Record<string, number>> {
  return (await json<{ events: Record<string, number> }>(dir, ['status'])).events;
}

async function scoresOf(dir: string) {
  const stores = openBrainStores(dir);
  try {
    return await stores.scores.getAll();
  } finally {
    await stores.close();
  }
}

/** A brain with the synthetic history imported: notes, events, dangling links, change records. */
async function historyBrain(dir: string, seed = 3): Promise<SyntheticBrain> {
  const brain = generateBrain({ seed });
  materializeGitHistory(dir, brain);
  writeTestConfig(dir, { roles: ROLES });
  expect((await cli(dir, ['index'])).code).toBe(EXIT_OK);
  const imported = await cli(dir, ['import-git']);
  expect(imported.code, imported.stderr).toBe(EXIT_OK);
  return brain;
}

describe('on a brain with imported history', () => {
  let tmp: ReturnType<typeof tempDir>;
  let dir: string;
  let brain: SyntheticBrain;
  let files: Map<string, string>;

  beforeAll(async () => {
    tmp = tempDir();
    dir = join(tmp.dir, 'brain');
    brain = await historyBrain(dir);
    files = filesAfter(brain.steps);
  }, 60_000);
  afterAll(() => tmp.remove());

  describe('search', () => {
    it('prints one line per note: path, heading, snippet', async () => {
      const word = brain.topics[0]?.name as string;
      const r = await cli(dir, ['search', word, '--mode', 'all']);
      expect(r.code).toBe(EXIT_OK);
      const lines = r.stdout.trimEnd().split('\n');
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.length).toBeLessThanOrEqual(20);
      const paths = lines.map((l) => l.split('  ')[0] as string);
      expect(new Set(paths).size).toBe(paths.length);
      for (const [i, line] of lines.entries()) {
        expect(files.has(paths[i] as string), line).toBe(true);
        expect(paths[i]?.startsWith(`${EXCLUDED_FOLDER}/`)).toBe(false);
        expect(line).not.toContain('\t');
        const parts = line.split('  ');
        if (parts[1]?.startsWith('## ')) expect(parts.length).toBe(3);
      }
      // Stable across runs.
      expect((await cli(dir, ['search', word, '--mode', 'all'])).stdout).toBe(r.stdout);
      expect(
        (await cli(dir, ['search', word, '-n', '2'])).stdout.trimEnd().split('\n'),
      ).toHaveLength(2);
    });

    it('gives the full ResultView with --json', async () => {
      const word = brain.topics[1]?.name as string;
      const response = await json<{
        mode: string;
        query: string;
        at: number;
        results: Record<string, unknown>[];
      }>(dir, ['search', word, '--limit', '3']);
      expect(response).toMatchObject({ mode: 'hot', query: word, at: NOW });
      expect(response.results.length).toBeGreaterThan(0);
      for (const r of response.results) {
        expect(Object.keys(r).sort()).toEqual(
          [
            'components',
            'dangling',
            'date',
            'heading',
            'item',
            'now',
            'path',
            'published',
            'rankKey',
            'role',
            'sectionId',
            'snippet',
            'title',
          ].sort(),
        );
        expect(r.components).toMatchObject({ mode: 'hot' });
        expect(typeof (r.components as { relevance: unknown }).relevance).toBe('number');
      }
    });

    it('prints nothing for no results, and refuses bad usage with exit 2', async () => {
      const none = await cli(dir, ['search', 'xylophonezzz']);
      expect(none).toMatchObject({ code: EXIT_OK, stdout: '' });
      expect((await cli(dir, ['search'])).code).toBe(EXIT_USAGE);
      expect((await cli(dir, ['search', 'x', '--mode', 'warm'])).code).toBe(EXIT_USAGE);
      expect((await cli(dir, ['search', 'x', '--limit', 'ten'])).code).toBe(EXIT_USAGE);
      expect((await cli(dir, ['search', 'x', '--since', 'yesterday'])).code).toBe(EXIT_USAGE);
    });

    it('filters dated entries by date', async () => {
      const r = await json<{ results: { date: string | null; role: string }[] }>(dir, [
        'search',
        brain.topics[0]?.name as string,
        '--since',
        '2025-02-01',
        '--until',
        '2025-03-31',
      ]);
      for (const x of r.results) {
        expect(x.role).toBe('dated');
        expect(x.date! >= '2025-02-01' && x.date! <= '2025-03-31').toBe(true);
      }
    });

    it('never changes the event log or the scores', async () => {
      const events = await eventCounts(dir);
      const scores = await scoresOf(dir);
      for (const mode of ['hot', 'trending', 'neglected', 'all']) {
        await cli(dir, ['search', brain.topics[2]?.name as string, '--mode', mode]);
        await cli(dir, [mode === 'all' ? 'hot' : mode]);
      }
      expect(await eventCounts(dir)).toEqual(events);
      expectScoresClose(await scoresOf(dir), scores);
    });
  });

  describe('hot, trending, neglected', () => {
    it.each(['hot', 'trending', 'neglected'])(
      '%s prints path, title and activity',
      async (mode) => {
        const r = await cli(dir, [mode]);
        expect(r.code).toBe(EXIT_OK);
        const lines = r.stdout.trimEnd().split('\n');
        expect(lines.length).toBeGreaterThan(0);
        const indicator = {
          hot: / {2}week \S+$/,
          trending: / {2}pace \S+x$/,
          neglected: / {2}year \S+ month \S+$/,
        }[mode as 'hot'];
        for (const line of lines) {
          expect(line).toMatch(indicator);
          if (line.startsWith('(not written yet) ')) continue;
          const path = line.split('  ')[0] as string;
          expect(path.startsWith('memos/'), line).toBe(true);
        }
      },
    );

    it('marks dangling links as not written yet', async () => {
      const list = await json<{
        results: { dangling: boolean; item: string; role: string | null }[];
      }>(dir, ['hot', '--limit', '200']);
      const dangling = list.results.filter((r) => r.dangling);
      expect(dangling.length).toBeGreaterThan(0);
      for (const r of list.results) expect(r.dangling || r.role === 'memo').toBe(true);
      const text = (await cli(dir, ['hot', '--limit', '200'])).stdout;
      for (const d of dangling) expect(text).toContain(`(not written yet) ${d.item}  week `);
    });

    it('takes --limit and refuses words', async () => {
      expect((await cli(dir, ['hot', '-n', '3'])).stdout.trimEnd().split('\n')).toHaveLength(3);
      expect((await cli(dir, ['hot', '--limit', '0'])).stdout).toBe('');
      expect((await cli(dir, ['trending', 'quince'])).code).toBe(EXIT_USAGE);
    });
  });

  describe('log', () => {
    type Change = { time: number; op: string | null; message: string | null; paths: string[] };
    const changes = async (args: string[]) =>
      (await json<{ changes: Change[] }>(dir, ['log', ...args])).changes;

    it('lists change records newest first with time, op, subject and paths', async () => {
      const r = await cli(dir, ['log', '-n', '5']);
      expect(r.code).toBe(EXIT_OK);
      const heads = r.stdout.split('\n').filter((l) => l !== '' && !l.startsWith('  '));
      expect(heads).toHaveLength(5);
      for (const h of heads) expect(h).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} {2}\S+ {2}\S/);
      const records = await changes(['-n', '5']);
      expect(heads[0]?.startsWith(formatLocalTime(records[0]?.time as number))).toBe(true);
      const times = records.map((c) => c.time);
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });

    it('filters by path, op, time and dated-only changes', async () => {
      const all = await changes(['--all', '--limit', '0']);
      const shown = await changes(['--limit', '0']);
      const datedOnly = all.filter((c) => c.paths.every((p) => p.startsWith('diary/')));
      expect(datedOnly.length).toBeGreaterThan(0);
      expect(shown.length).toBe(all.length - datedOnly.length);

      const path = brain.notes.find((n) => n.role === 'memo' && n.writes > 2)?.path as string;
      const history = await changes([path, '--limit', '0']);
      expect(history.length).toBeGreaterThan(1);
      for (const c of history) expect(c.paths).toContain(path);

      const ingest = await changes(['--op', 'ingest', '--limit', '0']);
      expect(ingest.length).toBeGreaterThan(0);
      for (const c of ingest) expect(c.op).toBe('ingest');

      const mid = all[Math.floor(all.length / 2)]?.time as number;
      const since = await changes(['--all', '--since', `@${mid}`, '--limit', '0']);
      expect(since.every((c) => c.time >= mid)).toBe(true);
      const until = await changes(['--all', '--until', `@${mid}`, '--limit', '0']);
      expect(until.every((c) => c.time <= mid)).toBe(true);
      expect(since.length + until.length).toBeGreaterThanOrEqual(all.length);
      expect((await cli(dir, ['log', '--since', 'soon'])).code).toBe(EXIT_USAGE);
    });

    it('summarizes changes with many paths', async () => {
      const wide = (await changes(['--all', '--limit', '0'])).find((c) => c.paths.length > 5);
      if (!wide) return; // the synthetic history may have none; the format is tested below
      const r = await cli(dir, ['log', '--all', '--limit', '0']);
      expect(r.stdout).toContain(`  … and ${wide.paths.length - 4} more`);
    });
  });
});

describe('read', () => {
  let tmp: ReturnType<typeof tempDir>;
  let dir: string;
  beforeEach(async () => {
    tmp = tempDir();
    dir = tmp.dir;
    writeTestConfig(dir, { roles: ROLES });
    writeNote(dir, 'memos/kiln.md', '# Kiln\r\n\r\nCone six, no trailing newline', NOW - 100);
    writeNote(dir, 'diary/2025/10/2025-10-08.md', '# 2025-10-08\n\nFired the kiln.\n', NOW - 100);
    writeNote(
      dir,
      'blog/2025/2025-10-01-glazes.md',
      '---\npublished: true\n---\n# Glazes\n',
      NOW - 100,
    );
    writeNote(dir, `${EXCLUDED_FOLDER}/secret.md`, '# Secret\n\nhidden words\n', NOW - 100);
    expect((await cli(dir, ['index'])).code).toBe(EXIT_OK);
  });
  afterEach(() => tmp.remove());

  it('prints the note byte for byte and logs exactly one read for a memo', async () => {
    const r = await cli(dir, ['read', 'memos/kiln.md']);
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toBe(readFileSync(join(dir, 'memos/kiln.md'), 'utf8'));
    expect((await eventCounts(dir)).read).toBe(1);
    const hot = await json<{ results: { item: string }[] }>(dir, ['hot']);
    expect(hot.results.map((x) => x.item)).toEqual(['memos/kiln.md']);
  });

  it('logs nothing for a dated entry or with --no-record', async () => {
    const diary = await cli(dir, ['read', 'diary/2025/10/2025-10-08.md']);
    expect(diary.stdout).toBe('# 2025-10-08\n\nFired the kiln.\n');
    const quiet = await cli(dir, ['read', '--no-record', 'memos/kiln.md']);
    expect(quiet.code).toBe(EXIT_OK);
    expect((await eventCounts(dir)).read).toBe(0);
  });

  it('logs a read for a blog post and shows its publish state with --json', async () => {
    const note = await json<Record<string, unknown>>(dir, [
      'read',
      'blog/2025/2025-10-01-glazes.md',
    ]);
    expect(note).toMatchObject({
      path: 'blog/2025/2025-10-01-glazes.md',
      role: 'blog',
      date: '2025-10-01',
      published: true,
      recorded: true,
      title: 'Glazes',
    });
    expect(Object.keys(note)).toEqual(
      expect.arrayContaining(['text', 'hash', 'mtime', 'sections', 'links', 'backlinks']),
    );
    expect((await eventCounts(dir)).read).toBe(1);
  });

  it('accepts paths relative to the working directory or the brain root', async () => {
    const sub = join(dir, 'memos');
    expect((await cli(sub, ['read', 'kiln.md', '--no-record'])).code).toBe(EXIT_OK);
    expect((await cli(sub, ['read', 'memos/kiln.md', '--no-record'])).code).toBe(EXIT_OK);
  });

  it('refuses excluded and missing notes with one line, never the content', async () => {
    const secret = await cli(dir, ['read', `${EXCLUDED_FOLDER}/secret.md`]);
    expect(secret.code).toBe(EXIT_FAILURE);
    expect(secret.stdout).toBe('');
    expect(secret.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(secret.stderr).not.toContain('hidden');
    expect(secret.stderr).not.toContain('secret');
    const missing = await cli(dir, ['read', 'memos/none.md']);
    expect(missing.code).toBe(EXIT_FAILURE);
    expect(missing.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect((await cli(dir, ['read'])).code).toBe(EXIT_USAGE);
    expect((await cli(dir, ['read', '../outside.md'])).code).toBe(EXIT_USAGE);
    expect((await eventCounts(dir)).read).toBe(0);
  });
});

describe('log text', () => {
  it('shows op, subject without the op word, and summarizes many paths', async () => {
    const tmp = tempDir();
    try {
      const dir = tmp.dir;
      writeTestConfig(dir, { roles: ROLES });
      expect((await cli(dir, ['index'])).code).toBe(EXIT_OK);
      for (let i = 0; i < 7; i++) writeNote(dir, `memos/n${i}.md`, `# N${i}\n`, NOW - 5);
      await cli(dir, ['commit', '-m', 'ingest seven invented notes\n\nsecond paragraph']);
      writeNote(dir, 'memos/n0.md', '# N0\n\nmore\n', NOW - 1);
      await cli(dir, ['commit']);
      const r = await cli(dir, ['log']);
      const t = formatLocalTime(NOW);
      expect(r.stdout).toBe(
        [
          `${t}  -  (no message)`,
          '  memos/n0.md',
          `${t}  ingest  seven invented notes`,
          '  memos/n0.md',
          '  memos/n1.md',
          '  memos/n2.md',
          '  memos/n3.md',
          '  … and 3 more',
          '',
        ].join('\n'),
      );
      expect((await cli(dir, ['log', 'memos/n5.md'])).stdout.split('\n')[0]).toContain('ingest');
    } finally {
      tmp.remove();
    }
  });
});

describe('export and import-log', () => {
  let tmp: ReturnType<typeof tempDir>;
  beforeEach(() => {
    tmp = tempDir();
  });
  afterEach(() => tmp.remove());

  it('round-trips into an empty brain with the same scores, idempotently', async () => {
    const a = join(tmp.dir, 'a');
    await historyBrain(a, 5);
    writeNote(a, 'memos/extra.md', '# Extra\n', NOW - 5);
    await cli(a, ['commit', '-m', 'update add an extra note']);
    await cli(a, ['read', 'memos/extra.md']);

    const out = await cli(a, ['export']);
    expect(out.code).toBe(EXIT_OK);
    const lines = out.stdout
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; time: number });
    expect(lines.some((l) => l.type === 'change')).toBe(true);
    const times = lines.map((l) => l.time);
    expect([...times].sort((x, y) => x - y)).toEqual(times);

    const file = join(tmp.dir, 'events.jsonl');
    const written = await json<{ output: string; records: number }>(a, ['export', '-o', file]);
    expect(written).toMatchObject({ output: file, records: lines.length });
    expect(readFileSync(file, 'utf8')).toBe(out.stdout);

    const b = join(tmp.dir, 'b');
    mkdirSync(b);
    writeTestConfig(b, { roles: ROLES });
    const first = await cli(b, ['import-log', file]);
    expect(first.code, first.stderr).toBe(EXIT_OK);
    expect(first.stdout).toMatch(/^imported \d+ log entries and \d+ change records; skipped 0/);
    expectScoresClose(await scoresOf(b), await scoresOf(a));
    expect((await json<{ changes: number }>(b, ['status'])).changes).toBe(
      (await json<{ changes: number }>(a, ['status'])).changes,
    );

    const again = await json<{ log: { appended: number }; changes: { appended: number } }>(b, [
      'import-log',
      file,
    ]);
    expect(again.log.appended).toBe(0);
    expect(again.changes.appended).toBe(0);
    expectScoresClose(await scoresOf(b), await scoresOf(a));
  }, 60_000);

  it('refuses to write an export inside a somememos source checkout', async () => {
    const checkout = join(tmp.dir, 'checkout');
    mkdirSync(join(checkout, 'brain'), { recursive: true });
    writeFileSync(join(checkout, 'package.json'), '{"name": "somememos"}\n');
    const dir = join(checkout, 'brain');
    writeTestConfig(dir, { roles: ROLES });
    const r = await cli(dir, ['export', '--output', 'events.jsonl']);
    expect(r.code).toBe(EXIT_FAILURE);
    expect(r.stderr).toContain('source checkout');
    expect(existsSync(join(dir, 'events.jsonl'))).toBe(false);
  });

  it('reports a bad export line and a missing file with exit 1', async () => {
    const dir = tmp.dir;
    writeTestConfig(dir, { roles: ROLES });
    writeFileSync(join(dir, 'bad.jsonl'), '{"type":"log"\n');
    expect((await cli(dir, ['import-log', 'bad.jsonl'])).code).toBe(EXIT_FAILURE);
    expect((await cli(dir, ['import-log', 'missing.jsonl'])).code).toBe(EXIT_FAILURE);
    expect((await cli(dir, ['import-log'])).code).toBe(EXIT_USAGE);
  });
});

describe('help agents', () => {
  it('prints the short agent guide', async () => {
    const r = await cli('/nonexistent', ['help', 'agents']);
    expect(r.code).toBe(EXIT_OK);
    for (const word of [
      'somememos hot',
      'somememos search',
      'somememos read',
      'somememos commit -m',
    ]) {
      expect(r.stdout).toContain(word);
    }
    expect(r.stdout.trimEnd().split('\n').length).toBeLessThanOrEqual(25);
  });
});
