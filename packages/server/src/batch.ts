// `POST /api/brains/{brain}/changes` (core `sync.BatchRequest`): several
// writes, deletes and renames from a remote client as one change set. Runs
// inside `BrainService.withBrain`:
//
// 1. Every op is checked against the notes as they are. A stale base on any
//    of them refuses the whole batch (409, each stale file with the server's
//    version); nothing is written. An op whose result the server already has
//    (a retried request) is `unchanged`.
// 2. The rest are written to the working tree, then one engine commit
//    indexes them (the server's engine logs their edit, mention and rename
//    events, as for any remote client's save) and writes one change record
//    with the message. `withBrain` then makes that one git commit, whose note
//    versions take one range of mutation numbers.

import { engine as coreEngine, markdown, storage, sync } from '@somememos/core';
import type { BrainContext } from './brains.js';
import { HttpError } from './errors.js';
import { batchCodes, parseRequest } from './requests.js';

/**
 * Validates a batch body: its shape, paths and sizes (`sync.BatchRequestSchema`),
 * then that no path appears in two ops. Roles are checked when it runs.
 */
export function parseBatch(body: unknown): sync.BatchRequest {
  const batch = parseRequest(sync.BatchRequestSchema, body, batchCodes);
  const used = new Set<string>();
  batch.ops.forEach((op, i) => {
    for (const path of op.op === 'rename' ? [op.path, op.to] : [op.path]) {
      if (used.has(path)) {
        throw new HttpError(
          400,
          'invalid-request',
          `op ${i + 1}: a path may appear in only one op`,
        );
      }
      used.add(path);
    }
  });
  return batch;
}

/** Applies a validated batch to a held brain (see the top of this file). */
export async function applyBatch(
  ctx: BrainContext,
  batch: sync.BatchRequest,
): Promise<sync.BatchResult> {
  const classifier = markdown.createRoleClassifier(ctx.config.roles);
  const roleOf = (path: string) => {
    const role = classifier.classify(path)?.role;
    if (role === 'excluded') {
      throw new coreEngine.EngineError('excluded', 'that path is excluded from somememos', null);
    }
    if (role === undefined) {
      throw new coreEngine.EngineError(
        'not-found',
        `${path} has no role in this brain's config`,
        path,
      );
    }
    return role;
  };
  const current = async (path: string) => {
    const text = (await ctx.content.read(path)) ?? null;
    return { text, hash: text === null ? null : await storage.contentHash(text) };
  };

  // --- Judge every op against the notes as they are.
  const conflicts: sync.BatchConflict[] = [];
  const results: sync.BatchOpResult[] = [];
  const todo: sync.BatchOp[] = [];
  for (const op of batch.ops) {
    const role = roleOf(op.path);
    const here = await current(op.path);
    if (op.op === 'write') {
      const hash = await storage.contentHash(op.text);
      if (here.hash === hash) {
        results.push({ op: 'write', path: op.path, status: 'unchanged', hash });
        continue;
      }
      if (here.hash !== op.baseHash) {
        conflicts.push({ path: op.path, currentHash: here.hash, currentText: here.text });
        continue;
      }
      if (role === 'source' && here.hash !== null) {
        throw new coreEngine.EngineError(
          'source-immutable',
          `${op.path} is a source; sources are immutable once they exist`,
          op.path,
        );
      }
      results.push({ op: 'write', path: op.path, status: 'applied', hash });
      todo.push(op);
    } else if (op.op === 'delete') {
      if (here.hash === null) {
        results.push({ op: 'delete', path: op.path, status: 'unchanged', hash: null });
      } else if (here.hash !== op.baseHash) {
        conflicts.push({ path: op.path, currentHash: here.hash, currentText: here.text });
      } else {
        results.push({ op: 'delete', path: op.path, status: 'applied', hash: null });
        todo.push(op);
      }
    } else {
      roleOf(op.to);
      const there = await current(op.to);
      if (here.hash === null && there.hash === op.baseHash) {
        results.push({ ...op, status: 'unchanged', hash: there.hash });
      } else if (here.hash !== op.baseHash || there.hash !== null) {
        conflicts.push({
          path: op.path,
          currentHash: here.hash,
          currentText: here.text,
          ...(there.hash !== null ? { to: op.to } : {}),
        });
      } else {
        results.push({
          op: 'rename',
          path: op.path,
          to: op.to,
          status: 'applied',
          hash: here.hash,
        });
        todo.push(op);
      }
    }
  }
  if (conflicts.length > 0) return { status: 'conflict', conflicts };
  if (todo.length === 0) return { status: 'saved', change: null, results };

  // --- Apply all, then one index pass and one change record.
  const paths: string[] = [];
  for (const op of todo) {
    if (op.op === 'write') await ctx.content.write(op.path, op.text, { mtime: ctx.now });
    else if (op.op === 'delete') await ctx.content.remove(op.path);
    else await ctx.content.rename(op.path, op.to);
    paths.push(op.path, ...(op.op === 'rename' ? [op.to] : []));
  }
  const committed = await ctx.engine.commit({
    paths,
    ...(batch.message ? { message: batch.message } : {}),
  });
  return { status: 'saved', change: committed.change, results };
}
