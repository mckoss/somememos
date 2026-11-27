// The CLI's local store: core's storage interfaces over two SQLite files in
// `<brain>/.somememos/` (events.sqlite: original data; index.sqlite: derived),
// plus the brain's config file.

export {
  type BrainStores,
  EVENTS_FILE,
  INDEX_FILE,
  type OpenBrainStoresOptions,
  SIDECAR_DIR,
  brainPaths,
  openBrainStores,
} from './open.js';
export {
  CONFIG_FILE,
  ConfigNotFoundError,
  type WriteDefaultConfigOptions,
  configPath,
  loadBrainConfig,
  writeDefaultConfig,
} from './config.js';
export { EVENTS_SCHEMA_VERSION, INDEX_SCHEMA_VERSION } from './schema.js';
