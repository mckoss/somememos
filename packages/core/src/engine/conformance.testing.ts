// The engine conformance suite. Every host of the engine runs it with its own
// stores and content: memory (core), SQLite with the node:sqlite driver
// (@somememos/sqlite-store), and SQLite WebAssembly in a real browser (M2).
//
//   import { describeEngineConformance } from '@somememos/core/testing/engine';
//   describeEngineConformance('sqlite', ({ now }) => ({ stores, content, dispose }));
//
// Test-only (imports vitest): excluded from core's built `dist` and exported
// only under the `source` condition. All note text is invented; the replay
// uses the synthetic brain generator.

import { afterEach, describe, expect, it } from 'vitest';
import * as markdown from '../markdown/index.js';
import { parseBrainConfig, type BrainConfig } from '../storage/config.js';
import { expectScoresClose } from '../storage/conformance.testing.js';
import type { ContentStore } from '../storage/content.js';
import type { Awaitable, LogEntry, Stores, StoresOptions } from '../storage/types.js';
import {
  filesAfter,
  generateBrain,
  roleOf,
  type Step,
  type SyntheticBrain,
} from '../testing/brain.js';
import { createEngine } from './engine.js';
import { EngineError, type ResultView } from './types.js';

/** What a host provides for one test: fresh, empty stores and content. */
export interface EngineHost {
  readonly stores: Stores;
  readonly content: ContentStore;
  /** Releases what `open` made (the suite closes `stores` first). */
  dispose?(): Awaitable<void>;
}

/** Opens fresh stores (with `options`, which carries the clock) and an empty content store. */
export type EngineHostFactory = (
  options: StoresOptions & { readonly now: () => number },
) => Awaitable<EngineHost>;

export interface EngineConformanceOptions {
  /** Per-test timeout in ms. Default 60000. */
  readonly timeout?: number;
  /** Synthetic brain seeds to replay. Default [1, 7]. */
  readonly seeds?: readonly number[];
}

const ROLES: markdown.FolderRolesConfig = {
  memo: ['memos/'],
  dated: ['diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md'],
  source: ['sources/'],
  excluded: ['private/'],
};

const T = 1_800_000_000;

function configWith(roles: markdown.FolderRolesConfig = ROLES): BrainConfig {
  return parseBrainConfig({ clientId: 'conformance-client', roles });
}

/** Survives JSON unchanged: what crosses a worker boundary. */
function expectJsonSafe(value: unknown): void {
  expect(JSON.parse(JSON.stringify(value))).toStrictEqual(value);
}

type Entry = { kind: string; item: string; to?: string; time: number };

function sortEntries(list: Entry[]): Entry[] {
  return [...list].sort((a, b) =>
    `${a.kind}\0${a.item}\0${a.to ?? ''}\0${a.time}` <
    `${b.kind}\0${b.item}\0${b.to ?? ''}\0${b.time}`
      ? -1
      : 1,
  );
}

const asEntry = (e: LogEntry): Entry =>
  e.kind === 'rename'
    ? { kind: e.kind, item: e.item, to: e.to, time: e.time }
    : { kind: e.kind, item: e.item, time: e.time };

// --- Ground truth for the replay (the same model as the CLI's synthetic test).

const visible = (files: Map<string, string>) =>
  [...files.keys()].filter((p) => roleOf(p) !== 'excluded');

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
    if (before.get(path) === after.get(path)) continue;
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

/**
 * Registers the engine conformance tests. `factory` is called for every test
 * (sometimes twice, for a second brain) and must return empty stores and an
 * empty content store.
 */
export function describeEngineConformance(
  name: string,
  factory: EngineHostFactory,
  options: EngineConformanceOptions = {},
): void {
  const timeout = options.timeout ?? 60_000;
  const seeds = options.seeds ?? [1, 7];

  describe(`engine conformance: ${name}`, () => {
    const hosts: EngineHost[] = [];
    afterEach(async () => {
      for (const host of hosts.splice(0)) {
        await host.stores.close();
        await host.dispose?.();
      }
    });

    /** A fresh brain: host, engine, and a settable clock. */
    const brain = async (config = configWith()) => {
      let now = T;
      const clock = () => now;
      const host = await factory({ now: clock, analyzer: config.analyzer });
      hosts.push(host);
      const engine = createEngine({
        stores: host.stores,
        content: host.content,
        config,
        now: clock,
      });
      return {
        ...host,
        engine,
        config,
        setNow(t: number) {
          now = t;
        },
        tick(seconds = 60) {
          now += seconds;
          return now;
        },
        /** Every log entry, without seq and id. */
        async entries(): Promise<Entry[]> {
          return (await host.stores.events.readAfter(0)).map(asEntry);
        },
      };
    };

    const code = async (promise: Promise<unknown>): Promise<string> => {
      try {
        await promise;
      } catch (error) {
        expect(error).toBeInstanceOf(EngineError);
        expectJsonSafe((error as EngineError).toJSON());
        return (error as EngineError).code;
      }
      throw new Error('expected an EngineError');
    };

    it('takes a baseline that logs nothing, then has nothing to do', { timeout }, async () => {
      const b = await brain();
      await b.content.write('memos/kettle.md', '# Kettle\n\nSee [[teapot]].\n', { mtime: T - 100 });
      await b.content.write('memos/teapot.md', '# Teapot\n', { mtime: T - 100 });
      const first = await b.engine.index();
      expectJsonSafe(first);
      expect(first).toMatchObject({ baseline: true, scanned: 2, indexed: 2, changed: [] });
      expect(first.events).toEqual({ edit: 0, mention: 0, rename: 0 });
      const second = await b.engine.index();
      expect(second).toMatchObject({ baseline: false, indexed: 0, removed: 0 });
      expect(await b.entries()).toEqual([]);
      expect((await b.engine.status()).firstIndexedAt).toBe(T);
    });

    it('saves a new note: an edit, its mentions, and a change record', { timeout }, async () => {
      const b = await brain();
      await b.engine.index();
      b.tick();
      const text = '# Lantern\n\nLit by [[wick]] and [[memos/oil]].\r\n\nUnicode: café ✓\n';
      const saved = await b.engine.saveNote('memos/lantern.md', text, {
        message: 'ingest lantern notes',
      });
      expectJsonSafe(saved);
      expect(saved.status).toBe('saved');
      if (saved.status !== 'saved') return;
      expect(saved.created).toBe(true);
      expect(saved.change).toMatchObject({
        message: 'ingest lantern notes',
        op: 'ingest',
        paths: ['memos/lantern.md'],
        client: 'conformance-client',
        time: T + 60,
      });
      expect(sortEntries(await b.entries())).toEqual(
        sortEntries([
          { kind: 'edit', item: 'memos/lantern.md', time: T + 60 },
          { kind: 'mention', item: 'wick', time: T + 60 },
          { kind: 'mention', item: 'memos/oil', time: T + 60 },
        ]),
      );
      expect((await b.engine.status()).uncommitted).toEqual([]);

      const note = await b.engine.readNote('memos/lantern.md', { record: false });
      expectJsonSafe(note);
      expect(note.text).toBe(text);
      expect(note.hash).toBe(saved.hash);
      expect(note).toMatchObject({ title: 'Lantern', role: 'memo', date: null, recorded: false });
      expect(note.links).toEqual([
        { target: 'memos/oil', dangling: true },
        { target: 'wick', dangling: true },
      ]);
      expect(note.sections.length).toBeGreaterThan(0);
      expect(await b.engine.danglingLinks()).toEqual([
        { key: 'memos/oil', count: 1 },
        { key: 'wick', count: 1 },
      ]);
    });

    it(
      'logs a read for a memo only, and refuses excluded and missing paths',
      { timeout },
      async () => {
        const b = await brain();
        await b.content.write('memos/a.md', '# A\n', { mtime: T - 10 });
        await b.content.write('sources/s.md', '# S\n', { mtime: T - 10 });
        await b.content.write('private/secret.md', '# Hidden\n', { mtime: T - 10 });
        await b.engine.index();
        const read = await b.engine.readNote('memos/a.md');
        expect(read.recorded).toBe(true);
        expect((await b.engine.readNote('sources/s.md')).recorded).toBe(false);
        expect((await b.engine.readNote('memos/a.md', { record: false })).recorded).toBe(false);
        expect((await b.engine.status()).events.read).toBe(1);
        expect(await code(b.engine.readNote('private/secret.md'))).toBe('excluded');
        expect(await code(b.engine.readNote('memos/none.md'))).toBe('not-found');
        expect(await code(b.engine.readNote('../outside.md'))).toBe('invalid-path');
        expect(await code(b.engine.readNote('memos/a.txt'))).toBe('invalid-path');
        // The read is folded: the note is hot.
        const hot = await b.engine.list('hot');
        expect(hot.results.map((r) => r.item)).toEqual(['memos/a.md']);
      },
    );

    it(
      'scores blog posts like memos, dates them from the path, and reads their publish state',
      { timeout },
      async () => {
        const b = await brain(configWith({ ...ROLES, blog: markdown.DEFAULT_FOLDER_ROLES.blog }));
        await b.content.write('memos/loom.md', '# Loom\n', { mtime: T - 10 });
        await b.engine.index();
        b.tick();
        const draft = '# Weaving notes\n\nWarp and weft on the [[loom]].\n';
        const live = '---\ntitle: Dye pots\npublished: true\n---\n\nIndigo dye pots.\n';
        await b.engine.saveNote('blog/2027/2027-03-04-weaving.md', draft);
        await b.engine.saveNote('blog/about.md', live);
        const entries = await b.entries();
        expect(entries).toContainEqual({
          kind: 'edit',
          item: 'blog/2027/2027-03-04-weaving.md',
          time: T + 60,
        });
        expect(entries).toContainEqual({ kind: 'edit', item: 'blog/about.md', time: T + 60 });
        expect(entries).toContainEqual({ kind: 'mention', item: 'memos/loom.md', time: T + 60 });

        const dated = await b.engine.readNote('blog/2027/2027-03-04-weaving.md');
        expect(dated).toMatchObject({
          role: 'blog',
          date: '2027-03-04',
          published: false,
          recorded: true,
        });
        const undated = await b.engine.readNote('blog/about.md', { record: false });
        expect(undated).toMatchObject({ role: 'blog', date: null, published: true });
        expect((await b.engine.readNote('memos/loom.md', { record: false })).published).toBe(null);
        expect((await b.engine.status()).notes).toMatchObject({ total: 3, memo: 1, blog: 2 });

        const hot = await b.engine.list('hot');
        expect(hot.results.map((r) => r.item)).toContain('blog/2027/2027-03-04-weaving.md');
        const post = hot.results.find((r) => r.item === 'blog/about.md');
        expect(post).toMatchObject({ role: 'blog', published: true, date: null });
        expect(hot.results.find((r) => r.item === 'memos/loom.md')?.published).toBeNull();
        const inMarch = await b.engine.search('weft', { since: '2027-03-01' });
        expect(inMarch.results.map((r) => r.path)).toEqual(['blog/2027/2027-03-04-weaving.md']);
        const titles = await b.engine.noteTitles();
        expect(titles.find((t) => t.path === 'blog/about.md')).toEqual({
          path: 'blog/about.md',
          title: 'Dye pots',
          role: 'blog',
          date: null,
          published: true,
        });
      },
    );

    it(
      'rejects a stale base hash with the current version, and skips an unchanged save',
      { timeout },
      async () => {
        const b = await brain();
        await b.engine.index();
        const first = await b.engine.saveNote('memos/plan.md', '# Plan\n\nv1\n', {
          baseHash: null,
        });
        expect(first.status).toBe('saved');
        const base = first.status === 'saved' ? first.hash : '';
        b.tick();
        const second = await b.engine.saveNote('memos/plan.md', '# Plan\n\nv2\n', {
          baseHash: base,
        });
        expect(second.status).toBe('saved');
        const stale = await b.engine.saveNote('memos/plan.md', '# Plan\n\nv3\n', {
          baseHash: base,
        });
        expectJsonSafe(stale);
        expect(stale).toMatchObject({
          status: 'conflict',
          baseHash: base,
          currentText: '# Plan\n\nv2\n',
        });
        const exists = await b.engine.saveNote('memos/plan.md', 'x', { baseHash: null });
        expect(exists.status).toBe('conflict');
        expect((await b.engine.readNote('memos/plan.md', { record: false })).text).toBe(
          '# Plan\n\nv2\n',
        );
        const changes = (await b.engine.log()).length;
        expect((await b.engine.saveNote('memos/plan.md', '# Plan\n\nv2\n')).status).toBe(
          'unchanged',
        );
        expect((await b.engine.log()).length).toBe(changes);
        expect((await b.engine.status()).events.edit).toBe(2);
      },
    );

    it('refuses excluded paths and changes to an existing source', { timeout }, async () => {
      const b = await brain();
      await b.engine.index();
      expect(await code(b.engine.saveNote('private/diary.md', 'secret'))).toBe('excluded');
      const created = await b.engine.saveNote('sources/paper.md', '# Paper\n\nOn [[kilns]].\n');
      expect(created.status).toBe('saved');
      expect(await code(b.engine.saveNote('sources/paper.md', '# Paper\n\nEdited.\n'))).toBe(
        'source-immutable',
      );
      // A source logs no edit and mentions nothing.
      expect(await b.entries()).toEqual([]);
      expect(await b.content.read('private/diary.md')).toBeUndefined();
    });

    it('carries a dangling link history over to the note created for it', { timeout }, async () => {
      const b = await brain();
      await b.engine.index();
      await b.engine.saveNote('memos/garden.md', '# Garden\n\nTry [[Compost Tea]].\n');
      b.tick();
      await b.engine.saveNote('memos/compost tea.md', '# Compost tea\n');
      const entries = await b.entries();
      expect(entries).toContainEqual({
        kind: 'rename',
        item: 'compost tea',
        to: 'memos/compost tea.md',
        time: T + 60,
      });
      const titles = await b.engine.noteTitles();
      expect(titles.map((t) => t.path)).toEqual(['memos/compost tea.md', 'memos/garden.md']);
      expect(await b.engine.danglingLinks()).toEqual([]);
      const tea = await b.engine.readNote('memos/compost tea.md', { record: false });
      expect(tea.backlinks).toEqual(['memos/garden.md']);
      // The key's mention now counts for the note.
      const hot = await b.engine.list('hot');
      expect(hot.results.map((r) => r.item)).toContain('memos/compost tea.md');
      expect(hot.results.map((r) => r.item)).not.toContain('compost tea');
    });

    it('renames and deletes notes, relinking the others', { timeout }, async () => {
      const b = await brain();
      await b.engine.index();
      await b.engine.saveNote('memos/old.md', '# Old\n');
      await b.engine.saveNote('memos/linker.md', '# Linker\n\n[[old]] and [[memos/new]].\n');
      b.tick();
      const renamed = await b.engine.renameNote('memos/old.md', 'memos/new.md', {
        message: 'update rename',
      });
      expectJsonSafe(renamed);
      expect(renamed.change.paths).toEqual(['memos/new.md', 'memos/old.md']);
      expect(await b.entries()).toContainEqual({
        kind: 'rename',
        item: 'memos/old.md',
        to: 'memos/new.md',
        time: T + 60,
      });
      expect((await b.engine.readNote('memos/new.md', { record: false })).backlinks).toEqual([
        'memos/linker.md',
      ]);
      expect(await code(b.engine.renameNote('memos/gone.md', 'memos/x.md'))).toBe('not-found');
      expect(await code(b.engine.renameNote('memos/new.md', 'memos/linker.md'))).toBe('exists');

      const deleted = await b.engine.deleteNote('memos/new.md', { message: 'lint drop' });
      expect(deleted.change).toMatchObject({ op: 'lint', paths: ['memos/new.md'] });
      expect(await code(b.engine.readNote('memos/new.md'))).toBe('not-found');
      expect(await code(b.engine.deleteNote('memos/new.md'))).toBe('not-found');
      expect((await b.engine.readNote('memos/linker.md', { record: false })).links).toEqual([
        { target: 'memos/new', dangling: true },
        { target: 'old', dangling: true },
      ]);
      // Scores stay with the deleted path; it is not listed.
      expect((await b.engine.list('hot')).results.map((r) => r.item)).not.toContain('memos/new.md');
    });

    it(
      'ignores attachment links and embeds, but not notes with dots in their names',
      { timeout },
      async () => {
        const b = await brain();
        await b.engine.index();
        await b.engine.saveNote('memos/node.js.md', '# Node\n');
        await b.engine.saveNote(
          'memos/album.md',
          '# Album\n\n![[photo.png]] [[scan.PDF|the scan]] [[v1.2]] [[node.js]] ![[drawing.excalidraw]]\n',
        );
        const album = await b.engine.readNote('memos/album.md', { record: false });
        expect(album.links).toEqual([
          { target: 'memos/node.js.md', dangling: false },
          { target: 'v1.2', dangling: true },
        ]);
        expect((await b.engine.danglingLinks()).map((d) => d.key)).toEqual(['v1.2']);
        const mentions = (await b.entries()).filter((e) => e.kind === 'mention').map((e) => e.item);
        expect(mentions.sort()).toEqual(['memos/node.js.md', 'v1.2']);
      },
    );

    it('leaves no trace of excluded notes, and drops links into them', { timeout }, async () => {
      const b = await brain();
      await b.content.write('private/plans.md', '# Surprise party\n\nconfetti\n', { mtime: T - 5 });
      await b.engine.index();
      await b.engine.saveNote(
        'memos/week.md',
        '# Week\n\n[[plans]] [[private/plans]] [[private/other]] confetti\n',
      );
      const week = await b.engine.readNote('memos/week.md', { record: false });
      expect(week.links).toEqual([]);
      expect(week.backlinks).toEqual([]);
      const results = await b.engine.search('confetti surprise party', { mode: 'all' });
      expect(results.results.map((r) => r.path)).toEqual(['memos/week.md']);
      const all = JSON.stringify([
        await b.engine.status(),
        results,
        await b.engine.danglingLinks(),
        await b.engine.noteTitles(),
        await b.engine.log({ all: true }),
        await b.engine.exportLog(),
        await b.engine.list('hot'),
      ]);
      expect(all).not.toContain('plans.md');
      expect(all).not.toContain('Surprise');
      expect((await b.engine.status()).events).toEqual({ read: 0, edit: 1, mention: 0, rename: 0 });
    });

    it(
      'searches every indexed role and lists memos and dangling items, with JSON-safe results',
      { timeout },
      async () => {
        const b = await brain();
        await b.content.write('memos/glaze.md', '# Glaze\n\nCeladon glaze on the [[kiln]].\n', {
          mtime: T - 100,
        });
        await b.content.write('diary/2027/01/2027-01-05.md', '# 2027-01-05\n\nMixed glaze.\n', {
          mtime: T - 100,
        });
        await b.content.write('diary/2027/02/2027-02-10.md', '# 2027-02-10\n\nFired glaze.\n', {
          mtime: T - 100,
        });
        await b.content.write('sources/glaze-book.md', '# Glaze book\n\nAbout glaze.\n', {
          mtime: T - 100,
        });
        await b.engine.index();
        b.tick();
        await b.engine.saveNote(
          'memos/glaze.md',
          '# Glaze\n\nCeladon glaze on the [[kiln]], with [[clay]].\n',
        );

        const all = await b.engine.search('glaze', { mode: 'all' });
        expectJsonSafe(all);
        expect(all).toMatchObject({ mode: 'all', query: 'glaze', at: T + 60 });
        expect(new Set(all.results.map((r) => r.role))).toEqual(
          new Set(['memo', 'dated', 'source']),
        );
        for (const r of all.results) {
          expect(r.snippet?.text ?? '').toMatch(/glaze/i);
          expect(r.sectionId).toMatch(/#\d+$/);
        }
        const hot = await b.engine.search('glaze', { mode: 'hot', limit: 2 });
        expect(hot.results).toHaveLength(2);
        expect(hot.results[0]?.path).toBe('memos/glaze.md');
        const top = hot.results[0] as ResultView;
        expect(top.components.kinds).toBeTypeOf('object');
        expect(top.now.activation.week).toBeGreaterThan(0);

        const january = await b.engine.search('glaze', {
          since: '2027-01-01',
          until: '2027-01-31',
        });
        expect(january.results.map((r) => r.path)).toEqual(['diary/2027/01/2027-01-05.md']);
        expect(
          (await b.engine.search('glaze', { since: '2027-02-01' })).results.map((r) => r.date),
        ).toEqual(['2027-02-10']);
        expect(await code(b.engine.search('glaze', { since: 'last week' }))).toBe(
          'invalid-argument',
        );
        expect(await code(b.engine.search('glaze', { mode: 'warm' as never }))).toBe(
          'invalid-argument',
        );

        for (const mode of ['hot', 'trending', 'neglected', 'all'] as const) {
          const list = await b.engine.list(mode);
          expectJsonSafe(list);
          for (const r of list.results) expect(r.role === 'memo' || r.dangling).toBe(true);
        }
        const hotList = await b.engine.list('hot');
        expect(hotList.results.find((r) => r.item === 'clay')).toMatchObject({
          dangling: true,
          path: null,
        });
        // Linked before the baseline and not added since: no mention, not listed.
        expect(hotList.results.find((r) => r.item === 'kiln')).toBeUndefined();
        expect((await b.engine.search('  ')).query).toBeNull();
        // Searching logs nothing.
        const before = (await b.engine.status()).events;
        await b.engine.search('glaze');
        expect((await b.engine.status()).events).toEqual(before);
      },
    );

    it(
      'commits changes made outside the engine, with paths and messages',
      { timeout },
      async () => {
        const b = await brain();
        await b.engine.index();
        b.tick();
        await b.content.write('memos/a.md', '# A\n', { mtime: T + 30 });
        await b.content.write('memos/b/c.md', '# C\n', { mtime: T + 30 });
        const partial = await b.engine.commit({ message: 'update a only', paths: ['memos/a.md'] });
        expectJsonSafe(partial);
        expect(partial).toMatchObject({ committed: true, remaining: ['memos/b/c.md'] });
        expect(partial.change?.paths).toEqual(['memos/a.md']);
        expect(partial.index.events.edit).toBe(2);
        const folder = await b.engine.commit({ paths: ['memos/b/'] });
        expect(folder.change).toMatchObject({ message: null, op: null, paths: ['memos/b/c.md'] });
        const none = await b.engine.commit({ message: 'nothing' });
        expect(none).toMatchObject({ committed: false, change: null, remaining: [] });
        expect((await b.engine.status()).uncommitted).toEqual([]);
      },
    );

    it(
      'shows the change log newest first, hiding dated-only changes unless asked',
      { timeout },
      async () => {
        const b = await brain();
        await b.engine.index();
        b.setNow(T + 100);
        await b.engine.saveNote('memos/a.md', '# A\n', { message: 'ingest first' });
        b.setNow(T + 200);
        const diary = await b.engine.ensureDiary('2027-03-04');
        expect(diary).toEqual({
          path: 'diary/2027/03/2027-03-04.md',
          date: '2027-03-04',
          created: true,
        });
        expect((await b.engine.ensureDiary('2027-03-04')).created).toBe(false);
        await b.engine.commit({ message: 'session diary' });
        b.setNow(T + 300);
        await b.engine.saveNote('memos/a.md', '# A\n\nMore.\n', { message: 'update more' });

        const log = await b.engine.log();
        expectJsonSafe(log);
        expect(log.map((c) => c.message)).toEqual(['update more', 'ingest first']);
        expect((await b.engine.log({ all: true })).map((c) => c.op)).toEqual([
          'update',
          'session',
          'ingest',
        ]);
        expect((await b.engine.log({ op: 'ingest' })).map((c) => c.time)).toEqual([T + 100]);
        expect(
          (await b.engine.log({ path: 'memos/a.md', limit: 1 })).map((c) => c.message),
        ).toEqual(['update more']);
        expect((await b.engine.log({ since: T + 150, until: T + 250, all: true })).length).toBe(1);
        expect(await b.engine.diaryPath('2027-03-04')).toEqual({
          path: 'diary/2027/03/2027-03-04.md',
          date: '2027-03-04',
        });
        expect(await code(b.engine.diaryPath('2027-02-30'))).toBe('invalid-argument');
      },
    );

    it('reports status, and has no diary without a dated pattern', { timeout }, async () => {
      const b = await brain();
      await b.content.write('memos/a.md', '# A\n\n[[b]]\n', { mtime: T - 5 });
      await b.engine.index();
      b.tick();
      await b.content.write('memos/a.md', '# A\n\n[[b]] [[c]]\n', { mtime: T + 30 });
      await b.engine.index();
      const status = await b.engine.status();
      expectJsonSafe(status);
      expect(status).toMatchObject({
        clientId: 'conformance-client',
        notes: { total: 1, memo: 1, dated: 0, source: 0 },
        dangling: 2,
        events: { edit: 1, mention: 1, read: 0, rename: 0 },
        changes: 0,
        uncommitted: ['memos/a.md'],
      });
      expect(status.fold.cursor).toBe(status.fold.lastSeq);

      const flat = await brain(configWith({}));
      expect(await code(flat.engine.diaryPath())).toBe('no-dated-pattern');
      expect(await code(flat.engine.ensureDiary())).toBe('no-dated-pattern');
    });

    it('exports and imports the log, idempotently, to the same scores', { timeout }, async () => {
      const a = await brain();
      await a.engine.index();
      await a.engine.saveNote('memos/x.md', '# X\n\n[[y]]\n', { message: 'ingest x' });
      a.tick(86_400);
      await a.engine.saveNote('memos/y.md', '# Y\n');
      await a.engine.readNote('memos/x.md');
      await a.engine.renameNote('memos/x.md', 'memos/z.md');
      const text = await a.engine.exportLog();
      const lines = text
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { type: string; time: number });
      expect(lines.map((l) => l.time)).toEqual([...lines.map((l) => l.time)].sort((p, q) => p - q));
      expect(new Set(lines.map((l) => l.type))).toEqual(new Set(['log', 'change']));

      const b = await brain();
      b.setNow(T + 86_400 * 2);
      const imported = await b.engine.importLog(text);
      expectJsonSafe(imported);
      expect(imported.log.appended).toBe(await a.stores.events.lastSeq());
      expect(imported.changes.appended).toBe((await a.engine.log({ all: true })).length);
      expect((await b.stores.events.readAfter(0)).map((e) => e.id)).toEqual(
        (await a.stores.events.readAfter(0)).map((e) => e.id),
      );
      expectScoresClose(await b.stores.scores.getAll(), await a.stores.scores.getAll());
      const again = await b.engine.importLog(text);
      expect(again.log).toEqual({ appended: 0, duplicates: imported.log.appended });
      expect(again.changes.appended).toBe(0);
      expect(await code(b.engine.importLog('not json\n'))).toBe('invalid-argument');
    });

    it('rebuilds to the same scores and index', { timeout }, async () => {
      const b = await brain();
      await b.engine.index();
      for (let i = 0; i < 5; i++) {
        b.tick(3_600);
        await b.engine.saveNote(`memos/n${i}.md`, `# N${i}\n\n[[n${i + 1}]] glaze ${i}\n`);
      }
      const scores = await b.stores.scores.getAll();
      const stats = await b.stores.terms.statistics();
      const rebuilt = await b.engine.index({ rebuild: true });
      expect(rebuilt).toMatchObject({ rebuilt: true, events: { edit: 0, mention: 0, rename: 0 } });
      expectScoresClose(await b.stores.scores.getAll(), scores);
      expect(await b.stores.terms.statistics()).toEqual(stats);
    });

    it('serializes concurrent calls', { timeout }, async () => {
      const b = await brain();
      await b.engine.index();
      const saves = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          b.engine.saveNote(`memos/p${i}.md`, `# P${i}\n\n[[p${(i + 1) % 8}]]\n`),
        ),
      );
      expect(saves.map((s) => s.status)).toEqual(Array(8).fill('saved'));
      expect((await b.engine.status()).notes.total).toBe(8);
      expect(await b.engine.danglingLinks()).toEqual([]);
    });

    describe.each(seeds)('replaying the synthetic brain (seed %i)', (seed) => {
      it('logs what the ground truth says, step by step', { timeout }, async () => {
        const synthetic = generateBrain({ seed, steps: 40 });
        const b = await brain();
        let logged = 0;
        for (const step of synthetic.steps) {
          b.setNow(step.time);
          const single = step.changes.length === 1 ? step.changes[0] : undefined;
          const viaEngine =
            single !== undefined &&
            roleOf(single.type === 'rename' ? single.from : single.path) !== 'excluded';
          if (step.index > 0 && viaEngine && single) {
            // One change: through the engine's own operations.
            if (single.type === 'write') {
              const r = await b.engine.saveNote(single.path, single.content, {
                message: step.message,
              });
              expect(['saved', 'unchanged']).toContain(r.status);
            } else if (single.type === 'rename') {
              await b.engine.renameNote(single.from, single.to, { message: step.message });
            } else {
              await b.engine.deleteNote(single.path, { message: step.message });
            }
          } else {
            for (const change of step.changes) {
              if (change.type === 'write')
                await b.content.write(change.path, change.content, { mtime: step.time });
              else if (change.type === 'rename') await b.content.rename(change.from, change.to);
              else await b.content.remove(change.path);
            }
            await b.engine.commit({ message: step.message });
          }
          const all = await b.stores.events.readAfter(0);
          const fresh = all.slice(logged).map(asEntry);
          logged = all.length;
          const expected = step.index === 0 ? [] : expectedFor(synthetic, step.index, step.time);
          expect(sortEntries(fresh), `step ${step.index}`).toEqual(expected);
        }
        const final = filesAfter(synthetic.steps);
        expect((await b.engine.noteTitles()).map((t) => t.path)).toEqual(visible(final).sort());
        expect((await b.engine.status()).uncommitted).toEqual([]);
        const scores = await b.stores.scores.getAll();
        await b.engine.index({ rebuild: true });
        expectScoresClose(await b.stores.scores.getAll(), scores);
        const dump = JSON.stringify(await b.engine.exportLog());
        expect(dump).not.toContain('private/');
      });
    });
  });
}
