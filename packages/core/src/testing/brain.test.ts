// The synthetic brain generator: determinism and the ground truth it promises.
// Pure; writing it to disk is tested beside materialize.ts in the CLI.

import { describe, expect, it } from 'vitest';
import { EXCLUDED_FOLDER, diaryPath, filesAfter, generateBrain, roleOf } from './index.js';
import type { SyntheticBrain } from './index.js';

/** A deliberately naive wiki-link parser that skips fenced code, for checking the ground truth. */
function parseLinks(markdown: string): string[] {
  const links: string[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    else if (!inFence) for (const m of line.matchAll(/\[\[[^\]]+\]\]/g)) links.push(m[0]);
  }
  return links;
}

function parseHeadings(markdown: string): string[] {
  const headings: string[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    else if (!inFence && line.startsWith('## ')) headings.push(line.slice(3));
  }
  return headings;
}

const brain: SyntheticBrain = generateBrain();

describe('generateBrain', () => {
  it('is deterministic for a seed, and differs between seeds', () => {
    expect(JSON.stringify(generateBrain())).toBe(JSON.stringify(brain));
    expect(JSON.stringify(generateBrain({ seed: 1 }))).toBe(JSON.stringify(brain));
    expect(JSON.stringify(generateBrain({ seed: 2 }).files)).not.toBe(JSON.stringify(brain.files));
  });

  it('has the requested number of steps, in strictly increasing time within the span', () => {
    const { steps, options } = brain;
    expect(steps).toHaveLength(options.steps);
    for (let i = 1; i < steps.length; i++)
      expect(steps[i]!.time).toBeGreaterThan(steps[i - 1]!.time);
    expect(steps[0]!.time).toBeGreaterThanOrEqual(options.start);
    expect(steps.at(-1)!.time).toBeLessThanOrEqual(options.start + options.days * 86_400);
  });

  it('writes messages as <op> <summary>', () => {
    for (const step of brain.steps) expect(step.message).toMatch(/^(ingest|update|session) \S.*$/);
    const ops = new Set(brain.steps.map((s) => s.op));
    expect([...ops].sort()).toEqual(['ingest', 'session', 'update']);
  });

  it('uses the memos / diary / sources / excluded layout', () => {
    const paths = Object.keys(brain.files);
    const roles = new Set(paths.map(roleOf));
    expect([...roles].sort()).toEqual(['dated', 'excluded', 'memo', 'source']);
    for (const p of paths) {
      if (roleOf(p) === 'dated') expect(p).toMatch(/^diary\/(\d{4})\/(\d{2})\/\1-\2-\d{2}\.md$/);
      if (roleOf(p) === 'memo') expect(p).toMatch(/^memos\/[a-z]+\/[a-z0-9-]+\.md$/);
      if (roleOf(p) === 'excluded') expect(p.startsWith(`${EXCLUDED_FOLDER}/`)).toBe(true);
    }
    expect(paths.filter((p) => roleOf(p) === 'excluded').length).toBeGreaterThan(0);
    expect(diaryPath(Date.UTC(2025, 2, 9, 23, 59) / 1000)).toBe('diary/2025/03/2025-03-09.md');
  });

  it('never edits a source after creating it', () => {
    const seen = new Set<string>();
    for (const step of brain.steps) {
      for (const path of step.truth.edited) expect(roleOf(path)).not.toBe('source');
      for (const path of step.truth.created) if (roleOf(path) === 'source') seen.add(path);
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('the ground truth matches the files', () => {
    const files = filesAfter(brain.steps);
    expect(Object.fromEntries([...files].sort(([a], [b]) => (a < b ? -1 : 1)))).toEqual(
      brain.files,
    );
    expect(brain.notes.map((n) => n.path)).toEqual(Object.keys(brain.files));
    for (const note of brain.notes) {
      const content = brain.files[note.path]!;
      expect(parseLinks(content)).toEqual(note.links.map((l) => l.raw));
      expect(parseHeadings(content)).toEqual(note.headings);
      if (note.frontMatterTitle !== undefined) {
        expect(content.startsWith(`---\ntitle: ${note.frontMatterTitle}\n`)).toBe(true);
      } else {
        expect(content.startsWith('---')).toBe(false);
      }
    }
  });

  it('records created, edited, renamed and deleted files and added links per step', () => {
    const exists = new Set<string>();
    for (const step of brain.steps) {
      const before = filesAfter(brain.steps, step.index - 1);
      const after = filesAfter(brain.steps, step.index);
      for (const { from, to } of step.truth.renamed) {
        expect(before.has(from) && !after.has(from) && after.get(to) === before.get(from)).toBe(
          true,
        );
        exists.delete(from);
        exists.add(to);
      }
      for (const path of step.truth.deleted)
        expect(before.has(path) && !after.has(path)).toBe(true);
      for (const path of step.truth.created) {
        expect(exists.has(path)).toBe(false);
        expect(after.has(path)).toBe(true);
        exists.add(path);
      }
      for (const path of step.truth.edited) expect(after.get(path)).not.toBe(before.get(path));
      for (const path of step.truth.deleted) exists.delete(path);
      // Links added: the multiset difference of parsed links in each written file.
      const expected: string[] = [];
      for (const path of [...step.truth.created, ...step.truth.edited]) {
        const old = parseLinks(before.get(path) ?? '');
        for (const raw of parseLinks(after.get(path)!)) {
          const i = old.indexOf(raw);
          if (i >= 0) old.splice(i, 1);
          else expected.push(`${path} ${raw}`);
        }
      }
      expect(step.truth.linksAdded.map((l) => `${l.source} ${l.raw}`).sort()).toEqual(
        expected.sort(),
      );
      for (const link of step.truth.linksAdded) {
        if (link.resolvedPath) expect(after.has(link.resolvedPath)).toBe(true);
      }
    }
    expect([...exists].sort()).toEqual(Object.keys(brain.files));
  });

  it('has links in every form, including dangling ones', () => {
    const links = brain.steps.flatMap((s) => s.truth.linksAdded);
    expect(links.some((l) => !l.target.includes('/') && !l.alias && !l.heading)).toBe(true); // bare
    expect(links.some((l) => l.target.startsWith('memos/'))).toBe(true); // full path
    expect(links.some((l) => l.target.startsWith('sources/'))).toBe(true);
    expect(links.some((l) => l.alias)).toBe(true);
    expect(links.some((l) => l.heading)).toBe(true);
    expect(links.some((l) => l.resolvedPath === null)).toBe(true);
  });

  it('has a link that dangles until its note is created later', () => {
    const { target, path, linkedAt, createdAt } = brain.features.danglingThenCreated;
    expect(createdAt).toBeGreaterThan(linkedAt);
    const early = brain.steps[linkedAt]!.truth.linksAdded.find((l) => l.target === target)!;
    expect(early.resolvedPath).toBeNull();
    expect(brain.steps[createdAt]!.truth.created).toContain(path);
    const final = brain.notes.flatMap((n) => n.links).filter((l) => l.target === target);
    expect(final.length).toBeGreaterThan(0);
    for (const link of final) expect(link.resolvedPath).toBe(path);
  });

  it('renames a note after other notes linked to it', () => {
    const { from, to, step } = brain.features.renamed;
    const oldName = from.slice(from.lastIndexOf('/') + 1, -3);
    const earlier = brain.steps.slice(0, step).flatMap((s) => s.truth.linksAdded);
    const linkers = new Set(earlier.filter((l) => l.resolvedPath === from).map((l) => l.source));
    expect(linkers.size).toBeGreaterThanOrEqual(2);
    expect(brain.steps[step]!.truth.renamed).toEqual([{ from, to }]);
    // The old links now dangle.
    const stale = brain.notes.flatMap((n) => n.links).filter((l) => l.target === oldName);
    expect(stale.length).toBeGreaterThan(0);
    for (const link of stale) expect(link.resolvedPath).toBeNull();
  });

  it('has code fences containing ## and [[ that are not headings or links', () => {
    const fenced = Object.entries(brain.files).filter(([, c]) =>
      /```[\s\S]*?## [\s\S]*?\[\[[\s\S]*?```/.test(c),
    );
    expect(fenced.length).toBeGreaterThan(0);
  });

  it('has notes edited many times, notes never touched again, and bursts of edits', () => {
    const memos = brain.notes.filter((n) => n.role === 'memo');
    expect(Math.max(...memos.map((n) => n.writes))).toBeGreaterThanOrEqual(5);
    expect(memos.some((n) => n.writes === 1)).toBe(true);
    expect(brain.features.bursts.length).toBeGreaterThan(0);
    for (const burst of brain.features.bursts) {
      expect(burst.steps.length).toBeGreaterThanOrEqual(3);
      const times = burst.steps.map((i) => brain.steps[i]!.time);
      expect(times.at(-1)! - times[0]!).toBeLessThan(30 * 60);
      for (const i of burst.steps) {
        const step = brain.steps[i]!;
        expect([...step.truth.created, ...step.truth.edited]).toContain(burst.path);
      }
    }
  });

  it('shifts activity between topics: quiet, steady, hot and heating up', () => {
    const { start, days } = brain.options;
    const span = days * 86_400;
    const activity = (topic: string, from: number, to: number) =>
      brain.steps
        .filter((s) => s.time >= start + from * span && s.time < start + to * span)
        .flatMap((s) => [
          ...s.truth.created,
          ...s.truth.edited,
          ...s.truth.linksAdded.map((l) => l.resolvedPath ?? ''),
        ])
        .filter((p) => p.startsWith(`memos/${topic}/`)).length;
    const phases = new Set(brain.topics.map((t) => t.phase));
    expect([...phases].sort()).toEqual(['heating', 'hot', 'quiet', 'steady']);
    for (const topic of brain.topics) {
      const early = activity(topic.name, 0, 0.45);
      const late = activity(topic.name, 0.75, 1.01);
      if (topic.phase === 'quiet') {
        expect(early).toBeGreaterThan(0);
        expect(activity(topic.name, 0.5, 1.01)).toBe(0);
      }
      if (topic.phase === 'hot') expect(late).toBeGreaterThan(0);
      if (topic.phase === 'heating') expect(late).toBeGreaterThan(early);
    }
  });

  it('has every feature for many seeds', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const b = generateBrain({ seed });
      const memos = b.notes.filter((n) => n.role === 'memo');
      const { renamed, danglingThenCreated, deleted, bursts } = b.features;
      const context = `seed ${seed}`;
      expect(
        memos.some((n) => n.writes === 1),
        context,
      ).toBe(true);
      expect(Math.max(...memos.map((n) => n.writes)), context).toBeGreaterThanOrEqual(4);
      expect(deleted, context).not.toBeNull();
      expect(bursts.length, context).toBeGreaterThan(0);
      expect(danglingThenCreated.createdAt, context).toBeGreaterThan(danglingThenCreated.linkedAt);
      const linkers = b.steps
        .slice(0, renamed.step)
        .flatMap((s) => s.truth.linksAdded)
        .filter((l) => l.resolvedPath === renamed.from)
        .map((l) => l.source);
      expect(new Set(linkers).size, context).toBeGreaterThanOrEqual(2);
      for (const note of b.notes) {
        expect(parseLinks(b.files[note.path]!), context).toEqual(note.links.map((l) => l.raw));
      }
    }
  });

  it('scales to larger sizes', () => {
    const big = generateBrain({ seed: 7, steps: 1500, topics: 8, days: 730 });
    expect(big.steps).toHaveLength(1500);
    expect(Object.keys(big.files).length).toBeGreaterThan(200);
  });

  it('rejects sizes it cannot build', () => {
    expect(() => generateBrain({ steps: 5 })).toThrow(RangeError);
    expect(() => generateBrain({ topics: 2 })).toThrow(RangeError);
  });
});
