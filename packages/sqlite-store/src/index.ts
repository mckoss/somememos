// @somememos/sqlite-store: core's storage interfaces (and a table-backed
// ContentStore) over SQLite, written against a small synchronous driver
// interface so the same code runs in the CLI (`node:sqlite`, see
// `@somememos/sqlite-store/node`) and in the browser (SQLite WebAssembly in a
// worker). Isomorphic: this entry point imports no Node built-ins.

export type {
  SqlDriver,
  SqlParams,
  SqlRow,
  SqlRunResult,
  SqlStatement,
  SqlValue,
} from './driver.js';
export {
  type SqliteContentStoreOptions,
  type SqliteStores,
  type SqliteStoresOptions,
  createSqliteContentStore,
  createSqliteStores,
} from './stores.js';
export { EVENTS_SCHEMA_VERSION, INDEX_SCHEMA_VERSION } from './schema.js';
