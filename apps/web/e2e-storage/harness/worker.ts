// A probe worker for the SAH pool's exclusive access (../sah-pool.spec.ts):
// the second worker can't take the files, and wipes nothing trying. The
// conformance suites run elsewhere (../conformance, under Vitest).

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { installSahPool } from '#lib/brain/databases.ts';
import { openOo1Database, type Oo1Driver } from '#lib/brain/sqlite-driver.ts';

export type ProbeRequest =
  { cmd: 'hold'; value: string } | { cmd: 'read' } | { cmd: 'try-open'; busyWaitMs: number };

// Listen first: a message that arrives while the module is still awaiting
// (below) would otherwise be dropped.
type Incoming = MessageEvent<{ id: number; request: ProbeRequest }>;
const inbox: Incoming[] = [];
let listening = false;
self.onmessage = (event: Incoming) => {
  if (listening) void deliver(event);
  else inbox.push(event);
};

const sqlite3 = await sqlite3InitModule();

// Its own pool directory.
const PROBE_DIR = '.harness-probe-sahpool';
let held: Oo1Driver | undefined;

async function handle(request: ProbeRequest): Promise<unknown> {
  switch (request.cmd) {
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

async function deliver(event: Incoming): Promise<void> {
  const { id, request } = event.data;
  try {
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
