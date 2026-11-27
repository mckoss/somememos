// A brain's shared config as one synced thing (PLAN.md section 4, "Folder
// roles"; section 7): `GET`/`PUT /api/brains/{brain}/config`, the check a
// sync request's `configRevision` gets, and what the server does with its
// own copy when the config changes. Runs inside `BrainService.withBrain`.
//
// - The config (everything but a client id) lives in `server_brains.config`
//   with `config_revision`, raised by one on every change.
// - A put names the revision it was based on. A stale one is refused (409
//   `config-conflict`) with the current config, unless the two configs are
//   equal anyway.
// - On a change the server re-indexes its copy with core's
//   `applyConfigChange` (logging nothing). A newly excluded folder leaves
//   the index, search, sync and the public blog; its notes stay in the git
//   repository, untouched, and come back if it is accepted again.
// - Notes, log entries and change records of a folder that is accepted
//   again take new mutation numbers, so every copy that skipped them while
//   they were excluded receives them on its next sync.

import { engine as coreEngine, markdown, storage, sync } from '@somememos/core';
import type { BrainContext, StoredConfig } from './brains.js';
import { parseStoredConfig } from './brains.js';
import { HttpError } from './errors.js';
import { fieldCodes, parseRequest } from './requests.js';

/** The brain's shared config and its revision. */
export async function readSharedConfig(ctx: BrainContext): Promise<sync.ConfigView> {
  const rows = await ctx.query<{ config: string; config_revision: string }>(
    'SELECT config, config_revision FROM server_brains WHERE brain_id = $1',
    [ctx.brainId],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'brain-not-found', 'no such brain');
  return {
    revision: Number(row.config_revision),
    config: sync.sharedConfigOf(parseStoredConfig(JSON.parse(row.config))),
  };
}

/** The 409 for a stale config revision: the body carries the current config. */
function staleError(code: 'config-conflict' | 'config-changed', view: sync.ConfigView): HttpError {
  const message =
    code === 'config-conflict'
      ? `the brain's config changed since the revision this was based on; it is now at revision ${view.revision}`
      : `the brain's config is at revision ${view.revision}; take it, then sync again`;
  return new HttpError(409, code, message, {}, { config: view.config, revision: view.revision });
}

/** Refuses a sync request whose `configRevision` is not the brain's (nothing is applied). */
export async function checkSyncConfigRevision(
  ctx: BrainContext,
  revision: number | undefined,
): Promise<void> {
  if (revision === undefined) return;
  const view = await readSharedConfig(ctx);
  if (view.revision !== revision) throw staleError('config-changed', view);
}

/** Validates a `PUT …/config` body (`sync.ConfigPutRequestSchema`, then `parseStoredConfig`). */
export function parseConfigPut(body: unknown): { baseRevision: number; config: StoredConfig } {
  const put = parseRequest(sync.ConfigPutRequestSchema, body, fieldCodes());
  return { baseRevision: put.baseRevision, config: parseStoredConfig(put.config) };
}

const accepted = (classifier: markdown.RoleClassifier, path: string): boolean => {
  const role = classifier.classify(path)?.role;
  return role !== undefined && role !== 'excluded';
};

/** Replaces the brain's shared config (see the top of this file). */
export async function putSharedConfig(
  ctx: BrainContext,
  put: { baseRevision: number; config: StoredConfig },
): Promise<sync.ConfigPutResult> {
  const current = await readSharedConfig(ctx);
  const next = sync.sharedConfigOf(put.config);
  if (sync.sharedConfigKey(next) === sync.sharedConfigKey(current.config)) {
    return { status: 'unchanged', ...current };
  }
  if (put.baseRevision !== current.revision) throw staleError('config-conflict', current);
  const revision = current.revision + 1;
  await ctx.query(
    'UPDATE server_brains SET config = $2, config_revision = $3 WHERE brain_id = $1',
    [ctx.brainId, JSON.stringify(next), revision],
  );
  const from = ctx.config;
  const to = sync.configWithClient(next, from.clientId, 'the new config');
  await coreEngine.applyConfigChange({
    stores: ctx.stores,
    content: ctx.content,
    from,
    to,
    now: () => ctx.now,
  });
  await republish(ctx, from, to);
  await ctx.numberEntries();
  return { status: 'saved', revision, config: next };
}

/**
 * Gives the notes, log entries and change records that `to` accepts and
 * `from` did not new mutation numbers (see the top of this file).
 */
async function republish(
  ctx: BrainContext,
  from: storage.BrainConfig,
  to: storage.BrainConfig,
): Promise<void> {
  const before = markdown.createRoleClassifier(from.roles);
  const after = markdown.createRoleClassifier(to.roles);
  const id = ctx.brainId;

  // Notes: a new version row for each, at its latest recorded version.
  const paths = (await ctx.content.list())
    .map((e) => e.path)
    .filter((p) => sync.syncPathProblem(p) === null && accepted(after, p) && !accepted(before, p));
  if (paths.length > 0) {
    const latest = (
      await ctx.query<{ path: string; hash: string | null; commit: string }>(
        `SELECT DISTINCT ON (path) path, hash, commit FROM note_versions
         WHERE brain_id = $1 AND path = ANY($2::text[]) ORDER BY path, mutation DESC`,
        [id, paths],
      )
    ).filter((r) => r.hash !== null);
    if (latest.length > 0) {
      const [{ seq }] = (await ctx.query<{ seq: string }>(
        'SELECT somememos_advance_mutation_seq($1, $2) AS seq',
        [id, latest.length],
      )) as [{ seq: string }];
      const first = Number(seq) - latest.length + 1;
      await ctx.query(
        `INSERT INTO note_versions (brain_id, mutation, path, hash, renamed_to, commit)
         SELECT $1, u.m, u.p, u.h, NULL, u.c
         FROM unnest($2::int8[], $3::text[], $4::text[], $5::text[]) AS u(m, p, h, c)`,
        [
          id,
          latest.map((_, i) => first + i),
          latest.map((r) => r.path),
          latest.map((r) => r.hash),
          latest.map((r) => r.commit),
        ],
      );
    }
  }

  // Log entries and change records: numbered again by `numberEntries`.
  const back = (item: string) =>
    coreEngine.isExcludedItem(before, item) && !coreEngine.isExcludedItem(after, item);
  const items = (
    await ctx.query<{ item: string }>(
      `SELECT DISTINCT item FROM events WHERE brain_id = $1
       UNION SELECT DISTINCT target FROM events WHERE brain_id = $1 AND target IS NOT NULL`,
      [id],
    )
  )
    .map((r) => r.item)
    .filter(back);
  if (items.length > 0) {
    await ctx.query(
      `UPDATE events SET mutation = NULL
       WHERE brain_id = $1 AND (item = ANY($2::text[]) OR target = ANY($2::text[]))`,
      [id, items],
    );
  }
  const changePaths = (
    await ctx.query<{ path: string }>(
      'SELECT DISTINCT path FROM change_paths WHERE brain_id = $1',
      [id],
    )
  )
    .map((r) => r.path)
    .filter(back);
  if (changePaths.length > 0) {
    await ctx.query(
      `UPDATE changes SET mutation = NULL
       WHERE brain_id = $1 AND seq IN (SELECT change_seq FROM change_paths
                                       WHERE brain_id = $1 AND path = ANY($2::text[]))`,
      [id, changePaths],
    );
  }
}
