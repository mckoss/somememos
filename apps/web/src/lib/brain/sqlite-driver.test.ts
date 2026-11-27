// The browser driver's guarantees, checked in Node on SQLite WebAssembly's
// in-memory Node build. The same tests run in a real browser on OPFS
// (apps/web/e2e-storage).

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { openOo1Database } from './sqlite-driver.ts';
import { describeDriverConformance } from './sqlite-driver.testing.ts';

const sqlite3 = await sqlite3InitModule();

describeDriverConformance('oo1, in memory (Node)', {
  open: () => openOo1Database(sqlite3, ':memory:'),
});
