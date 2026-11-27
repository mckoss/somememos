// Starts the built app (`node build`) for the blog end-to-end tests, on a
// fresh Postgres schema of the test database and a temporary data
// directory, so a run never touches anything else. Test-only.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const url = process.env.SOMEMEMOS_TEST_DATABASE_URL;
const schema = process.env.BLOG_E2E_SCHEMA ?? 'somememos_blog_e2e';
if (!url) throw new Error('SOMEMEMOS_TEST_DATABASE_URL is not set');
if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('bad schema name');

const admin = new pg.Client({ connectionString: url });
await admin.connect();
await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
await admin.query(`CREATE SCHEMA ${schema}`);
await admin.end();

const database = new URL(url);
database.searchParams.set('options', `-c search_path=${schema}`);
process.env.DATABASE_URL = database.toString();
process.env.SOMEMEMOS_DATA_DIR = mkdtempSync(join(tmpdir(), 'somememos-blog-e2e-'));

await import('../build/index.js');
