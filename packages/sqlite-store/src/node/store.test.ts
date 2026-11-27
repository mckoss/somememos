import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markdown, storage } from '@somememos/core';
import { describeStorageConformance, expectScoresClose } from '@somememos/core/testing/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateBrain } from '@somememos/core/testing/brain';
import { EVENTS_SCHEMA_VERSION } from '../schema.js';
import { open } from './database.js';
import { type OpenSqliteFilesOptions, type SqliteFileStores, openSqliteFiles } from './files.js';

/** The two files in `dir`, as the CLI lays them out. */
function filesIn(dir: string): { eventsPath: string; indexPath: string } {
  return { eventsPath: join(dir, 'events.sqlite'), indexPath: join(dir, 'index.sqlite') };
}

function openBrainStores(
  dir: string,
  options: Omit<OpenSqliteFilesOptions, 'eventsPath' | 'indexPath'> = {},
): SqliteFileStores {
  mkdirSync(dir, { recursive: true });
  return openSqliteFiles({ ...filesIn(dir), ...options });
}

// The conformance suite, against SQLite with the node:sqlite driver (fresh
// temp files per open) and, for comparison, the in-memory reference.
describeStorageConformance('sqlite (node:sqlite)', () => {
  const dirs: string[] = [];
  const dirOf = new Map<storage.Stores, string>();
  return {
    open(options) {
      const dir = mkdtempSync(join(tmpdir(), 'somememos-store-'));
      dirs.push(dir);
      const stores = openBrainStores(dir, options);
      dirOf.set(stores, dir);
      return stores;
    },
    reopen(stores, options) {
      const dir = dirOf.get(stores) as string;
      const again = openBrainStores(dir, options);
      dirOf.set(again, dir);
      return again;
    },
    dispose() {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    },
  };
});

describeStorageConformance('memory (from sqlite-store)', () => ({
  open: (options) => storage.createMemoryStores(options),
  reopen: (stores, options) =>
    storage.createMemoryStores({ ...options, data: (stores as storage.MemoryStores).data }),
}));

describe('openSqliteFiles', () => {
  let dir: string;
  const opened: SqliteFileStores[] = [];
  const openHere = (options?: Parameters<typeof openBrainStores>[1]): SqliteFileStores => {
    const s = openBrainStores(dir, options);
    opened.push(s);
    return s;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'somememos-brain-'));
  });
  afterEach(() => {
    for (const s of opened.splice(0)) s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the two files', () => {
    const s = openHere();
    const paths = filesIn(dir);
    expect(s.eventsPath).toBe(paths.eventsPath);
    expect(existsSync(paths.eventsPath)).toBe(true);
    expect(existsSync(paths.indexPath)).toBe(true);
    expect(s.indexCreated).toBe(true);
    s.close();
    expect(openHere().indexCreated).toBe(false);
  });

  it('rebuilds the same scores after index.sqlite is deleted', async () => {
    let s = openHere();
    const events: storage.LogInput[] = [];
    const brain = generateBrain({ seed: 7, steps: 40 });
    brain.steps.forEach((step, i) => {
      for (const path of [...step.truth.created, ...step.truth.edited]) {
        events.push({
          id: `s${i}-${path}`,
          kind: 'edit',
          item: path,
          time: step.time,
          client: 'c',
        });
      }
      step.truth.linksAdded.forEach((link, j) => {
        const item = link.resolvedPath ?? markdown.normalizeDanglingKey(link.target);
        events.push({ id: `m${i}-${j}`, kind: 'mention', item, time: step.time, client: 'c' });
      });
      for (const r of step.truth.renamed) {
        events.push({
          id: `r${i}-${r.from}`,
          kind: 'rename',
          item: r.from,
          to: r.to,
          time: step.time,
          client: 'c',
        });
      }
    });
    // Append in several batches, folding as we go.
    for (let i = 0; i < events.length; i += 17) {
      await s.events.append(events.slice(i, i + 17));
      await storage.foldPending(s.events, s.scores, { batchSize: 9 });
    }
    const incremental = await s.scores.getAll();
    expect(incremental.size).toBeGreaterThan(5);
    s.close();

    unlinkSync(s.indexPath);
    s = openHere();
    expect(s.indexCreated).toBe(true);
    expect((await s.scores.foldState()).cursor).toBe(0);
    await storage.foldPending(s.events, s.scores);
    expectScoresClose(await s.scores.getAll(), incremental);
  });

  it('drops and recreates index.sqlite tables on a schema version change', async () => {
    let s = openHere();
    await s.notes.upsertNote({
      path: 'memos/a.md',
      title: 'A',
      contentHash: 'h',
      mtime: 1,
      role: 'memo',
      date: null,
    });
    await s.events.append([{ id: 'e', kind: 'read', item: 'memos/a.md', time: 1, client: 'c' }]);
    s.close();
    const db = open(s.indexPath);
    db.run(`UPDATE meta SET value = '0' WHERE key = 'schema_version'`);
    db.exec(`CREATE TABLE leftover (x INTEGER)`);
    db.close();

    s = openHere();
    expect(s.indexCreated).toBe(true);
    expect(await s.notes.listNotes()).toEqual([]);
    expect(await s.events.lastSeq()).toBe(1);
    const check = open(s.indexPath);
    const tables = check.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table'`,
    );
    check.close();
    expect(tables.map((t) => t.name)).not.toContain('leftover');
  });

  it('refuses an events.sqlite with another schema version, changing nothing', async () => {
    let s = openHere();
    await s.events.append([{ id: 'e', kind: 'read', item: 'memos/a.md', time: 1, client: 'c' }]);
    s.close();
    const db = open(s.eventsPath);
    db.run(`UPDATE meta SET value = '99' WHERE key = 'schema_version'`);
    db.close();

    expect(() => openHere()).toThrow(storage.MigrationRequiredError);
    expect(() => openHere()).toThrow(/migration is required/);
    const after = open(s.eventsPath);
    expect(after.get<{ n: number }>(`SELECT count(*) AS n FROM events`)?.n).toBe(1);
    after.run(`UPDATE meta SET value = :v WHERE key = 'schema_version'`, {
      v: String(EVENTS_SCHEMA_VERSION),
    });
    after.close();
    s = openHere();
    expect(await s.events.lastSeq()).toBe(1);
  });

  it('refuses an events.sqlite that is not an event log', () => {
    const { eventsPath } = filesIn(dir);
    const db = open(eventsPath);
    db.exec(`CREATE TABLE something (x INTEGER)`);
    db.close();
    expect(() => openHere()).toThrow(/not a somememos event log/);
  });

  it('stores positions compactly', async () => {
    const s = openHere();
    await s.terms.replaceSections('memos/a.md', 'Lantern', [
      { heading: null, body: Array.from({ length: 50 }, () => 'harbor').join(' ') },
    ]);
    s.close();
    const db = open(s.indexPath);
    const row = db.get<{ n: number }>(
      `SELECT length(positions) AS n FROM postings WHERE term = 'harbor'`,
    );
    db.close();
    expect(row?.n).toBe(50);
  });
});
