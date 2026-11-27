// `somememos eval` on temp brains with invented git history: the aggregate
// table, determinism, privacy of the default output, the source-checkout
// guard, hand-written cases, and the as-of-parent index of git cases.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { markdown } from '@somememos/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeContext, tempDir, writeTestConfig } from '../../brain/testing.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, run } from '../../index.js';
import {
  EXCLUDED_FOLDER,
  type SyntheticBrain,
  filesAfter,
  generateBrain,
  git,
  materializeGitHistory,
} from '../../testing/index.js';
import { findSourceCheckout } from '../privacy.js';
import { GitSnapshots, buildGitCases } from './git-cases.js';
import { parseGrid } from './settings.js';

const NOW = 1_760_000_000;
const ROLES = {
  memo: ['memos/'],
  dated: ['diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md'],
  source: ['sources/'],
  excluded: [`${EXCLUDED_FOLDER}/`],
};

async function cli(dir: string, args: string[]) {
  const io = fakeContext({ cwd: dir, now: NOW });
  const code = await run(args, io.ctx);
  return { code, stdout: io.stdout(), stderr: io.stderr() };
}

async function historyBrain(dir: string, seed = 3): Promise<SyntheticBrain> {
  const brain = generateBrain({ seed });
  materializeGitHistory(dir, brain);
  writeTestConfig(dir, { roles: ROLES });
  expect((await cli(dir, ['index'])).code).toBe(EXIT_OK);
  expect((await cli(dir, ['import-git'])).code).toBe(EXIT_OK);
  return brain;
}

/** Every string from the brain that the default output must never contain. */
function privateStrings(brain: SyntheticBrain): string[] {
  const out = new Set<string>();
  const paths = new Set<string>();
  for (const step of brain.steps) {
    out.add(step.message);
    for (const c of step.changes) {
      if (c.type === 'rename') paths.add(c.from).add(c.to);
      else paths.add(c.path);
    }
  }
  for (const p of paths) {
    out.add(p);
    out.add(markdown.stripMd(markdown.baseName(p)));
  }
  for (const n of brain.notes) if (n.frontMatterTitle) out.add(n.frontMatterTitle);
  // Too short to mean anything on their own (and they occur in the table's own words).
  return [...out].filter((s) => s.length >= 8);
}

// Each `eval --from-git` run rebuilds the index as of every sampled commit's
// parent: under a second on an idle machine, but CPU-bound, so a loaded
// machine (several times oversubscribed) pushed it past the default 5 s.
describe('eval on a brain with imported history', { timeout: 30_000 }, () => {
  let tmp: ReturnType<typeof tempDir>;
  let dir: string;
  let brain: SyntheticBrain;
  beforeAll(async () => {
    tmp = tempDir();
    dir = join(tmp.dir, 'brain');
    brain = await historyBrain(dir);
  }, 60_000);
  afterAll(() => tmp.remove());

  it('prints the aggregate table for the baseline preset', async () => {
    const r = await cli(dir, ['eval']);
    expect(r.code, r.stderr).toBe(EXIT_OK);
    const lines = r.stdout.split('\n');
    expect(lines[0]).toMatch(/^cases: \d+ orientation .*; 2 settings; seed 1$/);
    expect(r.stdout).toContain('orientation cases\nsetting ');
    expect(r.stdout).toMatch(/\nmode=all +(?:\d\.\d{3} +){5}\d+ +\d+\n/);
    expect(r.stdout).toMatch(/\nmode=hot +(?:\d\.\d{3} +){5}\d+ +\d+\n/);
  });

  it('is deterministic for a seed', async () => {
    const args = ['eval', '--from-git', '--samples', '15', '--seed', '9', '--preset', 'weights'];
    const a = await cli(dir, args);
    expect(a.code, a.stderr).toBe(EXIT_OK);
    expect((await cli(dir, args)).stdout).toBe(a.stdout);
    expect(a.stdout).toContain('search cases');
  });

  it('never prints a path, title or query by default, in text or JSON', async () => {
    const secrets = privateStrings(brain);
    expect(secrets.length).toBeGreaterThan(20);
    for (const args of [
      ['eval', '--from-git', '--samples', '20'],
      ['eval', '--from-git', '--samples', '20', '--json'],
      // Twenty cases are enough to check privacy; every case under two whole
      // presets took over five seconds on a loaded machine.
      [
        'eval',
        '--preset',
        'spreading',
        '--preset',
        'half-lives',
        '--from-git',
        '--samples',
        '20',
        '--json',
      ],
    ]) {
      const r = await cli(dir, args);
      expect(r.code, r.stderr).toBe(EXIT_OK);
      for (const s of secrets) {
        expect(r.stdout, s).not.toContain(s);
        expect(r.stderr, s).not.toContain(s);
      }
    }
  });

  it('gives aggregates and counts with --json', async () => {
    const r = await cli(dir, ['eval', '--from-git', '--samples', '10', '--json']);
    const record = JSON.parse(r.stdout) as {
      seed: number;
      cases: { orientation: number; git: number; hand: number; gitCommits: { eligible: number } };
      settings: string[];
      report: { ks: number[]; settings: { name: string; search: { cases: number } }[] };
      detailFile: null;
    };
    expect(record.seed).toBe(1);
    expect(record.cases.git).toBe(10);
    expect(record.cases.gitCommits.eligible).toBeGreaterThanOrEqual(10);
    expect(record.settings).toEqual(['mode=all', 'mode=hot']);
    expect(record.report.ks).toEqual([1, 5, 10, 20]);
    expect(record.report.settings[0]?.search.cases).toBe(10);
    expect(record.detailFile).toBeNull();
    expect(record.report).not.toHaveProperty('detail');
  });

  it('expands a grid and refuses unknown parameters and presets', async () => {
    const r = await cli(dir, ['eval', '--grid', 'alpha=0,1;fold.burst.window=0,600', '--json']);
    expect(r.code, r.stderr).toBe(EXIT_OK);
    expect((JSON.parse(r.stdout) as { settings: string[] }).settings).toEqual([
      'alpha=0,fold.burst.window=0',
      'alpha=0,fold.burst.window=600',
      'alpha=1,fold.burst.window=0',
      'alpha=1,fold.burst.window=600',
    ]);
    expect((await cli(dir, ['eval', '--grid', 'alpah=1'])).code).toBe(EXIT_USAGE);
    expect((await cli(dir, ['eval', '--grid', 'weights.like=1'])).code).toBe(EXIT_USAGE);
    expect((await cli(dir, ['eval', '--grid', 'alpha=-1'])).code).toBe(EXIT_USAGE);
    expect((await cli(dir, ['eval', '--preset', 'nonsense'])).code).toBe(EXIT_USAGE);
    expect((await cli(dir, ['eval', '--window', 'soon'])).code).toBe(EXIT_USAGE);
  });

  it('writes per-case detail only inside the brain', async () => {
    const r = await cli(dir, ['eval', '--from-git', '--samples', '5', '--detail']);
    expect(r.code, r.stderr).toBe(EXIT_OK);
    const evalDir = join(dir, '.somememos', 'eval');
    const written = readdirSync(evalDir);
    expect(written).toEqual([`eval-${NOW}.json`]);
    const detail = JSON.parse(readFileSync(join(evalDir, written[0] as string), 'utf8')) as {
      report: { detail: unknown[] };
    };
    expect(detail.report.detail.length).toBeGreaterThan(0);
    expect(r.stderr).toContain('per-case detail (private) written to');
    for (const s of privateStrings(brain)) expect(r.stdout).not.toContain(s);
  });
});

describe('eval privacy guard', () => {
  let tmp: ReturnType<typeof tempDir>;
  beforeEach(() => {
    tmp = tempDir();
  });
  afterEach(() => tmp.remove());

  it('finds a somememos checkout above a path, and nothing elsewhere', () => {
    const checkout = join(tmp.dir, 'repo');
    mkdirSync(join(checkout, 'packages', 'x'), { recursive: true });
    writeFileSync(join(checkout, 'package.json'), '{"name":"somememos","private":true}');
    writeFileSync(join(checkout, 'packages', 'x', 'package.json'), '{"name":"@somememos/x"}');
    expect(findSourceCheckout(join(checkout, 'packages', 'x', 'brain', '.somememos'))).toBe(
      checkout,
    );
    expect(findSourceCheckout(join(tmp.dir, 'elsewhere'))).toBeNull();
  });

  it('refuses --detail inside a source checkout and writes nothing', async () => {
    const checkout = join(tmp.dir, 'repo');
    const dir = join(checkout, 'examples', 'brain');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(checkout, 'package.json'), '{"name":"somememos"}');
    writeTestConfig(dir, { roles: ROLES });
    const r = await cli(dir, ['eval', '--detail']);
    expect(r.code).toBe(EXIT_FAILURE);
    expect(r.stderr).toContain('source checkout');
    expect(existsSync(join(dir, '.somememos', 'eval'))).toBe(false);
    // Without --detail, aggregates are fine anywhere.
    expect((await cli(dir, ['eval'])).code).toBe(EXIT_OK);
  });
});

describe('hand-written cases', () => {
  let tmp: ReturnType<typeof tempDir>;
  let dir: string;
  beforeAll(async () => {
    tmp = tempDir();
    dir = join(tmp.dir, 'brain');
    await historyBrain(dir, 4);
  }, 60_000);
  afterAll(() => tmp.remove());

  it('runs them against the current index', async () => {
    const files = [...filesAfter(generateBrain({ seed: 4 }).steps).keys()].filter((p) =>
      p.startsWith('memos/'),
    );
    const target = files[0] as string;
    const title = markdown.stripMd(markdown.baseName(target)).replace(/-/g, ' ');
    const cases = [
      { query: title, answers: [target] },
      { query: title, time: NOW - 86_400, answers: [target] },
      { query: 'nothing matches this zzqx', answers: ['memos/none.md'] },
    ];
    mkdirSync(join(dir, '.somememos', 'eval'), { recursive: true });
    const file = join(dir, '.somememos', 'eval', 'cases.jsonl');
    writeFileSync(file, cases.map((c) => JSON.stringify(c)).join('\n') + '\n');
    const r = await cli(dir, ['eval', '--cases', file, '--no-orientation', '--json']);
    expect(r.code, r.stderr).toBe(EXIT_OK);
    const record = JSON.parse(r.stdout) as {
      cases: { hand: number; orientation: number };
      report: {
        settings: { name: string; search: { cases: number; recall: Record<string, number> } }[];
      };
    };
    expect(record.cases).toMatchObject({ hand: 3, orientation: 0 });
    const all = record.report.settings.find((s) => s.name === 'mode=all');
    expect(all?.search.cases).toBe(3);
    // The title query finds its note in both cases; the last case finds nothing.
    expect(all?.search.recall['20']).toBeCloseTo(2 / 3, 6);
    const text = await cli(dir, ['eval', '--cases', file, '--no-orientation']);
    expect(text.stdout).not.toContain(target);
    expect(text.stdout).not.toContain(title);
  });

  it('reports a bad line by number only', async () => {
    const file = join(tmp.dir, 'bad.jsonl');
    writeFileSync(file, '{"query":"private words","answers":"memos/x.md"}\n');
    const r = await cli(dir, ['eval', '--cases', file]);
    expect(r.code).toBe(EXIT_FAILURE);
    expect(r.stderr).toContain('line 1');
    expect(r.stderr).not.toContain('private words');
  });
});

describe('search cases from git history', () => {
  let tmp: ReturnType<typeof tempDir>;
  let dir: string;
  let parent: string;
  let commit: string;
  const T0 = 1_750_000_000;

  beforeAll(async () => {
    tmp = tempDir();
    dir = join(tmp.dir, 'brain');
    mkdirSync(join(dir, 'memos'), { recursive: true });
    git(dir, ['init', '--quiet', '--initial-branch=main']);
    const write = (path: string, text: string) => writeFileSync(join(dir, path), text);
    write('memos/airship.md', '# Airship\n\nNotes about envelopes and ballast.\n');
    write('memos/canal.md', '# Canal\n\nLocks and towpaths, see [[airship]].\n');
    git(dir, ['add', '--all']);
    git(dir, ['commit', '--quiet', '-m', 'ingest first notes'], T0);
    // The sampled commit plants a term that only exists from this commit on.
    write(
      'memos/airship.md',
      '# Airship\n\nNotes about envelopes and ballast.\n\nZeppelinar mooring.\n',
    );
    git(dir, ['add', '--all']);
    git(dir, ['commit', '--quiet', '-m', 'update zeppelinar mooring'], T0 + 3600);
    // A later commit adds the term to another note too.
    write('memos/canal.md', '# Canal\n\nLocks and towpaths, see [[airship]]. Zeppelinar.\n');
    git(dir, ['add', '--all']);
    git(dir, ['commit', '--quiet', '-m', 'session canal'], T0 + 7200);
    const hashes = git(dir, ['rev-list', '--reverse', 'HEAD']).trim().split('\n');
    [parent, commit] = hashes as [string, string];
    writeTestConfig(dir, { roles: ROLES });
    expect((await cli(dir, ['index'])).code).toBe(EXIT_OK);
    expect((await cli(dir, ['import-git'])).code).toBe(EXIT_OK);
  }, 60_000);
  afterAll(() => tmp.remove());

  it('takes the commit message as the query and the modified notes as answers', async () => {
    const classifier = markdown.createRoleClassifier(ROLES);
    const { cases, commits } = await buildGitCases({
      brainDir: dir,
      classifier,
      samples: 10,
      seed: 1,
    });
    expect(commits).toEqual({ read: 3, eligible: 2 });
    expect(cases.map((c) => [c.query, c.answers, c.parent])).toEqual([
      ['update zeppelinar mooring', ['memos/airship.md'], parent],
      ['session canal', ['memos/canal.md'], commit],
    ]);
    expect(cases[0]?.time).toBe(T0 + 3600);
  });

  it('builds the index as of the parent, so later text cannot leak the answer', async () => {
    const classifier = markdown.createRoleClassifier(ROLES);
    const snapshots = new GitSnapshots(dir, classifier, { stem: true });
    try {
      const before = await snapshots.at(parent);
      expect(before.index.search('zeppelinar')).toEqual([]);
      expect(before.index.search('ballast').map((h) => h.id)).toEqual(['memos/airship.md#0']);
      expect([...before.notes.keys()]).toEqual(['memos/airship.md', 'memos/canal.md']);
      expect(before.links().outgoing('memos/canal.md')).toEqual(['memos/airship.md']);
      const after = await snapshots.at(commit);
      expect(after.index.search('zeppelinar').map((h) => h.id)).toEqual(['memos/airship.md#0']);
    } finally {
      snapshots.close();
    }
    // Through the command, keyword only: as of its parent, the first case's
    // query matches nothing (reciprocal rank 0; with the current index it
    // would find the note), and the second finds its note by title (1).
    const r = await cli(dir, [
      'eval',
      '--from-git',
      '--no-orientation',
      '--grid',
      'mode=all',
      '--json',
    ]);
    expect(r.code, r.stderr).toBe(EXIT_OK);
    const record = JSON.parse(r.stdout) as {
      report: { settings: { search: { cases: number; mrr: number } }[] };
    };
    expect(record.report.settings[0]?.search).toMatchObject({ cases: 2, mrr: 0.5 });
  });

  it('parses grids into typed values', () => {
    expect(parseGrid('alpha=0,0.5;spreading.direction=off,both;mode=all')).toEqual({
      alpha: [0, 0.5],
      'spreading.direction': ['off', 'both'],
      mode: ['all'],
    });
  });
});
