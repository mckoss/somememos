import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  EXCLUDED_FOLDER,
  TEST_AUTHOR,
  generateBrain,
  git,
  materializeBrain,
  materializeGitHistory,
} from './index.js';

// Writing the synthetic brain to disk and to git. The generator itself is
// tested in core (packages/core/src/testing/brain.test.ts).

const brain = generateBrain();
const root = mkdtempSync(join(tmpdir(), 'somememos-brain-'));
let counter = 0;
const freshDir = () => join(root, `b${counter++}`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    if (name === '.git') continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(join(dir, rel)).isDirectory()) out.push(...listFiles(dir, rel));
    else out.push(rel);
  }
  return out;
}

function hashTree(dir: string): string {
  const hash = createHash('sha256');
  for (const path of listFiles(dir))
    hash
      .update(path)
      .update('\0')
      .update(readFileSync(join(dir, path)));
  return hash.digest('hex');
}

describe('materializeBrain', () => {
  it('writes the final files, byte-identical for the same seed', () => {
    const a = freshDir();
    const b = freshDir();
    const written = materializeBrain(a, brain);
    materializeBrain(b, generateBrain({ seed: 1 }));
    expect(written).toEqual(Object.keys(brain.files));
    expect(listFiles(a)).toEqual(Object.keys(brain.files));
    expect(hashTree(a)).toBe(hashTree(b));
    for (const path of written) expect(readFileSync(join(a, path), 'utf8')).toBe(brain.files[path]);
    expect(readdirSync(join(a, EXCLUDED_FOLDER)).length).toBeGreaterThan(0);
  });

  it('can write the state after an earlier step, and refuses a non-empty directory', () => {
    const dir = freshDir();
    const upTo = brain.features.renamed.step - 1;
    materializeBrain(dir, brain.steps, { upTo });
    expect(listFiles(dir)).toContain(brain.features.renamed.from);
    expect(listFiles(dir)).not.toContain(brain.features.renamed.to);
    expect(() => materializeBrain(dir, brain)).toThrow(/not an empty directory/);
  });
});

describe('materializeGitHistory', () => {
  const dir = freshDir();
  let hashes: string[] = [];

  // No wall-clock bound here: on a loaded machine any bound fails from timing
  // alone. It is fast by construction (one fast-import stream, a handful of
  // git processes in all), and the duration is printed for a human to see.
  it('builds one commit per step and checks out the last', () => {
    const t0 = performance.now();
    hashes = materializeGitHistory(dir, brain);
    console.info(
      `git history: ${hashes.length} commits in ${Math.round(performance.now() - t0)} ms`,
    );
    expect(hashes).toHaveLength(brain.steps.length);
    expect(git(dir, ['status', '--porcelain'])).toBe('');
    expect(listFiles(dir)).toEqual(Object.keys(brain.files));
  });

  it('uses the step times, messages and a fixed identity', () => {
    const log = git(dir, ['log', '--reverse', '--format=%at|%ct|%an <%ae>|%cn <%ce>|%s'])
      .trim()
      .split('\n');
    expect(log).toHaveLength(brain.steps.length);
    const identity = `${TEST_AUTHOR.name} <${TEST_AUTHOR.email}>`;
    log.forEach((line, i) => {
      const step = brain.steps[i]!;
      expect(line).toBe(`${step.time}|${step.time}|${identity}|${identity}|${step.message}`);
    });
  });

  it('reports the renames with git log --name-status -M', () => {
    const out = git(dir, ['log', '--reverse', '--format=@%H', '--name-status', '-M']);
    const renames = [...out.matchAll(/^R(\d+)\t(\S+)\t(\S+)$/gm)].map((m) => ({
      score: Number(m[1]),
      from: m[2],
      to: m[3],
    }));
    const expected = brain.steps.flatMap((s) => s.truth.renamed);
    expect(renames.map(({ from, to }) => ({ from, to }))).toEqual(expected);
    for (const r of renames) expect(r.score).toBe(100);
    const deletes = [...out.matchAll(/^D\t(\S+)$/gm)].map((m) => m[1]);
    expect(deletes).toEqual(brain.steps.flatMap((s) => s.truth.deleted));
  });

  it('gives the same commit hashes for the same seed', () => {
    const again = materializeGitHistory(freshDir(), generateBrain({ seed: 1 }));
    expect(again).toEqual(hashes);
  });
});
