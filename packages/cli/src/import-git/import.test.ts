import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { markdown, storage } from '@somememos/core';
import { afterEach, describe, expect, it } from 'vitest';
import { brainPaths, openBrainStores, type BrainStores } from '../store/index.js';
import {
  EXCLUDED_FOLDER,
  filesAfter,
  generateBrain,
  git,
  materializeGitHistory,
  roleOf,
  type BrainOptions,
  type SyntheticBrain,
} from '../testing/index.js';
import { runImportGit } from './command.js';
import { importId } from './ids.js';
import {
  IMPORT_CLIENT,
  META_FIRST_INDEXED_AT,
  importGitHistory,
  parseUntilDate,
  type ImportGitResult,
} from './import.js';

// Every brain here is invented (the synthetic generator, or a few literal notes).

const ROLES: markdown.FolderRolesConfig = {
  ...markdown.DEFAULT_FOLDER_ROLES,
  excluded: [`${EXCLUDED_FOLDER}/`],
};
const NOW = Date.UTC(2026, 0, 1) / 1000;

const dirs: string[] = [];
const opened: BrainStores[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'somememos-import-'));
  dirs.push(dir);
  return dir;
}

function writeConfig(
  brainDir: string,
  roles: markdown.FolderRolesConfig = ROLES,
): storage.BrainConfig {
  const config = storage.parseBrainConfig({ clientId: 'test-client', roles });
  mkdirSync(brainPaths(brainDir).sidecarDir, { recursive: true });
  writeFileSync(
    join(brainPaths(brainDir).sidecarDir, 'config.json'),
    storage.serializeBrainConfig(config),
  );
  return config;
}

function open(brainDir: string): BrainStores {
  const s = openBrainStores(brainDir, { now: () => NOW });
  opened.push(s);
  return s;
}

interface Built {
  dir: string;
  brain: SyntheticBrain;
  hashes: string[];
  config: storage.BrainConfig;
}

const built = new Map<string, Built>();
/** A synthetic brain as a git repository (built once per option set, never written to by tests). */
function buildBrain(options: BrainOptions): Built {
  const key = JSON.stringify(options);
  const cached = built.get(key);
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), 'somememos-import-repo-'));
  const brain = generateBrain(options);
  const hashes = materializeGitHistory(dir, brain);
  const b = {
    dir,
    brain,
    hashes,
    config: storage.parseBrainConfig({ clientId: 'c', roles: ROLES }),
  };
  built.set(key, b);
  return b;
}

/** A fresh brain directory holding a clone of a built repository, with config and empty stores. */
function cloneBrain(b: Built): { dir: string; stores: BrainStores; config: storage.BrainConfig } {
  const dir = join(tempDir(), 'brain');
  git(tempDir(), ['clone', '--quiet', b.dir, dir]);
  const config = writeConfig(dir);
  return { dir, stores: open(dir), config };
}

async function allEntries(stores: storage.Stores): Promise<storage.LogEntry[]> {
  return stores.events.readAfter(0, { limit: 1_000_000 });
}

// ---------------------------------------------------------------------------
// Expected events from the generator's ground truth

const genBase = (p: string): string => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/, '');

/** The generator's resolution: a target with `/` is a path without `.md`; otherwise a unique file name. */
function genResolve(target: string, paths: ReadonlySet<string>): string | null {
  if (target.includes('/')) return paths.has(`${target}.md`) ? `${target}.md` : null;
  for (const p of paths) if (roleOf(p) !== 'excluded' && genBase(p) === target) return p;
  return null;
}

interface Expected {
  edits: string[];
  mentions: string[];
  renames: string[];
}

/**
 * What the import should produce, from `truth` alone: edits from
 * created/edited memos; mentions from each note's link targets before and
 * after the step (accumulated from `linksAdded`, so links are assumed never
 * removed; checked against the final notes), resolved the generator's way;
 * renames from `truth.renamed`, plus dangling keys whose memo was created.
 */
function expectedFromTruth(brain: SyntheticBrain): Expected {
  const edits: string[] = [];
  const mentions: string[] = [];
  const renames: string[] = [];
  const targets = new Map<string, string[]>();
  const danglingKeys = new Set<string>();

  for (const step of brain.steps) {
    const { truth } = step;
    const paths = new Set(filesAfter(brain.steps, step.index).keys());
    for (const r of truth.renamed) {
      targets.set(r.to, targets.get(r.from) ?? []);
      targets.delete(r.from);
      if (roleOf(r.from) === 'memo') renames.push(`${step.index}|${r.from}|${r.to}`);
    }
    for (const d of truth.deleted) targets.delete(d);

    for (const p of truth.created) {
      if (roleOf(p) !== 'memo') continue;
      const key = markdown.normalizeDanglingKey(genBase(p));
      if (danglingKeys.has(key)) {
        renames.push(`${step.index}|${key}|${p}`);
        danglingKeys.delete(key);
      }
    }

    const items = (source: string, list: readonly string[]): Set<string> => {
      const out = new Set<string>();
      for (const t of list) {
        const resolved = genResolve(t, paths);
        if (resolved === source) continue;
        out.add(resolved ?? `dangling:${markdown.normalizeDanglingKey(t)}`);
      }
      return out;
    };

    const added = new Map<string, string[]>();
    for (const l of truth.linksAdded) {
      const list = added.get(l.source) ?? [];
      list.push(l.target);
      added.set(l.source, list);
    }
    for (const source of [...truth.created, ...truth.edited]) {
      if (roleOf(source) === 'excluded') continue;
      if (roleOf(source) === 'memo') edits.push(`${step.index}|${source}`);
      const before = targets.get(source) ?? [];
      const after = [...before, ...(added.get(source) ?? [])];
      targets.set(source, after);
      if (roleOf(source) === 'source') continue; // sources mention nothing
      const old = items(source, before);
      for (const item of items(source, after)) {
        if (old.has(item)) continue;
        if (item.startsWith('dangling:')) {
          const key = item.slice('dangling:'.length);
          danglingKeys.add(key);
          mentions.push(`${step.index}|${key}`);
        } else if (roleOf(item) === 'memo') mentions.push(`${step.index}|${item}`);
      }
    }
  }

  // The "links are never removed" assumption, checked against the final notes.
  for (const note of brain.notes) {
    if (note.role === 'excluded') continue;
    expect([...(targets.get(note.path) ?? [])].sort()).toEqual(
      note.links.map((l) => l.target).sort(),
    );
  }
  return { edits: edits.sort(), mentions: mentions.sort(), renames: renames.sort() };
}

function actualByStep(brain: SyntheticBrain, entries: readonly storage.LogEntry[]): Expected {
  const stepAt = new Map(brain.steps.map((s) => [s.time, s.index]));
  const edits: string[] = [];
  const mentions: string[] = [];
  const renames: string[] = [];
  for (const e of entries) {
    const step = stepAt.get(e.time);
    expect(step, 'every event is at a step time').toBeDefined();
    if (e.kind === 'edit') edits.push(`${step}|${e.item}`);
    else if (e.kind === 'mention') mentions.push(`${step}|${e.item}`);
    else if (e.kind === 'rename') renames.push(`${step}|${e.item}|${e.to}`);
  }
  return { edits: edits.sort(), mentions: mentions.sort(), renames: renames.sort() };
}

// ---------------------------------------------------------------------------

describe('importGitHistory on synthetic brains', () => {
  for (const seed of [1, 2, 3, 7]) {
    it(`matches the ground truth (seed ${seed})`, async () => {
      const b = buildBrain({ seed });
      const { dir, stores, config } = cloneBrain(b);
      const result = await importGitHistory({ brainDir: dir, config, stores, now: NOW });
      const entries = await allEntries(stores);
      const expected = expectedFromTruth(b.brain);
      const actual = actualByStep(b.brain, entries);

      expect(actual.edits).toEqual(expected.edits);
      expect(actual.mentions).toEqual(expected.mentions);
      expect(actual.renames).toEqual(expected.renames);
      expect(entries.every((e) => e.client === IMPORT_CLIENT)).toBe(true);

      // The planted features.
      const { renamed, danglingThenCreated: dtc } = b.brain.features;
      expect(actual.renames).toContain(`${renamed.step}|${renamed.from}|${renamed.to}`);
      const key = markdown.normalizeDanglingKey(dtc.target);
      expect(actual.renames).toContain(`${dtc.createdAt}|${key}|${dtc.path}`);

      // Counts and ordering.
      expect(result.events.edit).toBe(expected.edits.length);
      expect(result.events.mention).toBe(expected.mentions.length);
      expect(result.appended).toEqual({ log: entries.length, changes: result.changeRecords });
      expect(result.duplicates).toEqual({ log: 0, changes: 0 });
      const times = entries.map((e) => e.time);
      expect(times).toEqual([...times].sort((x, y) => x - y));
      expect(result.commits.read).toBe(b.brain.steps.length);
    });
  }

  it('writes one change record per commit that touched a note, with the full message', async () => {
    const b = buildBrain({ seed: 1 });
    const { dir, stores, config } = cloneBrain(b);
    await importGitHistory({ brainDir: dir, config, stores, now: NOW });
    const records = await stores.events.changes();
    const withNotes = b.brain.steps.filter((s) =>
      s.changes.some((c) => roleOf(c.type === 'rename' ? c.to : c.path) !== 'excluded'),
    );
    expect(records).toHaveLength(withNotes.length);
    const byTime = new Map(records.map((r) => [r.time, r]));
    for (const [i, step] of withNotes.entries()) {
      const r = byTime.get(step.time);
      expect(r, `step ${i}`).toBeDefined();
      expect(r!.id).toBe(importId([b.hashes[step.index]!, 'change']));
      expect(r!.message).toBe(step.message);
      expect(r!.op).toBe(storage.changeOp(step.message, config.changeOps));
      expect(r!.client).toBe(IMPORT_CLIENT);
      const touched = new Set<string>();
      for (const c of step.changes) {
        for (const p of c.type === 'rename' ? [c.from, c.to] : [c.path]) {
          if (roleOf(p) !== 'excluded') touched.add(p);
        }
      }
      expect(r!.paths).toEqual([...touched].sort());
    }
  });

  it('carries mentions of a dangling link over to the note created for it, after folding', async () => {
    const b = buildBrain({ seed: 2 });
    const { dir, stores, config } = cloneBrain(b);
    await importGitHistory({ brainDir: dir, config, stores, now: NOW });
    const entries = await allEntries(stores);
    const { target, path, createdAt } = b.brain.features.danglingThenCreated;
    const key = markdown.normalizeDanglingKey(target);
    const created = b.brain.steps[createdAt]!.time;
    const early = entries.filter((e) => e.kind === 'mention' && e.item === key && e.time < created);
    expect(early.length).toBeGreaterThan(0);

    await storage.foldPending(stores.events, stores.scores, { halfLives: config.halfLives });
    expect(await stores.scores.getItem(key)).toBeUndefined();
    const scores = await stores.scores.getItem(path);
    expect(scores).toBeDefined();
    // The same log folded into memory, without the dangling rename, would leave them on the key.
    const memory = storage.createMemoryStores({ now: () => NOW });
    await memory.events.append(
      entries.filter((e) => !(e.kind === 'rename' && e.item === key)),
      { now: NOW },
    );
    await storage.foldPending(memory.events, memory.scores, { halfLives: config.halfLives });
    expect(await memory.scores.getItem(key)).toBeDefined();
  });

  it('leaves no trace of the excluded folder in either database', async () => {
    const b = buildBrain({ seed: 3 });
    const privatePaths = new Set<string>();
    for (const step of b.brain.steps) {
      for (const c of step.changes)
        if (c.type === 'write' && roleOf(c.path) === 'excluded') privatePaths.add(c.path);
    }
    expect(privatePaths.size).toBeGreaterThan(0);

    const { dir } = cloneBrain(b);
    for (const s of opened.splice(0)) s.close();
    const result = await runImportGit({ brainDir: dir, now: NOW });
    expect(result.events.edit).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain(EXCLUDED_FOLDER);

    const { sidecarDir } = brainPaths(dir);
    const files = readdirSync(sidecarDir).filter((f) => f.includes('.sqlite'));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) {
      const bytes = readFileSync(join(sidecarDir, f));
      expect(bytes.includes(`${EXCLUDED_FOLDER}/`), f).toBe(false);
      for (const p of privatePaths) {
        const name = p.slice(p.lastIndexOf('/') + 1);
        expect(bytes.includes(name), `${f} holds ${name}`).toBe(false);
      }
    }
  });

  it('appends nothing the second time', async () => {
    const b = buildBrain({ seed: 1 });
    const { dir, stores, config } = cloneBrain(b);
    const first = await importGitHistory({ brainDir: dir, config, stores, now: NOW });
    const before = await stores.events.lastSeq();
    const second = await importGitHistory({ brainDir: dir, config, stores, now: NOW });
    expect(await stores.events.lastSeq()).toBe(before);
    expect(second.appended).toEqual({ log: 0, changes: 0 });
    expect(second.duplicates).toEqual(first.appended);
  });

  it('--ignore-commit drops a commit’s events and change record but keeps its renames', async () => {
    const b = buildBrain({ seed: 1 });
    const { step: renameStep, from, to } = b.brain.features.renamed;
    // A commit with edits and links, to ignore as well.
    const editStep = b.brain.steps.find(
      (s) =>
        s.index > 0 &&
        s.truth.linksAdded.length > 0 &&
        s.truth.edited.some((p) => roleOf(p) === 'memo'),
    )!;
    const { dir, stores, config } = cloneBrain(b);
    const result = await importGitHistory({
      brainDir: dir,
      config,
      stores,
      now: NOW,
      ignoreCommits: [b.hashes[renameStep]!, b.hashes[editStep.index]!.slice(0, 10)],
    });
    expect(result.commits.ignored).toBe(2);
    expect(result.ignoreNotFound).toBe(0);
    const entries = await allEntries(stores);
    const at = (t: number) => entries.filter((e) => e.time === t);
    expect(at(editStep.time)).toEqual([]);
    expect(
      at(b.brain.steps[renameStep]!.time).map((e) => [
        e.kind,
        e.item,
        (e as storage.RenameInput).to,
      ]),
    ).toEqual([['rename', from, to]]);
    const changeTimes = (await stores.events.changes()).map((c) => c.time);
    expect(changeTimes).not.toContain(editStep.time);
    expect(changeTimes).not.toContain(b.brain.steps[renameStep]!.time);
  });

  it('--dry-run counts the same and writes nothing', async () => {
    const b = buildBrain({ seed: 1 });
    const { dir, stores, config } = cloneBrain(b);
    const dry = await importGitHistory({ brainDir: dir, config, stores, now: NOW, dryRun: true });
    expect(await stores.events.lastSeq()).toBe(0);
    expect(await stores.events.changes()).toEqual([]);
    expect(dry.appended).toBeNull();
    const real = await importGitHistory({ brainDir: dir, config, stores, now: NOW });
    expect(dry.events).toEqual(real.events);
    expect(dry.renames).toEqual(real.renames);
    expect(dry.changeRecords).toBe(real.changeRecords);
  });

  it('--dry-run through the command creates no database on a fresh brain', async () => {
    const b = buildBrain({ seed: 1 });
    const dir = join(tempDir(), 'brain');
    git(tempDir(), ['clone', '--quiet', b.dir, dir]);
    writeConfig(dir);
    const result = await runImportGit({ brainDir: dir, dryRun: true, now: NOW });
    expect(result.events.edit).toBeGreaterThan(0);
    expect(result.folded).toBeNull();
    expect(readdirSync(brainPaths(dir).sidecarDir)).toEqual(['config.json']);
  });

  it('stops where the brain was first indexed, and at --until', async () => {
    const b = buildBrain({ seed: 1 });
    const middle = b.brain.steps[30]!;
    const { dir, stores, config } = cloneBrain(b);
    await stores.meta.set(META_FIRST_INDEXED_AT, String(middle.time));
    const result = await importGitHistory({ brainDir: dir, config, stores, now: NOW });
    expect(result.cutoff).toEqual({ time: middle.time - 1, source: 'first-indexed' });
    expect(result.commits.read - result.commits.afterCutoff).toBe(30);
    const entries = await allEntries(stores);
    expect(Math.max(...entries.map((e) => e.time))).toBeLessThan(middle.time);

    // --until a commit, and --until a date, without the meta.
    const other = cloneBrain(b);
    const byCommit = await importGitHistory({
      brainDir: other.dir,
      config,
      stores: null,
      dryRun: true,
      now: NOW,
      until: b.hashes[9]!,
    });
    expect(byCommit.commits.read).toBe(10);
    expect(byCommit.cutoff.source).toBe('until-commit');
    const day = new Date(b.brain.steps[9]!.time * 1000).toISOString().slice(0, 10);
    const byDate = await importGitHistory({
      brainDir: other.dir,
      config,
      stores: null,
      dryRun: true,
      now: NOW,
      until: day,
    });
    const sameDayOrEarlier = b.brain.steps.filter((s) => s.time <= parseUntilDate(day)!).length;
    expect(byDate.commits.read - byDate.commits.afterCutoff).toBe(sameDayOrEarlier);
  });

  it('clamps future commit times to now', async () => {
    const b = buildBrain({ seed: 1 });
    const { dir, stores, config } = cloneBrain(b);
    const now = b.brain.steps[40]!.time;
    await importGitHistory({ brainDir: dir, config, stores, now });
    const entries = await allEntries(stores);
    expect(Math.max(...entries.map((e) => e.time))).toBe(now);
  });
});

// ---------------------------------------------------------------------------
// Small hand-built repositories

function commitAll(dir: string, time: number, message: string): void {
  git(dir, ['add', '--all']);
  git(dir, ['commit', '--quiet', '--allow-empty', '--no-verify', '-m', message], time);
}

function write(dir: string, path: string, content: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

const T0 = Date.UTC(2025, 2, 1) / 1000;

async function importRepo(
  brainDir: string,
  config: storage.BrainConfig,
): Promise<{
  result: ImportGitResult;
  entries: storage.LogEntry[];
  stores: BrainStores;
}> {
  const stores = open(brainDir);
  const result = await importGitHistory({ brainDir, config, stores, now: NOW });
  return { result, entries: await allEntries(stores), stores };
}

const summary = (entries: readonly storage.LogEntry[]): string[] =>
  entries.map((e) =>
    e.kind === 'rename'
      ? `${e.time - T0} rename ${e.item} -> ${e.to}`
      : `${e.time - T0} ${e.kind} ${e.item}`,
  );

describe('importGitHistory on hand-built repositories', () => {
  it('counts a merged branch once, at the merge (first-parent)', async () => {
    const dir = tempDir();
    git(dir, ['init', '--quiet', '--initial-branch=main']);
    write(dir, 'memos/alpha.md', '# Alpha\n');
    commitAll(dir, T0, 'ingest alpha');
    git(dir, ['checkout', '--quiet', '-b', 'side']);
    write(dir, 'memos/beta.md', '# Beta\n\nSee [[alpha]].\n');
    commitAll(dir, T0 + 10, 'ingest beta on a branch');
    git(dir, ['checkout', '--quiet', 'main']);
    write(dir, 'memos/alpha.md', '# Alpha\n\nMore.\n');
    commitAll(dir, T0 + 20, 'update alpha');
    git(dir, ['merge', '--quiet', '--no-ff', '--no-edit', 'side'], T0 + 30);
    const config = writeConfig(dir);

    const { result, entries, stores } = await importRepo(dir, config);
    expect(summary(entries)).toEqual([
      '0 edit memos/alpha.md',
      '20 edit memos/alpha.md',
      '30 edit memos/beta.md',
      '30 mention memos/alpha.md',
    ]);
    expect(result.commits.read).toBe(3);
    const records = await stores.events.changes();
    expect(records.map((r) => [r.time - T0, r.paths])).toEqual([
      [30, ['memos/beta.md']],
      [20, ['memos/alpha.md']],
      [0, ['memos/alpha.md']],
    ]);
  });

  it('reads a brain in a subdirectory of the repository, with brain-relative paths', async () => {
    const repo = tempDir();
    git(repo, ['init', '--quiet', '--initial-branch=main']);
    write(repo, 'README.md', 'Not part of the brain. [[gamma]]\n');
    write(repo, 'notes/memos/gamma.md', '# Gamma\n');
    commitAll(repo, T0, 'start');
    write(repo, 'notes/diary/2025/03/2025-03-01.md', '# Day\n\n[[gamma]] and [[delta]].\n');
    write(repo, 'elsewhere/memos/x.md', 'outside\n');
    commitAll(repo, T0 + 5, 'session day');
    write(repo, 'README.md', 'Changed, outside the brain.\n');
    commitAll(repo, T0 + 6, 'outside only');
    git(repo, ['mv', 'notes/memos/gamma.md', 'notes/memos/gamma-renamed.md']);
    commitAll(repo, T0 + 7, 'update rename gamma');
    const brainDir = join(repo, 'notes');
    const config = writeConfig(brainDir);

    const { result, entries, stores } = await importRepo(brainDir, config);
    expect(summary(entries)).toEqual([
      '0 edit memos/gamma.md',
      '5 mention memos/gamma.md',
      '5 mention delta',
      '7 rename memos/gamma.md -> memos/gamma-renamed.md',
    ]);
    expect(result.commits.read).toBe(3);
    const records = await stores.events.changes();
    expect(records.map((r) => r.paths)).toEqual([
      ['memos/gamma-renamed.md', 'memos/gamma.md'],
      ['diary/2025/03/2025-03-01.md'],
      ['memos/gamma.md'],
    ]);
  });

  it('handles spaces, quotes and non-ASCII names, renames with edits, symlinks and binaries', async () => {
    const dir = tempDir();
    git(dir, ['init', '--quiet', '--initial-branch=main']);
    write(dir, 'memos/Café notes.md', '# Café\n');
    write(dir, 'memos/say "hi".md', '# Hi\n\n[[Café notes]] and [[naïve plan]].\n');
    write(dir, 'memos/picture.png', '\x89PNG\x00\x01binary');
    write(dir, 'memos/blob.md', 'abc\x00def [[Café notes]]\n');
    commitAll(dir, T0, 'ingest first notes');
    write(
      dir,
      'memos/naïve plan.md',
      '# Plan\n\n' + 'A long body line that keeps the content similar.\n'.repeat(20),
    );
    commitAll(dir, T0 + 10, 'ingest the plan');
    git(dir, ['mv', 'memos/naïve plan.md', 'memos/naïve plan 2.md']);
    write(
      dir,
      'memos/naïve plan 2.md',
      '# Plan\n\n' +
        'A long body line that keeps the content similar.\n'.repeat(20) +
        '[[say "hi"]]\n',
    );
    commitAll(dir, T0 + 20, 'update rename and edit the plan');
    const { symlinkSync } = await import('node:fs');
    symlinkSync('Café notes.md', join(dir, 'memos/link.md'));
    commitAll(dir, T0 + 30, 'update add a symlink');
    const config = writeConfig(dir);

    const { result, entries } = await importRepo(dir, config);
    expect(summary(entries)).toEqual([
      '0 edit memos/Café notes.md',
      '0 edit memos/blob.md',
      '0 edit memos/say "hi".md',
      '0 mention memos/Café notes.md',
      '0 mention naïve plan',
      '10 rename naïve plan -> memos/naïve plan.md',
      '10 edit memos/naïve plan.md',
      '20 rename memos/naïve plan.md -> memos/naïve plan 2.md',
      '20 edit memos/naïve plan 2.md',
      '20 mention memos/say "hi".md',
    ]);
    expect(result.blobs.skipped).toBe(1); // the .md holding a NUL byte
    expect(result.commits.withoutNotes).toBe(1); // the symlink
  });

  it('drops links into excluded folders, logs nothing for sources, and splits memo/dated moves', async () => {
    const dir = tempDir();
    git(dir, ['init', '--quiet', '--initial-branch=main']);
    write(dir, `${EXCLUDED_FOLDER}/hidden-thing.md`, 'secret\n');
    write(
      dir,
      'memos/open.md',
      `# Open\n\n[[hidden-thing]] [[${EXCLUDED_FOLDER}/hidden-thing]] [[${EXCLUDED_FOLDER}/not-yet]] [[later]]\n`,
    );
    write(dir, 'sources/paper.md', '# Paper\n\n[[open]]\n');
    commitAll(dir, T0, 'ingest');
    mkdirSync(join(dir, 'diary/2025/03'), { recursive: true });
    git(dir, ['mv', 'memos/open.md', 'diary/2025/03/2025-03-01.md']);
    commitAll(dir, T0 + 1, 'update move a memo to the diary');
    const config = writeConfig(dir);
    const { entries, stores } = await importRepo(dir, config);
    expect(summary(entries)).toEqual([
      '0 edit memos/open.md',
      '0 mention later',
      '1 mention later',
    ]);
    const records = await stores.events.changes();
    expect(JSON.stringify(records)).not.toContain(EXCLUDED_FOLDER);
    expect(JSON.stringify(entries)).not.toContain('hidden');
  });

  it('does not count a reworded link to the same note, a self-link, or a link to a non-memo', async () => {
    const dir = tempDir();
    git(dir, ['init', '--quiet', '--initial-branch=main']);
    write(dir, 'memos/one.md', '# One\n\n[[two]] [[one]] [[sources/paper]]\n');
    write(dir, 'memos/two.md', '# Two\n');
    write(dir, 'sources/paper.md', '# Paper\n');
    commitAll(dir, T0, 'ingest');
    write(
      dir,
      'memos/one.md',
      '# One\n\n[[memos/two|Two]] [[two#Top]] [[one]] [[sources/paper]]\n\n```\n[[three]]\n```\n',
    );
    commitAll(dir, T0 + 1, 'update reword');
    const config = writeConfig(dir);
    const { entries } = await importRepo(dir, config);
    expect(summary(entries)).toEqual([
      '0 edit memos/one.md',
      '0 edit memos/two.md',
      '0 mention memos/two.md',
      '1 edit memos/one.md',
    ]);
  });

  it('ignores attachment links and embeds, as the live pass does', async () => {
    const dir = tempDir();
    git(dir, ['init', '--quiet', '--initial-branch=main']);
    write(dir, 'memos/node.js.md', '# Node\n');
    write(
      dir,
      'memos/album.md',
      '# Album\n\n![[photo.png]] [[scan.pdf|scan]] [[node.js]] [[v1.2]]\n',
    );
    commitAll(dir, T0, 'ingest album');
    const config = writeConfig(dir);
    const { entries } = await importRepo(dir, config);
    expect(summary(entries)).toEqual([
      '0 edit memos/album.md',
      '0 edit memos/node.js.md',
      '0 mention memos/node.js.md',
      '0 mention v1.2',
    ]);
  });

  it('fails clearly outside a git repository and for an unknown --ignore-commit', async () => {
    const dir = tempDir();
    const config = writeConfig(dir);
    await expect(
      importGitHistory({ brainDir: dir, config, dryRun: true, now: NOW }),
    ).rejects.toThrow(/not inside a git work tree/);
    git(dir, ['init', '--quiet', '--initial-branch=main']);
    write(dir, 'memos/a.md', 'a\n');
    commitAll(dir, T0, 'a');
    await expect(
      importGitHistory({
        brainDir: dir,
        config,
        dryRun: true,
        now: NOW,
        ignoreCommits: ['deadbeef'],
      }),
    ).rejects.toThrow(/not a commit/);
  });
});

describe('parseUntilDate', () => {
  it('reads dates, date-times and @seconds, and passes anything else on as a commit', () => {
    expect(parseUntilDate('2025-03-01')).toBe(Date.UTC(2025, 2, 1) / 1000 + 86_399);
    expect(parseUntilDate('2025-03-01T12:00:00Z')).toBe(Date.UTC(2025, 2, 1, 12) / 1000);
    expect(parseUntilDate('@1700000000')).toBe(1_700_000_000);
    expect(parseUntilDate('abc1234')).toBeNull();
    expect(parseUntilDate('HEAD~3')).toBeNull();
    expect(() => parseUntilDate('2025-02-30')).toThrow(/not a valid date/);
  });
});

describe('import-git at scale', () => {
  it('times the default 60-step brain', async () => {
    const b = buildBrain({ seed: 1 });
    const { dir, stores, config } = cloneBrain(b);
    const result = await importGitHistory({ brainDir: dir, config, stores, now: NOW });
    console.log(
      `import-git default brain: ${result.commits.read} commits, ` +
        `${result.events.edit + result.events.mention} events, ${result.resolverBuilds} resolver builds; ` +
        `${result.elapsedMs} ms`,
    );
  });

  it('imports a 1,500-step history', { timeout: 600_000 }, async () => {
    const t0 = performance.now();
    const b = buildBrain({ seed: 5, steps: 1500, days: 330 });
    const built = performance.now() - t0;
    const { dir, stores, config } = cloneBrain(b);
    const result = await importGitHistory({ brainDir: dir, config, stores, now: NOW });
    const folded = await storage.foldPending(stores.events, stores.scores, {
      halfLives: config.halfLives,
    });
    const entries = await allEntries(stores);
    expect(actualByStep(b.brain, entries)).toEqual(expectedFromTruth(b.brain));
    console.log(
      `import-git scale: ${result.commits.read} commits, ${entries.length} log entries, ` +
        `${result.changeRecords} change records, ${result.resolverBuilds} resolver builds, ` +
        `${result.blobs.read} blobs; import ${result.elapsedMs} ms, fold ${folded.events} events; ` +
        `(building the repository took ${Math.round(built)} ms)`,
    );
  });
});
