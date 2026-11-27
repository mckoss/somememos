// The real server for the sync end-to-end tests (playwright.sync.config.ts):
// a throwaway Postgres (packages/pg-store/scripts/dev-postgres.sh) or the one
// SOMEMEMOS_TEST_DATABASE_URL names (CI's service container), a fresh
// database in it, a temporary data directory for the brains' git
// repositories, and the built app (`node build`) on a free port.
//
// With neither the variable nor a local Postgres, the suite is skipped with a
// message (SYNC_E2E_SKIP), so `npm run check` passes on such a machine.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
export const WEB_DIR = join(here, '..');
const REPO = join(WEB_DIR, '..', '..');
const DEV_PG = join(REPO, 'packages/pg-store/scripts/dev-postgres.sh');
const STOP_PG = join(REPO, 'packages/pg-store/scripts/stop-dev-postgres.sh');

/** The token the test server accepts (invented; at least 24 characters). */
export const TEST_TOKEN = 'e2e-sync-token-4f1c9a7b2d6e8035';
/** A second one, for the test that changes the server's token. */
export const OTHER_TOKEN = 'e2e-sync-other-token-77aa31bc90de';

/** True when this machine can start a throwaway Postgres. */
export function localPostgresAvailable(): boolean {
  const onPath = spawnSync('sh', ['-c', 'command -v initdb'], { encoding: 'utf8' }).status === 0;
  const bin = process.env.PG_BIN ?? '/usr/lib/postgresql/16/bin';
  return onPath || existsSync(join(bin, 'initdb'));
}

/** Starts a throwaway cluster with the repository's script. */
export function startLocalPostgres(): { url: string; dir: string } {
  const out = spawnSync('bash', [DEV_PG], { encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`dev-postgres.sh failed:\n${out.stderr}`);
  const url = /SOMEMEMOS_TEST_DATABASE_URL=(\S+)/.exec(out.stdout)?.[1];
  const dir = /SOMEMEMOS_DEV_PG_DIR=(\S+)/.exec(out.stdout)?.[1];
  if (!url || !dir) throw new Error(`dev-postgres.sh printed no URL:\n${out.stdout}`);
  return { url, dir };
}

export function stopLocalPostgres(dir: string): void {
  spawnSync('bash', [STOP_PG, dir], { encoding: 'utf8' });
}

/** Creates a fresh database next to the one `url` names; returns its URL. */
export async function createDatabase(url: string): Promise<string> {
  const name = `somememos_e2e_${Math.random().toString(36).slice(2, 10)}`;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

export async function dropDatabase(adminUrl: string, url: string): Promise<void> {
  const name = new URL(url).pathname.slice(1);
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

export function newDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'somememos-e2e-sync-data-'));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  stop(): Promise<void>;
}

/** Starts the built app on `port` and waits until its API is ready. */
export async function startServer(options: {
  port: number;
  databaseUrl: string;
  dataDir: string;
  token: string;
}): Promise<RunningServer> {
  const child: ChildProcess = spawn(process.execPath, ['build'], {
    cwd: WEB_DIR,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(options.port),
      DATABASE_URL: options.databaseUrl,
      SOMEMEMOS_DATA_DIR: options.dataDir,
      SOMEMEMOS_TOKEN: options.token,
      BODY_SIZE_LIMIT: '34M',
      // Small pages, so a first download takes several rounds (progress, paging).
      SOMEMEMOS_MAX_PAGE: '10',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  // SYNC_E2E_SERVER_LOG: a file to append the server's output to, for diagnosis.
  const logFile = process.env.SYNC_E2E_SERVER_LOG;
  const keep = (d: unknown) => {
    output += String(d);
    if (logFile) appendFileSync(logFile, `[${options.port}] ${String(d)}`);
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  const url = `http://127.0.0.1:${options.port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the server exited:\n${output}`);
    try {
      const res = await fetch(`${url}/api/health`);
      const body = (await res.json()) as { status?: string };
      if (res.ok && body.status === 'ok') break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`the server did not become ready:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    url,
    port: options.port,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
      }),
  };
}

/** A free TCP port on 127.0.0.1. */
export function freePort(): number {
  const out = spawnSync(
    process.execPath,
    [
      '-e',
      "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})",
    ],
    { encoding: 'utf8' },
  );
  return Number(out.stdout);
}
