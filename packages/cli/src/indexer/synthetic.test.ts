// Replays the synthetic brain (invented data with ground truth) one step at a
// time, running the index pass after each, and checks every logged event and
// rename record against what the step's truth implies.

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { markdown, storage } from '@somememos/core';
import { expectScoresClose } from '@somememos/core/testing/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempDir, writeTestConfig } from '../brain/testing.js';
import { type BrainStores, openBrainStores } from '../store/index.js';
import {
  EXCLUDED_FOLDER,
  type Step,
  type SyntheticBrain,
  filesAfter,
  generateBrain,
  materializeBrain,
  roleOf,
} from '../testing/index.js';
import { runIndexPass } from './pass.js';
import { readUncommitted } from './state.js';

const ROLES: markdown.FolderRolesConfig = {
  memo: ['memos/'],
  dated: ['diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md'],
  source: ['sources/'],
  excluded: [`${EXCLUDED_FOLDER}/`],
};

type Entry = { kind: string; item: string; to?: string; time: number };

function sortEntries(list: Entry[]): Entry[] {
  return [...list].sort((a, b) =>
    `${a.kind}\0${a.item}\0${a.to ?? ''}\0${a.time}` <
    `${b.kind}\0${b.item}\0${b.to ?? ''}\0${b.time}`
      ? -1
      : 1,
  );
}

function applyStep(dir: string, step: Step): void {
  for (const change of step.changes) {
    if (change.type === 'write') {
      const full = join(dir, change.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, change.content);
      utimesSync(full, step.time, step.time);
    } else if (change.type === 'delete') {
      rmSync(join(dir, change.path));
    } else {
      mkdirSync(dirname(join(dir, change.to)), { recursive: true });
      renameSync(join(dir, change.from), join(dir, change.to));
    }
  }
}

const visible = (files: Map<string, string>) =>
  [...files.keys()].filter((p) => roleOf(p) !== 'excluded');

/** Dangling keys linked from some visible note in `files`. */
function danglingKeys(files: Map<string, string>): Set<string> {
  const resolver = markdown.createLinkResolver(visible(files));
  const keys = new Set<string>();
  for (const path of visible(files)) {
    for (const link of markdown.parseLinks(files.get(path) as string)) {
      const r = resolver.resolve(link.target, path);
      if (r.kind === 'dangling') keys.add(r.key);
    }
  }
  return keys;
}

/** What the indexer should log for `brain.steps[i]`, from the step's truth. */
function expectedFor(brain: SyntheticBrain, i: number, now: number): Entry[] {
  const step = brain.steps[i] as Step;
  const before = filesAfter(brain.steps, i - 1);
  const after = filesAfter(brain.steps, i);
  const resolver = markdown.createLinkResolver(visible(after));
  const out: Entry[] = [];

  for (const r of step.truth.renamed) {
    if (roleOf(r.from) === 'memo' && roleOf(r.to) === 'memo') {
      out.push({ kind: 'rename', item: r.from, to: r.to, time: now });
    }
  }
  const wasDangling = danglingKeys(before);
  for (const path of step.truth.created) {
    if (roleOf(path) !== 'memo') continue;
    const names = [markdown.stripMd(path), markdown.stripMd(markdown.baseName(path))].map((n) =>
      markdown.normalizeDanglingKey(n),
    );
    const key = names.find((k) => wasDangling.has(k));
    if (key !== undefined) out.push({ kind: 'rename', item: key, to: path, time: now });
  }

  for (const path of [...step.truth.created, ...step.truth.edited]) {
    const role = roleOf(path);
    if (role === 'excluded' || role === 'source') continue;
    if (before.get(path) === after.get(path)) continue; // rewritten unchanged
    if (role === 'memo') out.push({ kind: 'edit', item: path, time: step.time });
    const old = before.has(path)
      ? new Set(markdown.linkItems(markdown.parseLinks(before.get(path) as string), path, resolver))
      : new Set<string>();
    const seen = new Set<string>();
    for (const link of step.truth.linksAdded.filter((l) => l.source === path)) {
      const item = link.resolvedPath ?? markdown.normalizeDanglingKey(link.target);
      if (item === path || old.has(item) || seen.has(item)) continue;
      if (link.resolvedPath !== null && roleOf(link.resolvedPath) !== 'memo') continue;
      seen.add(item);
      out.push({ kind: 'mention', item, time: step.time });
    }
  }
  return sortEntries(out);
}

describe.each([1, 7])('replaying the synthetic brain (seed %i)', (seed) => {
  const brain = generateBrain({ seed, steps: 60 });
  const tmp = tempDir();
  const dir = tmp.dir;
  let stores: BrainStores;
  let config: storage.BrainConfig;
  let now = 0;
  const changedPaths = new Set<string>();

  const pass = (rebuild = false) =>
    runIndexPass({
      root: dir,
      stores,
      config,
      classifier: markdown.createRoleClassifier(config.roles),
      now: () => now,
      ...(rebuild ? { rebuild: true } : {}),
    });

  beforeAll(async () => {
    materializeBrain(dir, brain, { upTo: 0 });
    const first = brain.steps[0] as Step;
    for (const c of first.changes) {
      if (c.type === 'write') utimesSync(join(dir, c.path), first.time, first.time);
    }
    config = writeTestConfig(dir, { roles: ROLES });
    now = first.time + 60;
    stores = openBrainStores(dir, { now: () => now });
    const s = await pass();
    expect(s.baseline).toBe(true);
    expect(await stores.events.lastSeq()).toBe(0);
  });

  afterAll(() => {
    stores.close();
    tmp.remove();
  });

  // One test, 120 index passes in sequence (two per step: SQLite
  // transactions over ~50 files): about a second on an idle machine, several
  // on a loaded one, so the default 5 s timeout fails it from load alone.
  it('logs exactly the events and renames each step implies', { timeout: 60_000 }, async () => {
    let checkedRenames = 0;
    let checkedCarry = 0;
    for (let i = 1; i < brain.steps.length; i++) {
      const step = brain.steps[i] as Step;
      applyStep(dir, step);
      now = step.time + 60;
      const seq = await stores.events.lastSeq();
      const summary = await pass();
      const logged = sortEntries(
        (await stores.events.readAfter(seq)).map((e) =>
          e.kind === 'rename'
            ? { kind: e.kind, item: e.item, to: e.to, time: e.time }
            : { kind: e.kind, item: e.item, time: e.time },
        ),
      );
      expect(logged, `step ${i}: ${step.message}`).toEqual(expectedFor(brain, i, now));
      expect(summary.renamed).toBe(step.truth.renamed.length);
      expect(summary.removed).toBe(
        step.truth.deleted.filter((p) => roleOf(p) !== 'excluded').length,
      );
      checkedRenames += logged.filter((e) => e.kind === 'rename' && e.item.includes('/')).length;
      checkedCarry += logged.filter((e) => e.kind === 'rename' && !e.item.endsWith('.md')).length;
      for (const p of summary.changed) changedPaths.add(p);
      // A second pass right after logs nothing.
      const again = await pass();
      expect(again.events, `step ${i} again`).toEqual({ edit: 0, mention: 0, rename: 0 });
    }
    // The timeline's notable features were exercised.
    expect(checkedRenames).toBeGreaterThanOrEqual(1);
    expect(checkedCarry).toBeGreaterThanOrEqual(1);
    const carry = brain.features.danglingThenCreated;
    const renames = await stores.events.renames();
    expect(renames.map((r) => [r.item, r.to])).toContainEqual([
      markdown.normalizeDanglingKey(carry.target),
      carry.path,
    ]);
  });

  it('ends with the notes, headings and links of the final truth', async () => {
    const truth = brain.notes.filter((n) => n.role !== 'excluded');
    expect((await stores.notes.listNotes()).map((n) => [n.path, n.role])).toEqual(
      truth.map((n) => [n.path, n.role]),
    );
    for (const note of truth) {
      const sections = await stores.terms.sectionsOf(note.path);
      expect(
        sections.filter((s) => s.heading !== null).map((s) => s.heading),
        note.path,
      ).toEqual(note.headings);
      if (note.frontMatterTitle !== undefined) {
        expect((await stores.notes.getNote(note.path))?.title).toBe(note.frontMatterTitle);
      }
      const expected = new Map<string, boolean>();
      for (const l of note.links) {
        const item = l.resolvedPath ?? markdown.normalizeDanglingKey(l.target);
        if (item !== note.path) expected.set(item, l.resolvedPath === null);
      }
      const links = await stores.notes.linksFrom(note.path);
      expect(new Map(links.map((l) => [l.target, l.dangling])), note.path).toEqual(expected);
    }
  });

  it('tracks every changed path as uncommitted', async () => {
    expect(await readUncommitted(stores.meta)).toEqual([...changedPaths].sort());
  });

  it('keeps the excluded folder out of both databases', () => {
    stores.close();
    const side = join(dir, '.somememos');
    for (const f of readdirSync(side).filter((n) => n.includes('.sqlite'))) {
      expect(
        readFileSync(join(side, f)).toString('latin1').includes(`${EXCLUDED_FOLDER}/`),
        f,
      ).toBe(false);
    }
    stores = openBrainStores(dir, { now: () => now });
  });

  it('--rebuild reproduces the same scores', async () => {
    const scores = await stores.scores.getAll();
    expect(scores.size).toBeGreaterThan(0);
    const fresh = storage.createMemoryStores();
    await fresh.events.append(await stores.events.readAfter(0), { now });
    await storage.foldPending(fresh.events, fresh.scores, storage.foldOptions(config));
    expectScoresClose(scores, await fresh.scores.getAll());
    const s = await pass(true);
    expect(s.events).toEqual({ edit: 0, mention: 0, rename: 0 });
    expectScoresClose(await stores.scores.getAll(), scores);
  });
});
