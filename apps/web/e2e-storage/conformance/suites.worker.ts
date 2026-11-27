// The dedicated worker behind ./opfs.test.ts: registers the shared
// conformance suites (and the driver tests) against the browser SQLite driver
// on OPFS (`opfs-sahpool`, the app's settings), and runs them with Vitest's
// own runner and `expect`, here in the worker, where the SAH pool's sync
// access handles exist. The test file in the page mirrors each test and
// reports its result.
//
// Messages (all answered with the same `id`):
//   { cmd: 'collect', config } → the tests, in run order
//   { cmd: 'run' }             → runs them; posts { result } as each finishes
//   { cmd: 'info' }            → the SQLite build, the VFS, the worker scope

import sqlite3InitModule, { type SAHPoolUtil } from '@sqlite.org/sqlite-wasm';
import { describeEngineConformance } from '@somememos/core/testing/engine';
import { describeStorageConformance } from '@somememos/core/testing/storage';
import { createSqliteContentStore, createSqliteStores } from '@somememos/sqlite-store';
import type { storage } from '@somememos/core';
import type { RunnerTask, SerializedConfig, VitestTestRunner } from 'vitest';
import { collectTests, startTests } from 'vitest/internal/browser';
import { installSahPool, tuneForDevice } from '#lib/brain/databases.ts';
import { openOo1Database, type Oo1Driver } from '#lib/brain/sqlite-driver.ts';
import { describeDriverConformance } from '#lib/brain/sqlite-driver.testing.ts';
import type {
  Collected,
  Info,
  Listed,
  Outcome,
  Ran,
  TestError,
  WorkerReply,
  WorkerRequest,
} from './protocol.ts';

/** The one "file" the runner collects: its tests come from `register`. */
const FILE = 'opfs-conformance';

// Listen first: a message that arrives while the module is still awaiting
// (below) would otherwise be dropped.
type Incoming = MessageEvent<{ id: number; request: WorkerRequest }>;
const inbox: Incoming[] = [];
let listening = false;
self.onmessage = (event: Incoming) => {
  if (listening) void deliver(event);
  else inbox.push(event);
};

const sqlite3 = await sqlite3InitModule();
const pool: SAHPoolUtil = await installSahPool(sqlite3, {
  directory: '.conformance-sahpool',
  capacity: 48,
});
await pool.wipeFiles();
const vfs = pool.vfsName;

let seq = 0;
const unlinkUnder = (base: string): void => {
  for (const name of pool.getFileNames()) if (name.startsWith(`${base}/`)) pool.unlink(name);
};
// The same settings as the app's databases on the device.
const db = (path: string): Oo1Driver => tuneForDevice(openOo1Database(sqlite3, path, { vfs }));
/** Keeps room in the pool for two more databases and their journals. */
async function roomForTwo(): Promise<void> {
  const free = Number(pool.getCapacity()) - Number(pool.getFileCount());
  if (free < 8) await pool.addCapacity(16);
}

/** Registers every suite; the runner calls it while collecting. */
function register(): void {
  describeDriverConformance('oo1 on OPFS (opfs-sahpool)', {
    open: async () => {
      await roomForTwo();
      return db(`/d${++seq}/db.sqlite`);
    },
    reopen: (driver) => db(driver.location),
    dispose: () => {
      for (const name of pool.getFileNames()) if (/^\/d\d+\//.test(name)) pool.unlink(name);
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
}

// --- Vitest's own runner, driven from here. It needs only the page's
// serialized config and an `importFile` that registers the suites.
let config: SerializedConfig | undefined;
let notify: ((outcome: Outcome) => void) | undefined;

const runner = (): VitestTestRunner => ({
  config: config as SerializedConfig,
  importFile: (_path, source) => {
    if (source === 'collect') register();
  },
  onAfterRunTask: (test) => {
    notify?.({
      id: test.id,
      state: test.result?.state ?? 'skip',
      ms: Math.round(test.result?.duration ?? 0),
      errors: test.result?.errors ?? [],
    });
  },
});

function flatten(suite: RunnerTask, path: string[], out: Listed[]): void {
  for (const child of suite.type === 'suite' ? suite.tasks : []) {
    if (child.type === 'suite') flatten(child, [...path, child.name], out);
    else out.push({ id: child.id, path, name: child.name, mode: child.mode });
  }
}

/** Errors outside any test: a suite that failed to collect, or a hook that threw. */
function suiteErrors(task: RunnerTask, out: TestError[] = []): TestError[] {
  if (task.type !== 'suite') return out;
  out.push(...(task.result?.errors ?? []));
  for (const child of task.tasks) suiteErrors(child, out);
  return out;
}

async function handle(request: WorkerRequest, reply: (r: WorkerReply) => void): Promise<unknown> {
  switch (request.cmd) {
    case 'collect': {
      config = request.config;
      const [file] = await collectTests([FILE], runner());
      const tests: Listed[] = [];
      if (file) flatten(file, [], tests);
      return { tests, errors: file ? suiteErrors(file) : [] } satisfies Collected;
    }
    case 'run': {
      notify = (outcome) => reply({ result: outcome });
      try {
        const [file] = await startTests([FILE], runner());
        return { errors: file ? suiteErrors(file) : [] } satisfies Ran;
      } finally {
        notify = undefined;
      }
    }
    case 'info': {
      // (Not in the DOM typings this project compiles against.)
      const scope = (globalThis as { DedicatedWorkerGlobalScope?: new () => unknown })
        .DedicatedWorkerGlobalScope;
      return {
        sqlite: sqlite3.version.libVersion,
        vfs,
        dedicatedWorker: scope !== undefined && self instanceof scope,
      } satisfies Info;
    }
  }
}

async function deliver(event: Incoming): Promise<void> {
  const { id, request } = event.data;
  const reply = (r: WorkerReply) => self.postMessage({ id, ...r });
  try {
    reply({ done: true, value: await handle(request, reply) });
  } catch (error) {
    reply({ done: true, error: `${(error as Error).name}: ${(error as Error).message}` });
  }
}

listening = true;
for (const event of inbox.splice(0)) void deliver(event);
