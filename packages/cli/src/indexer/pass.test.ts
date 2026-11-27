// The index pass on small invented fixtures: every rule of IMPLEMENTATION.md
// tasks 1.7 to 1.10. All content here is made up.

import { readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { markdown, storage } from '@somememos/core';
import { expectScoresClose } from '@somememos/core/testing/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, writeNote, writeTestConfig } from '../brain/testing.js';
import { type BrainStores, openBrainStores } from '../store/index.js';
import { runIndexPass } from './pass.js';
import { META_BASELINE, readUncommitted } from './state.js';

const ROLES: markdown.FolderRolesConfig = {
  memo: ['memos/'],
  dated: ['diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md'],
  source: ['sources/'],
  excluded: ['private/'],
};

const T0 = 1_750_000_000;

let tmp: ReturnType<typeof tempDir>;
let dir: string;
let now: number;
let stores: BrainStores;
let config: storage.BrainConfig;

function openStores(
  roles: markdown.FolderRolesConfig = ROLES,
  extra: Record<string, unknown> = {},
) {
  config = writeTestConfig(dir, { roles, ...extra });
  stores = openBrainStores(dir, { now: () => now, analyzer: config.analyzer });
}

function pass(options: { rebuild?: boolean; s?: storage.Stores } = {}) {
  return runIndexPass({
    root: dir,
    stores: options.s ?? stores,
    config,
    classifier: markdown.createRoleClassifier(config.roles),
    now: () => now,
    ...(options.rebuild ? { rebuild: true } : {}),
  });
}

/** The stores with `indexTransaction` counted: a pass that never calls it wrote nothing. */
function countTransactions(s: storage.Stores) {
  let calls = 0;
  const watched: storage.Stores = {
    ...s,
    indexTransaction<T>(fn: () => storage.Awaitable<T>): Promise<T> {
      calls++;
      return s.indexTransaction(fn);
    },
  };
  return { watched, calls: () => calls };
}

/** Write a file with mtime `now - 1` (so the event time is predictable). */
function write(path: string, content: string, mtime = now - 1): void {
  writeNote(dir, path, content, mtime);
}

async function logAfter(seq: number) {
  return (await stores.events.readAfter(seq)).map((e) =>
    e.kind === 'rename'
      ? { kind: e.kind, item: e.item, to: e.to, time: e.time }
      : { kind: e.kind, item: e.item, time: e.time },
  );
}

beforeEach(() => {
  tmp = tempDir();
  dir = tmp.dir;
  now = T0;
});

afterEach(() => {
  stores?.close();
  tmp.remove();
});

describe('baseline', () => {
  it('logs nothing on the first pass, and records the baseline', async () => {
    openStores();
    write('memos/a.md', '# A\n\nLinks [[b]] and [[nowhere]].\n');
    write('memos/b.md', '# B\n');
    const s = await pass();
    expect(s.baseline).toBe(true);
    expect(s.indexed).toBe(2);
    expect(s.events).toEqual({ edit: 0, mention: 0, rename: 0 });
    expect(s.changed).toEqual([]);
    expect(await stores.events.lastSeq()).toBe(0);
    expect(await stores.indexMeta.get(META_BASELINE)).toBe(String(T0));
    expect(await stores.meta.get('indexer.firstIndexedAt')).toBe(String(T0));
    expect(await readUncommitted(stores.meta)).toEqual([]);
    expect(await stores.notes.linksFrom('memos/a.md')).toEqual([
      { target: 'memos/b.md', dangling: false },
      { target: 'nowhere', dangling: true },
    ]);
  });

  it('a second pass with nothing changed does no writes', async () => {
    openStores();
    write('memos/a.md', '# A\n\n[[b]]\n');
    await pass();
    const spy = countTransactions(stores);
    const watched = spy.watched;
    const before = await stores.events.lastSeq();
    now += 100;
    const s = await pass({ s: watched });
    expect(spy.calls()).toBe(0);
    expect(s.indexed).toBe(0);
    expect(s.events).toEqual({ edit: 0, mention: 0, rename: 0 });
    expect(await stores.events.lastSeq()).toBe(before);
  });

  it('a new brain indexed empty logs the first note written', async () => {
    openStores();
    await pass();
    write('memos/first.md', '# First\n');
    const s = await pass();
    expect(s.baseline).toBe(false);
    expect(await logAfter(0)).toEqual([{ kind: 'edit', item: 'memos/first.md', time: now - 1 }]);
  });
});

describe('edits and mentions', () => {
  beforeEach(async () => {
    openStores();
    write('memos/a.md', '# A\n\nSee [[b]].\n');
    write('memos/b.md', '# B\n');
    write('sources/paper.md', '# Paper\n');
    write('diary/2025/06/2025-06-15.md', '# 2025-06-15\n');
    await pass();
    now += 1000;
  });

  it('an edit logs exactly one edit at the file mtime; the next pass logs nothing', async () => {
    write('memos/b.md', '# B\n\nMore text.\n', now - 30);
    const s = await pass();
    expect(s.events).toEqual({ edit: 1, mention: 0, rename: 0 });
    expect(await logAfter(0)).toEqual([{ kind: 'edit', item: 'memos/b.md', time: now - 30 }]);
    const again = await pass();
    expect(again.events).toEqual({ edit: 0, mention: 0, rename: 0 });
    expect(await stores.events.lastSeq()).toBe(1);
  });

  it('dates an edit at most now', async () => {
    write('memos/b.md', '# B\n\nFrom the future.\n', now + 5000);
    await pass();
    expect(await logAfter(0)).toEqual([{ kind: 'edit', item: 'memos/b.md', time: now }]);
  });

  it('a touch without a content change logs nothing but updates the mtime', async () => {
    utimesSync(join(dir, 'memos/b.md'), now - 5, now - 5);
    const s = await pass();
    expect(s.events.edit).toBe(0);
    expect((await stores.notes.getNote('memos/b.md'))?.mtime).toBe(now - 5);
    // And the next pass does not even read it.
    const spy = countTransactions(stores);
    await pass({ s: spy.watched });
    expect(spy.calls()).toBe(0);
  });

  it('added links produce one mention each, once', async () => {
    write('memos/a.md', '# A\n\nSee [[b]], [[B|again]], [[new idea]] and [[new idea]].\n');
    await pass();
    expect(await logAfter(0)).toEqual([
      { kind: 'edit', item: 'memos/a.md', time: now - 1 },
      { kind: 'mention', item: 'new idea', time: now - 1 },
    ]);
    now += 10;
    write('memos/a.md', '# A\n\nSee [[b]] and [[new idea]], reworded.\n');
    await pass();
    expect((await logAfter(2)).map((e) => e.kind)).toEqual(['edit']);
  });

  it('mentions only memos and dangling targets, never dated or source notes', async () => {
    write('memos/a.md', '# A\n\n[[b]] [[paper]] [[2025-06-15]] [[elsewhere]]\n');
    await pass();
    expect((await logAfter(0)).filter((e) => e.kind === 'mention').map((e) => e.item)).toEqual([
      'elsewhere',
    ]);
  });

  it('a dated note is a source of mentions but logs no edit', async () => {
    write('diary/2025/06/2025-06-15.md', '# 2025-06-15\n\nWorked on [[b]].\n');
    const s = await pass();
    expect(s.events).toEqual({ edit: 0, mention: 1, rename: 0 });
    expect(await logAfter(0)).toEqual([{ kind: 'mention', item: 'memos/b.md', time: now - 1 }]);
    expect(await readUncommitted(stores.meta)).toEqual(['diary/2025/06/2025-06-15.md']);
  });

  it('a changed source is re-indexed with a warning and logs nothing', async () => {
    write('sources/paper.md', '# Paper\n\nAmended, with [[b]].\n');
    const s = await pass();
    expect(s.events).toEqual({ edit: 0, mention: 0, rename: 0 });
    expect(s.warnings).toEqual([expect.stringContaining('source changed: sources/paper.md')]);
    expect((await stores.terms.sectionsOf('sources/paper.md'))[0]?.body).toContain('Amended');
  });

  it('a new memo is an edit with all its links added', async () => {
    write('memos/c.md', '# C\n\n[[a]] [[b]] [[c]] [[later]]\n');
    await pass();
    expect(await logAfter(0)).toEqual([
      { kind: 'edit', item: 'memos/c.md', time: now - 1 },
      { kind: 'mention', item: 'memos/a.md', time: now - 1 },
      { kind: 'mention', item: 'memos/b.md', time: now - 1 },
      { kind: 'mention', item: 'later', time: now - 1 },
    ]);
  });

  it('stores section bodies as raw markdown that makeSnippet can use', async () => {
    write('memos/b.md', '# B\n\n## Soil\n\nUse **compost** and [[a|the A note]].\n');
    await pass();
    const sections = await stores.terms.sectionsOf('memos/b.md');
    expect(sections.map((s) => s.heading)).toEqual([null, 'Soil']);
    expect(sections[1]?.body).toBe('Use **compost** and [[a|the A note]].');
    expect(sections[1]?.title).toBe('B');
  });

  it('tracks uncommitted paths across passes', async () => {
    write('memos/b.md', '# B\n\nOne.\n');
    await pass();
    now += 10;
    write('memos/a.md', '# A\n\nTwo.\n');
    await pass();
    expect(await readUncommitted(stores.meta)).toEqual(['memos/a.md', 'memos/b.md']);
  });
});

describe('renames, carry-over and deletes', () => {
  beforeEach(async () => {
    openStores();
    write('memos/old-name.md', '# Topic\n\nBody text.\n');
    write('memos/linker.md', '# Linker\n\n[[old-name]] and [[future topic]].\n');
    await pass();
    now += 1000;
    // Give the notes some history.
    write('memos/old-name.md', '# Topic\n\nBody text, edited.\n');
    write('memos/elsewhere.md', '# Elsewhere\n\nAlso [[future topic]].\n');
    await pass();
    now += 1000;
  });

  it('a pure move is a rename record, not an edit, and the history follows', async () => {
    const seq = await stores.events.lastSeq();
    const scoresBefore = await stores.scores.getItem('memos/old-name.md');
    renameSync(join(dir, 'memos/old-name.md'), join(dir, 'memos/new-name.md'));
    const s = await pass();
    expect(s.renamed).toBe(1);
    expect(await logAfter(seq)).toEqual([
      { kind: 'rename', item: 'memos/old-name.md', to: 'memos/new-name.md', time: now },
    ]);
    expect(await stores.notes.getNote('memos/old-name.md')).toBeUndefined();
    expect((await stores.notes.getNote('memos/new-name.md'))?.title).toBe('Topic');
    expect(await stores.scores.getItem('memos/old-name.md')).toBeUndefined();
    expect(await stores.scores.getItem('memos/new-name.md')).toEqual(scoresBefore);
    // The linker's [[old-name]] now dangles; it was re-resolved without being edited.
    expect(await stores.notes.linksFrom('memos/linker.md')).toEqual([
      { target: 'future topic', dangling: true },
      { target: 'old-name', dangling: true },
    ]);
    expect(await readUncommitted(stores.meta)).toEqual(
      expect.arrayContaining(['memos/old-name.md', 'memos/new-name.md']),
    );
  });

  it('a move with a content change is a delete plus a new note', async () => {
    const seq = await stores.events.lastSeq();
    rmSync(join(dir, 'memos/old-name.md'));
    write('memos/new-name.md', '# Topic\n\nBody text, edited again.\n');
    const s = await pass();
    expect(s.renamed).toBe(0);
    expect(s.removed).toBe(1);
    expect(await logAfter(seq)).toEqual([
      { kind: 'edit', item: 'memos/new-name.md', time: now - 1 },
    ]);
    // History stays with the old path.
    expect(await stores.scores.getItem('memos/old-name.md')).toBeDefined();
  });

  it('a new note resolving a dangling link carries the key history over', async () => {
    const seq = await stores.events.lastSeq();
    const danglingScores = await stores.scores.getItem('future topic');
    expect(danglingScores).toBeDefined();
    write('memos/Future Topic.md', '# Future topic\n');
    await pass();
    expect(await logAfter(seq)).toEqual([
      { kind: 'rename', item: 'future topic', to: 'memos/Future Topic.md', time: now },
      { kind: 'edit', item: 'memos/Future Topic.md', time: now - 1 },
    ]);
    expect(await stores.scores.getItem('future topic')).toBeUndefined();
    const moved = await stores.scores.getItem('memos/Future Topic.md');
    expect(moved?.day?.mention).toBe(danglingScores?.day?.mention);
    expect(moved?.day?.edit).toBeDefined();
    // Both linking notes now resolve the link.
    expect(await stores.notes.linksFrom('memos/elsewhere.md')).toEqual([
      { target: 'memos/Future Topic.md', dangling: false },
    ]);
    expect(await stores.notes.backlinks('memos/Future Topic.md')).toEqual([
      'memos/elsewhere.md',
      'memos/linker.md',
    ]);
    expect(await stores.notes.danglingTargets()).toEqual([]);
  });

  it('a new note that makes a name ambiguous re-resolves the links that use it', async () => {
    write('memos/sub/linker2.md', '# L2\n\n[[old-name]]\n');
    await pass();
    expect(await stores.notes.linksFrom('memos/sub/linker2.md')).toEqual([
      { target: 'memos/old-name.md', dangling: false },
    ]);
    now += 10;
    write('memos/sub/old-name.md', '# Local topic\n');
    await pass();
    // The note in the linking note's own folder wins now.
    expect(await stores.notes.linksFrom('memos/sub/linker2.md')).toEqual([
      { target: 'memos/sub/old-name.md', dangling: false },
    ]);
  });

  it('a delete removes the note, its sections and links; scores stay', async () => {
    const seq = await stores.events.lastSeq();
    rmSync(join(dir, 'memos/elsewhere.md'));
    const s = await pass();
    expect(s.removed).toBe(1);
    expect(await logAfter(seq)).toEqual([]);
    expect(await stores.notes.getNote('memos/elsewhere.md')).toBeUndefined();
    expect(await stores.terms.sectionsOf('memos/elsewhere.md')).toEqual([]);
    expect(await stores.notes.linksFrom('memos/elsewhere.md')).toEqual([]);
    expect(await stores.notes.backlinks('future topic')).toEqual(['memos/linker.md']);
    expect(await stores.scores.getItem('memos/elsewhere.md')).toBeDefined();
    expect(await readUncommitted(stores.meta)).toContain('memos/elsewhere.md');
  });
});

describe('excluded folders and roles', () => {
  /** Every byte of both databases (with any WAL files), as latin1 text, after closing the stores. */
  function sidecarBytes(): string {
    stores.close();
    const side = join(dir, '.somememos');
    const files = readdirSync(side).filter((f) => f.includes('.sqlite'));
    expect(files).toEqual(expect.arrayContaining(['events.sqlite', 'index.sqlite']));
    return files.map((f) => readFileSync(join(side, f)).toString('latin1')).join('\n');
  }

  it('an excluded file leaves no trace in either database', async () => {
    openStores();
    write('private/zanzibar-quokka-plan.md', '# Zanzibar quokka plan\n\n[[memos/a]] marmalade\n');
    write('memos/a.md', '# A\n\nPublic text.\n');
    await pass();
    now += 100;
    write('private/zanzibar-quokka-plan.md', '# Zanzibar quokka plan\n\nEdited marmalade\n');
    write('memos/a.md', '# A\n\nPublic text, edited.\n');
    write('private/deeper/zanzibar-otter.md', '# Otter\n');
    const s = await pass();
    expect(s.scanned).toBe(1);
    expect(s.events.edit).toBe(1);
    const bytes = sidecarBytes();
    for (const word of ['zanzibar', 'Zanzibar', 'quokka', 'otter', 'marmalade', 'private/']) {
      expect(bytes.includes(word), word).toBe(false);
    }
  });

  it('drops links that point into an excluded folder', async () => {
    openStores();
    write('private/secret.md', '# S\n');
    write('memos/a.md', '# A\n');
    await pass();
    now += 100;
    write('memos/a.md', '# A\n\n[[secret]] [[private/secret]] [[private/not-there]] [[open]]\n');
    await pass();
    expect(await stores.notes.linksFrom('memos/a.md')).toEqual([
      { target: 'open', dangling: true },
    ]);
    expect((await logAfter(0)).map((e) => e.item)).toEqual(['memos/a.md', 'open']);
  });

  it('with no roles declared, every markdown file is a memo', async () => {
    openStores({});
    write('anything/x.md', '# X\n');
    write('top.md', '# Top\n');
    write('notes.txt', 'not markdown');
    await pass();
    expect((await stores.notes.listNotes()).map((n) => [n.path, n.role])).toEqual([
      ['anything/x.md', 'memo'],
      ['top.md', 'memo'],
    ]);
  });

  it('skips files no declared role matches, and dot folders', async () => {
    openStores();
    write('loose.md', '# Loose\n');
    write('.trash/old.md', '# Old\n');
    write('node_modules/pkg/readme.md', '# Pkg\n');
    write('memos/a.md', '# A\n');
    write('diary/2025/06/2025-06-31.md', '# impossible date\n');
    write('diary/2025/06/2025-06-30.md', '# fine\n');
    const s = await pass();
    expect(s.scanned).toBe(2);
    const notes = await stores.notes.listNotes();
    expect(notes.map((n) => [n.path, n.role, n.date])).toEqual([
      ['diary/2025/06/2025-06-30.md', 'dated', '2025-06-30'],
      ['memos/a.md', 'memo', null],
    ]);
  });

  it('a role change re-classifies a note without logging', async () => {
    openStores({});
    write('memos/a.md', '# A\n');
    write('sources/p.md', '# P\n');
    await pass();
    stores.close();
    openStores(ROLES);
    const s = await pass();
    expect(s.events).toEqual({ edit: 0, mention: 0, rename: 0 });
    expect((await stores.notes.getNote('sources/p.md'))?.role).toBe('source');
  });
});

describe('rebuild', () => {
  it('reproduces the same scores and index, and logs nothing new', async () => {
    openStores();
    write('memos/a.md', '# A\n');
    await pass();
    for (let i = 0; i < 5; i++) {
      now += 3600;
      write('memos/a.md', `# A\n\nVersion ${i} with [[topic ${i}]].\n`);
      write(`memos/n${i}.md`, `# N${i}\n\n[[a]]\n`);
      await pass();
    }
    now += 3600;
    renameSync(join(dir, 'memos/n0.md'), join(dir, 'memos/renamed.md'));
    write('memos/Topic 1.md', '# Topic one\n');
    await pass();
    const scores = await stores.scores.getAll();
    const notes = await stores.notes.listNotes();
    const sections = await stores.terms.statistics();
    const seq = await stores.events.lastSeq();
    now += 10;
    const s = await pass({ rebuild: true });
    expect(s.rebuilt).toBe(true);
    expect(s.baseline).toBe(false);
    expect(s.events).toEqual({ edit: 0, mention: 0, rename: 0 });
    expect(await stores.events.lastSeq()).toBe(seq);
    expectScoresClose(await stores.scores.getAll(), scores);
    expect(await stores.notes.listNotes()).toEqual(notes);
    expect(await stores.terms.statistics()).toEqual(sections);
    // And it leaves a baseline: the next pass with nothing changed is write-free.
    const spy = countTransactions(stores);
    await pass({ s: spy.watched });
    expect(spy.calls()).toBe(0);
  });

  it('still logs changes made since the last pass', async () => {
    openStores();
    write('memos/a.md', '# A\n');
    await pass();
    now += 100;
    write('memos/a.md', '# A\n\nChanged before the rebuild.\n');
    const s = await pass({ rebuild: true });
    expect(s.events.edit).toBe(1);
  });

  it('rebuilds automatically when the analyzer options change', async () => {
    openStores();
    write('memos/a.md', '# A\n\nRunning runners run.\n');
    await pass();
    stores.close();
    openStores(ROLES, { analyzer: { stem: false } });
    const s = await pass();
    expect(s.rebuilt).toBe(true);
    expect(s.warnings[0]).toContain('analyzer');
    expect(stores.terms.analyzer.stem).toBe(false);
    expect(s.events).toEqual({ edit: 0, mention: 0, rename: 0 });
  });

  it('a deleted index.sqlite is re-indexed as a baseline, with a warning', async () => {
    openStores();
    write('memos/a.md', '# A\n');
    await pass();
    stores.close();
    for (const f of readdirSync(join(dir, '.somememos'))) {
      if (f.startsWith('index.sqlite')) rmSync(join(dir, '.somememos', f));
    }
    openStores();
    writeFileSync(join(dir, 'memos/a.md'), '# A\n\nChanged.\n');
    const s = await pass();
    expect(s.baseline).toBe(true);
    expect(s.events.edit).toBe(0);
    expect(s.warnings[0]).toContain('not logged');
  });
});

describe('performance', () => {
  it('a pass with nothing changed is fast on a few hundred notes', async () => {
    openStores();
    for (let i = 0; i < 400; i++) {
      const folder = i % 4 === 0 ? 'diary/2025/06' : `memos/topic-${i % 7}`;
      const name = i % 4 === 0 ? `2025-06-${String((i % 28) + 1).padStart(2, '0')}` : `note-${i}`;
      write(
        `${folder}/${name}.md`,
        `# Note ${i}\n\n## Part\n\nWords about item ${i}, see [[note-${(i * 7) % 400}]].\n`,
      );
    }
    await pass();
    const times: number[] = [];
    for (let i = 0; i < 5; i++) times.push((await pass()).ms);
    const best = Math.min(...times);
    console.log(
      `no-change pass over ${(await stores.notes.listNotes()).length} notes: ${times.join(', ')} ms`,
    );
    expect(best).toBeLessThan(100);
  });
});
