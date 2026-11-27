// Global setup for the sync end-to-end suite (playwright.sync.config.ts):
// Postgres, a fresh database, a data directory and the built server. The
// tests read SYNC_E2E_* from the environment; SYNC_E2E_SKIP says why they
// are skipped. Returns the teardown.

import {
  TEST_TOKEN,
  createDatabase,
  dropDatabase,
  localPostgresAvailable,
  newDataDir,
  removeDir,
  startLocalPostgres,
  startServer,
  stopLocalPostgres,
} from './sync-server.ts';

export default async function setup(): Promise<() => Promise<void>> {
  let adminUrl = process.env.SOMEMEMOS_TEST_DATABASE_URL || null;
  let pgDir: string | null = null;
  if (!adminUrl) {
    if (!localPostgresAvailable()) {
      const reason =
        'Sync end-to-end tests skipped: SOMEMEMOS_TEST_DATABASE_URL is not set and no local Postgres (initdb) was found.';
      process.env.SYNC_E2E_SKIP = reason;
      console.warn(reason);
      return async () => undefined;
    }
    const started = startLocalPostgres();
    adminUrl = started.url;
    pgDir = started.dir;
  }
  const databaseUrl = await createDatabase(adminUrl);
  const dataDir = newDataDir();
  const port = Number(process.env.SYNC_E2E_PORT);
  const server = await startServer({ port, databaseUrl, dataDir, token: TEST_TOKEN });
  process.env.SYNC_E2E_DATABASE_URL = databaseUrl;
  process.env.SYNC_E2E_DATA_DIR = dataDir;

  return async () => {
    await server.stop();
    await dropDatabase(adminUrl, databaseUrl).catch(() => undefined);
    removeDir(dataDir);
    if (pgDir) stopLocalPostgres(pgDir);
  };
}
