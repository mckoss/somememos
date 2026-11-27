// The brains a server hosts, and the one write path every request takes.
//
// Storage. Each brain is a git repository under `<dataDir>/brains/<id>/`
// whose working tree is the brain's notes (./git-content.ts): git is the only
// copy of note text. Postgres holds the event log, change records, index and
// scores (pg-store), plus the server's tables: `server_brains` (owner, config,
// and `git_head`, the commit the database has recorded) and `note_versions`
// (every note version by mutation number and commit). pg-store's `content`
// table is not used by the server.
//
// One request, one transaction. `withBrain` runs a request for one brain:
//
//   1. BEGIN, then `pg_advisory_xact_lock` keyed by the brain: every request
//      for the brain, from any server process, runs one at a time.
//   2. Recover: if the repository is not exactly at `git_head` (a commit the
//      database never recorded, or a dirty working tree), put it back
//      (`BrainRepo.recover`; an unrecorded commit is kept under a ref, never
//      deleted).
//   3. The request runs the engine over pg-store's stores opened on this
//      transaction (./tx-pool.ts) and the working tree.
//   4. Each change set becomes one git commit (`commitChanges`), and its note
//      versions take mutation numbers; then log entries and change records
//      written by the request take theirs (`stampMutations`).
//   5. `git_head` is set to the new commit, and COMMIT.
//
// The database commit is the single commit point. If the process dies (or
// anything fails) after the git commit but before the database commit, the
// database still records the old `git_head` and none of the request's rows:
// the next request for the brain finds the repository ahead, keeps the
// unrecorded commit under `refs/somememos/unrecorded/`, and resets the
// working tree to `git_head`. The client got no response, so it retries; its
// edits then apply again (or are duplicates), and its events and change
// records are deduplicated by id. The reverse cannot happen: the database
// never records a commit that is not already in the repository, because git
// commits first. (If the data volume is restored from a backup older than
// the database, the recorded commit is missing; requests then fail with a
// clear error rather than guess.)

import { join } from 'node:path';
import { engine as coreEngine, indexing, storage, type engine as Eng } from '@somememos/core';
import {
  advanceMutationSeq,
  createPgStores,
  ensureBrain,
  ensureMigrated,
  migrate,
  type PgStores,
} from '@somememos/pg-store';
import type pg from 'pg';
import { createGitContentStore } from './git-content.js';
import { BrainRepo, type CommitInput, type StagedChange } from './git.js';
import { TransactionPool } from './tx-pool.js';

/** A brain id: lower-case letters, digits and dashes, 1 to 63 characters, starting with a letter or digit. */
export const BRAIN_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A client id, as `BrainConfig.clientId` allows. */
export const CLIENT_ID = /^[A-Za-z0-9._:-]{1,100}$/;

/** The client id the server's engine uses when a request names none. */
export const SERVER_CLIENT_ID = 'server';

export type BrainErrorCode =
  'invalid-brain-id' | 'brain-not-found' | 'brain-exists' | 'invalid-config' | 'repository';

/** A brain-level failure, with the HTTP status it maps to. Never names a note. */
export class BrainError extends Error {
  override name = 'BrainError';
  constructor(
    readonly code: BrainErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface BrainInfo {
  readonly id: string;
  readonly createdAt: number;
  /** The brain's mutation counter. */
  readonly mutation: number;
}

/** A brain's config as the server stores and returns it: everything but the client id. */
export type StoredConfig = Omit<storage.BrainConfig, 'clientId'>;

export interface BrainServiceOptions {
  readonly pool: pg.Pool;
  readonly dataDir: string;
  /** The clock, whole Unix seconds. */
  readonly now?: () => number;
  /**
   * Test hook: runs after a request's git commits, just before the database
   * commit. Throwing from it simulates a crash between the two.
   */
  readonly beforeDatabaseCommit?: (brainId: string) => void | Promise<void>;
}

/** What a request sees while it holds a brain. */
export interface BrainContext {
  readonly brainId: string;
  readonly engine: Eng.Engine;
  readonly stores: PgStores;
  readonly content: storage.ContentStore;
  readonly repo: BrainRepo;
  /** The brain's config, with the request's client id. */
  readonly config: storage.BrainConfig;
  /** The request's time, Unix seconds. */
  readonly now: number;
  /** Runs a query in the request's transaction. */
  query<R extends pg.QueryResultRow>(text: string, values?: readonly unknown[]): Promise<R[]>;
  /**
   * Stages the working tree and, if anything changed, commits it as one
   * commit and records each changed note as a version with a mutation
   * number of its own (a rename takes one number for both paths).
   */
  commitChanges(input: CommitInput): Promise<CommittedChanges | null>;
  /** Gives every log entry and change record written so far (and not yet numbered) its mutation number. */
  numberEntries(): Promise<void>;
}

export interface CommittedChanges {
  readonly commit: string;
  readonly changes: StagedChange[];
  /** The mutation numbers the change set took, in `changes` order. */
  readonly mutations: number[];
}

const configOf = (config: storage.BrainConfig): StoredConfig => {
  const { clientId: _clientId, ...rest } = config;
  return rest;
};

/** Validates a config given when a brain is created; `null`/`undefined` means the default layout. */
export function parseStoredConfig(value: unknown): StoredConfig {
  if (value === undefined || value === null) return configOf(storage.defaultBrainConfig('server'));
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new BrainError('invalid-config', 'config must be a JSON object', 400);
  }
  if ('clientId' in value) {
    throw new BrainError(
      'invalid-config',
      'config must not carry a clientId (each client has its own)',
      400,
    );
  }
  try {
    return configOf(storage.parseBrainConfig({ ...(value as object), clientId: 'server' }));
  } catch (error) {
    if (error instanceof storage.ConfigError) {
      throw new BrainError('invalid-config', error.message, 400);
    }
    throw error;
  }
}

export class BrainService {
  readonly tx: TransactionPool;
  private readonly now: () => number;

  constructor(private readonly options: BrainServiceOptions) {
    this.tx = new TransactionPool(options.pool);
    this.now = options.now ?? storage.unixNow;
  }

  get pool(): pg.Pool {
    return this.options.pool;
  }

  /** Applies pending migrations (safe from several processes at once). */
  async migrate(): Promise<void> {
    await migrate(this.options.pool);
  }

  repoDir(brainId: string): string {
    return join(this.options.dataDir, 'brains', brainId);
  }

  private checkId(brainId: unknown): string {
    if (typeof brainId !== 'string' || !BRAIN_ID.test(brainId)) {
      throw new BrainError(
        'invalid-brain-id',
        'a brain id is 1 to 63 lower-case letters, digits and dashes, starting with a letter or digit',
        400,
      );
    }
    return brainId;
  }

  private async lock(client: pg.PoolClient, brainId: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `somememos-brain:${brainId}`,
    ]);
  }

  /** Creates a brain owned by `owner`, with an empty repository. */
  async create(owner: string, brainId: unknown, config: unknown): Promise<BrainInfo> {
    const id = this.checkId(brainId);
    const stored = parseStoredConfig(config);
    await ensureMigrated(this.options.pool);
    const now = this.now();
    return this.tx.run(async (client) => {
      await this.lock(client, id);
      const existing = await client.query('SELECT 1 FROM server_brains WHERE brain_id = $1', [id]);
      if ((existing.rowCount ?? 0) > 0) {
        throw new BrainError('brain-exists', 'a brain with that id exists', 409);
      }
      const repo = new BrainRepo(this.repoDir(id));
      if (repo.exists() && (await repo.head()) !== null) {
        throw new BrainError(
          'repository',
          'a repository with history already exists for that id in the data directory; move it away first',
          409,
        );
      }
      await ensureBrain(this.tx.asPool(), id, now);
      await client.query(
        `INSERT INTO server_brains (brain_id, owner_id, config, git_head, created_at)
         VALUES ($1, $2, $3, NULL, $4)`,
        [id, owner, JSON.stringify(stored), now],
      );
      await repo.init();
      return { id, createdAt: now, mutation: 0 };
    });
  }

  /** The brains `owner` owns, by id. */
  async list(owner: string): Promise<BrainInfo[]> {
    await ensureMigrated(this.options.pool);
    const { rows } = await this.options.pool.query<{
      id: string;
      created_at: string;
      mutation: string;
    }>(
      `SELECT s.brain_id AS id, s.created_at, b.mutation_seq AS mutation
       FROM server_brains s JOIN brains b USING (brain_id)
       WHERE s.owner_id = $1 ORDER BY s.brain_id`,
      [owner],
    );
    return rows.map((r) => ({
      id: r.id,
      createdAt: Number(r.created_at),
      mutation: Number(r.mutation),
    }));
  }

  /** One brain `owner` owns, with its config; BrainError 404 otherwise. */
  async get(owner: string, brainId: unknown): Promise<BrainInfo & { config: StoredConfig }> {
    const id = this.checkId(brainId);
    await ensureMigrated(this.options.pool);
    const { rows } = await this.options.pool.query<{
      created_at: string;
      mutation: string;
      config: string;
    }>(
      `SELECT s.created_at, b.mutation_seq AS mutation, s.config
       FROM server_brains s JOIN brains b USING (brain_id)
       WHERE s.brain_id = $1 AND s.owner_id = $2`,
      [id, owner],
    );
    const row = rows[0];
    if (!row) throw new BrainError('brain-not-found', 'no such brain', 404);
    return {
      id,
      createdAt: Number(row.created_at),
      mutation: Number(row.mutation),
      config: parseStoredConfig(JSON.parse(row.config)),
    };
  }

  /**
   * Runs `fn` holding the brain (see the top of this file): in one
   * transaction, under the brain's lock, with the repository at the recorded
   * commit. Changes `fn` leaves in the working tree are committed as one
   * change set; every log entry and change record it wrote is numbered.
   */
  async withBrain<T>(
    owner: string,
    brainId: unknown,
    options: { readonly clientId?: string },
    fn: (ctx: BrainContext) => Promise<T>,
  ): Promise<T> {
    const id = this.checkId(brainId);
    const clientId = options.clientId ?? SERVER_CLIENT_ID;
    if (!CLIENT_ID.test(clientId)) throw new BrainError('invalid-config', 'bad client id', 400);
    await ensureMigrated(this.options.pool);
    const now = this.now();
    return this.tx.run(async (client) => {
      await this.lock(client, id);
      const { rows } = await client.query<{
        owner_id: string;
        config: string;
        git_head: string | null;
      }>('SELECT owner_id, config, git_head FROM server_brains WHERE brain_id = $1', [id]);
      const row = rows[0];
      if (!row || row.owner_id !== owner)
        throw new BrainError('brain-not-found', 'no such brain', 404);
      const repo = new BrainRepo(this.repoDir(id));
      if (!repo.exists()) {
        throw new BrainError(
          'repository',
          'the brain repository is missing from the data directory (is SOMEMEMOS_DATA_DIR on the right volume?)',
          500,
        );
      }
      const recorded = row.git_head;
      try {
        await repo.recover(recorded);
      } catch (error) {
        throw new BrainError('repository', (error as Error).message, 500);
      }
      try {
        const config = storage.parseBrainConfig({ ...JSON.parse(row.config), clientId });
        const stores = await createPgStores({
          pool: this.tx.asPool(),
          brainId: id,
          now: this.now,
          analyzer: config.analyzer,
        });
        const content = createGitContentStore(repo.dir);
        let crossed = false;
        const engine = coreEngine.createEngine({ stores, content, config, now: this.now });
        // An index with no baseline (a new brain, or derived data that was
        // reset) would take the next change for the baseline and log nothing
        // for it. Everything in the working tree is already recorded, so take
        // the baseline now.
        if ((await stores.indexMeta.get(indexing.META_BASELINE)) === undefined) {
          await engine.index();
        }
        const q = async <R extends pg.QueryResultRow>(
          text: string,
          values: readonly unknown[] = [],
        ) => (await client.query<R>(text, values as unknown[])).rows;
        const ctx: BrainContext = {
          brainId: id,
          engine,
          stores,
          content,
          repo,
          config,
          now,
          query: q,
          commitChanges: (input) => this.commitChanges(id, repo, content, input),
          numberEntries: async () => {
            const r = await this.stampMutations(id);
            crossed ||= r.crossed500;
          },
        };
        const result = await fn(ctx);
        // Leftovers (an engine route's save, rename, delete or diary entry): one
        // change set. A change the engine made without a change record (a new
        // diary entry) gets one, so the change log and git history agree.
        if (!(await repo.isClean())) {
          if ((await stores.indexMeta.get(indexing.META_BASELINE)) !== undefined) {
            await engine.commit({ message: null });
          }
          await this.commitLeftovers(id, repo, content, clientId, now);
        }
        crossed ||= (await this.stampMutations(id)).crossed500;
        const head = await repo.head();
        if (head !== recorded) {
          await client.query('UPDATE server_brains SET git_head = $2 WHERE brain_id = $1', [
            id,
            head,
          ]);
        }
        await this.options.beforeDatabaseCommit?.(id);
        if (head !== recorded && crossed) await repo.maintain();
        return result;
      } catch (error) {
        // Still holding the lock: put the working tree back before the rollback.
        await repo.recover(recorded).catch(() => undefined);
        throw error;
      }
    });
  }

  private async commitChanges(
    brainId: string,
    repo: BrainRepo,
    content: storage.ContentStore,
    input: CommitInput,
  ): Promise<CommittedChanges | null> {
    const changes = await repo.stageAll();
    if (changes.length === 0) return null;
    const commit = await repo.commit(input, this.now());
    const last = await advanceMutationSeq(this.tx.asPool(), brainId, changes.length);
    const first = last - changes.length + 1;
    const rows: {
      mutation: number;
      path: string;
      hash: string | null;
      renamedTo: string | null;
    }[] = [];
    const hashOf = async (path: string): Promise<string> => {
      const text = await content.read(path);
      if (text === undefined) throw new Error('a committed note vanished from the working tree');
      return storage.contentHash(text);
    };
    const mutations: number[] = [];
    for (const [i, change] of changes.entries()) {
      const mutation = first + i;
      mutations.push(mutation);
      if (change.status === 'renamed') {
        rows.push({ mutation, path: change.from, hash: null, renamedTo: change.to });
        rows.push({ mutation, path: change.to, hash: await hashOf(change.to), renamedTo: null });
      } else {
        const hash = change.status === 'deleted' ? null : await hashOf(change.path);
        rows.push({ mutation, path: change.path, hash, renamedTo: null });
      }
    }
    await this.tx.query(
      `INSERT INTO note_versions (brain_id, mutation, path, hash, renamed_to, commit)
       SELECT $1, u.m, u.p, u.h, u.r, $6
       FROM unnest($2::int8[], $3::text[], $4::text[], $5::text[]) AS u(m, p, h, r)`,
      [
        brainId,
        rows.map((r) => r.mutation),
        rows.map((r) => r.path),
        rows.map((r) => r.hash),
        rows.map((r) => r.renamedTo),
        commit,
      ],
    );
    return { commit, changes, mutations };
  }

  /** Commits what an engine route left in the working tree, named by the change record it wrote. */
  private async commitLeftovers(
    brainId: string,
    repo: BrainRepo,
    content: storage.ContentStore,
    clientId: string,
    now: number,
  ): Promise<void> {
    const { rows } = await this.tx.query(
      `SELECT c.client, c.message, c.time,
              (SELECT string_agg(p.path, ', ' ORDER BY p.path) FROM change_paths p
               WHERE p.brain_id = c.brain_id AND p.change_seq = c.seq) AS paths
       FROM changes c WHERE c.brain_id = $1 AND c.mutation IS NULL
       ORDER BY c.seq DESC LIMIT 1`,
      [brainId],
    );
    const change = rows[0] as
      { client: string; message: string | null; time: string; paths: string | null } | undefined;
    const author = change?.client ?? clientId;
    await this.commitChanges(brainId, repo, content, {
      author,
      time: change ? Number(change.time) : now,
      message: change?.message ?? `${author}: ${change?.paths ?? 'changed notes'}`,
    });
  }

  /**
   * Numbers every log entry and change record of the brain that has no
   * mutation number yet: events in seq order, then change records.
   */
  private async stampMutations(brainId: string): Promise<{ crossed500: boolean }> {
    const counts = await this.tx.query(
      `SELECT (SELECT count(*) FROM events WHERE brain_id = $1 AND mutation IS NULL) AS e,
              (SELECT count(*) FROM changes WHERE brain_id = $1 AND mutation IS NULL) AS c`,
      [brainId],
    );
    const e = Number(counts.rows[0]?.e ?? 0);
    const c = Number(counts.rows[0]?.c ?? 0);
    if (e + c === 0) return { crossed500: false };
    const last = await advanceMutationSeq(this.tx.asPool(), brainId, e + c);
    const base = last - (e + c);
    for (const [table, offset] of [
      ['events', base],
      ['changes', base + e],
    ] as const) {
      await this.tx.query(
        `UPDATE ${table} t SET mutation = $2 + u.rn
         FROM (SELECT seq, row_number() OVER (ORDER BY seq) AS rn
               FROM ${table} WHERE brain_id = $1 AND mutation IS NULL) u
         WHERE t.brain_id = $1 AND t.seq = u.seq`,
        [brainId, offset],
      );
    }
    return { crossed500: Math.floor(base / 500) !== Math.floor(last / 500) };
  }
}
