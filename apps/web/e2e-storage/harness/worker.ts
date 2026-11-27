// The harness worker: registers the conformance suites against the browser
// SQLite driver on OPFS (`opfs-sahpool`), and runs them one test at a time on
// request from the page (./main.ts). Also probes the SAH pool's exclusive
// access for the "second worker can't take the files, and wipes nothing" test.

import sqlite3InitModule, { type SAHPoolUtil } from '@sqlite.org/sqlite-wasm';
import { storage } from '@somememos/core';
import { describeEngineConformance } from '@somememos/core/testing/engine';
import { describeStorageConformance } from '@somememos/core/testing/storage';
import { createSqliteContentStore, createSqliteStores } from '@somememos/sqlite-store';
import { installSahPool, tuneForDevice } from '#lib/brain/databases.ts';
import { openOo1Database, type Oo1Driver } from '#lib/brain/sqlite-driver.ts';
import { describeDriverConformance } from '#lib/brain/sqlite-driver.testing.ts';
import { listTests, runTest } from './vitest-shim.ts';

export type HarnessRequest =
  | { cmd: 'list' }
  | { cmd: 'run'; id: number }
  | { cmd: 'info' }
  | { cmd: 'hold'; value: string }
  | { cmd: 'read' }
  | { cmd: 'try-open'; busyWaitMs: number };

// Listen first: a message that arrives while the module is still awaiting
// (below) would otherwise be dropped.
type Incoming = MessageEvent<{ id: number; request: HarnessRequest }>;
const inbox: Incoming[] = [];
let listening = false;
self.onmessage = (event: Incoming) => {
  if (listening) void deliver(event);
  else inbox.push(event);
};

const sqlite3 = await sqlite3InitModule();
const role = (self as unknown as { name?: string }).name === 'probe' ? 'probe' : 'suites';

let pool: SAHPoolUtil | undefined;
let vfs = '';

async function suitesPool(): Promise<void> {
  pool = await installSahPool(sqlite3, { directory: '.harness-sahpool', capacity: 48 });
  await pool.wipeFiles();
  vfs = pool.vfsName;
}

let seq = 0;
const unlinkUnder = (base: string): void => {
  for (const name of pool?.getFileNames() ?? []) {
    if (name.startsWith(`${base}/`)) pool?.unlink(name);
  }
};
// The same settings as the app's databases on the device.
const db = (path: string): Oo1Driver => tuneForDevice(openOo1Database(sqlite3, path, { vfs }));
/** Keeps room in the pool for two more databases and their journals. */
async function roomForTwo(): Promise<void> {
  if (!pool) return;
  const free = Number(pool.getCapacity()) - Number(pool.getFileCount());
  if (free < 8) await pool.addCapacity(16);
}

function registerSuites(): void {
  describeDriverConformance('oo1 on OPFS (opfs-sahpool)', {
    open: async () => {
      await roomForTwo();
      return db(`/d${++seq}/db.sqlite`);
    },
    reopen: (driver) => db(driver.location),
    dispose: () => {
      for (const name of pool?.getFileNames() ?? []) if (/^\/d\d+\//.test(name)) pool?.unlink(name);
    },
  });

  describeStorageConformance('sqlite-wasm on OPFS (opfs-sahpool)', () => {
    const bases = new Map<storage.Stores, string>();
    const used: string[] = [];
    const openAt = (base: string, options: storage.StoresOptions = {}) => {
      const stores = createSqliteStores({
        events: db(`${base}/events.sqlite`),
        index: db(`${base}/index.sqlite`),
        ...options,
      });
      bases.set(stores, base);
      return stores;
    };
    return {
      async open(options) {
        await roomForTwo();
        const base = `/s${++seq}`;
        used.push(base);
        return openAt(base, options);
      },
      reopen(stores, options) {
        return openAt(bases.get(stores) as string, options);
      },
      dispose() {
        for (const base of used) unlinkUnder(base);
      },
    };
  });

  describeEngineConformance('sqlite-wasm on OPFS, content table', async ({ now, analyzer }) => {
    await roomForTwo();
    const base = `/e${++seq}`;
    const events = db(`${base}/events.sqlite`);
    const stores = createSqliteStores({
      events,
      index: db(`${base}/index.sqlite`),
      now,
      ...(analyzer ? { analyzer } : {}),
    });
    return {
      stores,
      content: createSqliteContentStore(events, { now }),
      dispose: () => unlinkUnder(base),
    };
  });

  // The in-memory reference implementation through the same shim: if it
  // passes everything, a failure above is the driver's, not the shim's.
  describeStorageConformance('memory reference (checks the vitest shim)', () => ({
    open: (options) => storage.createMemoryStores(options),
    reopen: (stores, options) =>
      storage.createMemoryStores({ ...options, data: (stores as storage.MemoryStores).data }),
  }));
  describeEngineConformance('memory reference (checks the vitest shim)', ({ now }) => ({
    stores: storage.createMemoryStores({ now }),
    content: storage.createMemoryContentStore({ now }),
  }));
}

// --- The exclusive-access probe (role=probe): its own pool directory.
const PROBE_DIR = '.harness-probe-sahpool';
let held: Oo1Driver | undefined;

async function handle(request: HarnessRequest): Promise<unknown> {
  switch (request.cmd) {
    case 'list':
      return listTests();
    case 'run':
      return runTest(request.id);
    case 'info':
      return { sqlite: sqlite3.version.libVersion, vfs };
    case 'hold': {
      const p = await installSahPool(sqlite3, { directory: PROBE_DIR, busyWaitMs: 0 });
      held = openOo1Database(sqlite3, '/probe/db.sqlite', { vfs: p.vfsName });
      held.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
      held
        .prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (:k, :v)')
        .run({ k: 'x', v: request.value });
      return true;
    }
    case 'read':
      return held?.prepare('SELECT v FROM kv WHERE k = :k').get({ k: 'x' }) ?? null;
    case 'try-open': {
      try {
        const p = await installSahPool(sqlite3, {
          directory: PROBE_DIR,
          busyWaitMs: request.busyWaitMs,
        });
        held = openOo1Database(sqlite3, '/probe/db.sqlite', { vfs: p.vfsName });
        return { ok: true };
      } catch (error) {
        return { ok: false, name: (error as Error).name, message: (error as Error).message };
      }
    }
  }
}

const ready = role === 'suites' ? suitesPool().then(registerSuites) : Promise.resolve();

async function deliver(event: Incoming): Promise<void> {
  const { id, request } = event.data;
  try {
    await ready;
    self.postMessage({ id, ok: true, value: await handle(request) });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: `${(error as Error).name}: ${(error as Error).message}`,
    });
  }
}

listening = true;
for (const event of inbox.splice(0)) void deliver(event);
