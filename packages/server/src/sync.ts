// `POST /api/brains/{brain}/sync` (PLAN.md section 7, "Sync protocol (first
// version)"): validation of the request, and the server's side of a sync,
// run inside `BrainService.withBrain`.
//
// Order, all in the brain's one transaction: every edit is judged against the
// current notes (edits name distinct paths, so the order among them does not
// matter); the applied ones are stored without logging events
// (`Engine.applyRemote`), one git commit per change set; then the log entries
// and change records are appended (ids the brain has are skipped), and every
// entry the request added takes a mutation number. The response carries
// everything after `since` from any client, paged.

import { engine as coreEngine, markdown, storage, sync, timescore } from '@somememos/core';
import type { BrainContext } from './brains.js';
import { CLIENT_ID } from './brains.js';
import { HttpError } from './errors.js';
import { folderClash } from './git-content.js';

type Edit = sync.SyncEdit;

const HASH = /^[0-9a-f]{64}$/;
const REQUEST_KEYS = new Set(['since', 'client', 'configRevision', 'events', 'changes', 'edits']);
const EDIT_KEYS = new Set(['id', 'op', 'path', 'to', 'baseHash', 'text']);
const EVENT_KEYS = new Set(['id', 'kind', 'item', 'to', 'time', 'client']);
const CHANGE_KEYS = new Set(['id', 'time', 'client', 'message', 'op', 'paths']);

const invalid = (message: string, code = 'invalid-request'): HttpError =>
  new HttpError(400, code, message);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw invalid(`${where}: unknown field "${key}"`);
  }
}

function array(value: unknown, name: string, max: number): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(`${name} must be an array`);
  if (value.length > max) throw invalid(`at most ${max} ${name} per request`, 'too-large');
  return value;
}

/**
 * Validates a sync request for a brain with `classifier`'s roles. Throws an
 * `HttpError` (400 or 413) naming the problem, never a path; nothing is
 * changed by an invalid request.
 */
export function parseSyncRequest(
  body: unknown,
  classifier: markdown.RoleClassifier,
  now: number,
): sync.SyncRequest {
  if (!isObject(body)) throw invalid('the request must be a JSON object');
  onlyKeys(body, REQUEST_KEYS, 'request');
  const limits = sync.SYNC_LIMITS;
  const since = body.since;
  if (typeof since !== 'number' || !Number.isSafeInteger(since) || since < 0) {
    throw invalid('since must be an integer >= 0');
  }
  if (
    body.client !== undefined &&
    (typeof body.client !== 'string' || !CLIENT_ID.test(body.client))
  ) {
    throw invalid('client must be a client id (letters, digits, ".", "_", ":" and "-")');
  }

  const configRevision = body.configRevision;
  if (
    configRevision !== undefined &&
    (typeof configRevision !== 'number' ||
      !Number.isSafeInteger(configRevision) ||
      configRevision < 0)
  ) {
    throw invalid('configRevision must be an integer >= 0');
  }

  const checkNotePath = (path: unknown, where: string): string => {
    const problem = sync.syncPathProblem(path);
    if (problem !== null) throw invalid(`${where}: ${problem}`, 'invalid-path');
    const role = classifier.classify(path as string)?.role;
    if (role === 'excluded')
      throw new HttpError(403, 'excluded', `${where}: that path is excluded`);
    if (role === undefined)
      throw invalid(`${where}: the path has no role in this brain's config`, 'no-role');
    return path as string;
  };

  const edits: Edit[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  const usePath = (path: string, where: string) => {
    if (paths.has(path)) throw invalid(`${where}: a path may appear in only one edit per request`);
    paths.add(path);
  };
  array(body.edits, 'edits', limits.maxEdits).forEach((raw, i) => {
    const where = `edit ${i + 1}`;
    if (!isObject(raw)) throw invalid(`${where} must be an object`);
    onlyKeys(raw, EDIT_KEYS, where);
    const { id, op, baseHash, text, to } = raw;
    if (typeof id !== 'string' || id === '' || id.length > limits.maxEditIdLength) {
      throw invalid(`${where}: id must be a string of 1 to ${limits.maxEditIdLength} characters`);
    }
    if (ids.has(id)) throw invalid(`${where}: duplicate id`);
    ids.add(id);
    if (op !== 'write' && op !== 'delete' && op !== 'rename') {
      throw invalid(`${where}: op must be "write", "delete" or "rename"`);
    }
    const path = checkNotePath(raw.path, where);
    usePath(path, where);
    if (baseHash !== null && (typeof baseHash !== 'string' || !HASH.test(baseHash))) {
      throw invalid(`${where}: baseHash must be null or a SHA-256 hex hash`);
    }
    if (op !== 'write' && baseHash === null) throw invalid(`${where}: a ${op} needs a baseHash`);
    if (op === 'write') {
      if (typeof text !== 'string') throw invalid(`${where}: a write needs text`);
      if (storage.utf8Length(text) > limits.maxNoteBytes) {
        throw new HttpError(
          413,
          'too-large',
          `${where}: the note is larger than ${limits.maxNoteBytes} bytes`,
        );
      }
      if (to !== undefined) throw invalid(`${where}: only a rename has "to"`);
      edits.push({ id, op, path, baseHash: baseHash as string | null, text });
    } else if (op === 'rename') {
      if (text !== undefined) throw invalid(`${where}: only a write has text`);
      const target = checkNotePath(to, `${where} (to)`);
      if (target === path) throw invalid(`${where}: a rename must change the path`);
      usePath(target, where);
      edits.push({ id, op, path, to: target, baseHash: baseHash as string });
    } else {
      if (text !== undefined || to !== undefined)
        throw invalid(`${where}: a delete has no text or "to"`);
      edits.push({ id, op, path, baseHash: baseHash as string });
    }
  });

  const at = now + sync.SYNC_CLOCK_SKEW;
  const excludedItem = (item: string) => coreEngine.isExcludedItem(classifier, item);
  const checkEntry = (fn: () => void, where: string) => {
    try {
      fn();
    } catch (error) {
      if (error instanceof timescore.FutureEventError) {
        throw new HttpError(
          422,
          'future-event',
          `${where} is dated in the future; is this device's clock right?`,
        );
      }
      throw invalid(`${where}: ${(error as Error).message}`, 'invalid-event');
    }
  };

  const events: sync.SyncEvent[] = [];
  array(body.events, 'events', limits.maxEvents).forEach((raw, i) => {
    const where = `event ${i + 1}`;
    if (!isObject(raw)) throw invalid(`${where} must be an object`);
    onlyKeys(raw, EVENT_KEYS, where);
    const e = raw as unknown as sync.SyncEvent;
    if (e.kind !== 'rename' && 'to' in raw) throw invalid(`${where}: only a rename has "to"`);
    checkEntry(() => storage.assertValidLogInput(e as storage.LogInput, at), where);
    if (excludedItem(e.item) || (e.kind === 'rename' && excludedItem(e.to))) {
      throw new HttpError(403, 'excluded', `${where} names an excluded path`);
    }
    events.push(
      e.kind === 'rename'
        ? { id: e.id, kind: 'rename', item: e.item, to: e.to, time: e.time, client: e.client }
        : { id: e.id, kind: e.kind, item: e.item, time: e.time, client: e.client },
    );
  });

  const changes: sync.SyncChange[] = [];
  array(body.changes, 'changes', limits.maxChanges).forEach((raw, i) => {
    const where = `change ${i + 1}`;
    if (!isObject(raw)) throw invalid(`${where} must be an object`);
    onlyKeys(raw, CHANGE_KEYS, where);
    const c = {
      id: raw.id,
      time: raw.time,
      client: raw.client,
      message: raw.message ?? null,
      op: raw.op ?? null,
      paths: raw.paths ?? [],
    } as storage.ChangeInput;
    if (typeof c.message === 'string' && c.message.length > limits.maxMessageLength) {
      throw invalid(`${where}: the message is longer than ${limits.maxMessageLength} characters`);
    }
    checkEntry(() => storage.assertValidChangeInput(c, at), where);
    if (c.paths.some((p) => excludedItem(p))) {
      throw new HttpError(403, 'excluded', `${where} names an excluded path`);
    }
    changes.push({ ...c, paths: [...c.paths] });
  });

  return {
    since,
    ...(typeof body.client === 'string' ? { client: body.client } : {}),
    ...(typeof configRevision === 'number' ? { configRevision } : {}),
    events,
    changes,
    edits,
  };
}

interface Judged {
  readonly edit: Edit;
  readonly result: sync.SyncEditResult;
  /** The note states to store, when applied. */
  readonly notes: sync.SyncNote[];
}

/** The note's current text and hash on the server, or nulls. */
async function current(
  ctx: BrainContext,
  path: string,
): Promise<{ text: string | null; hash: string | null }> {
  const text = (await ctx.content.read(path)) ?? null;
  return { text, hash: text === null ? null : await storage.contentHash(text) };
}

/** True when notes at `a` and `b` would make one of them a folder of the other. */
const nested = (a: string, b: string): boolean => a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/**
 * Whether `edit` applies, is a duplicate, conflicts or is refused, against
 * the notes as they are. `arriving` holds the new paths of the request's
 * edits applied so far: a new note may not share its name with a folder on
 * the server or among them (finding 7 of the 2026-11-27 security review),
 * and is refused with `sync.NAME_CLASH` instead of failing the whole sync.
 */
async function judge(
  ctx: BrainContext,
  edit: Edit,
  classifier: markdown.RoleClassifier,
  arriving: Set<string>,
): Promise<Judged> {
  const clashes = (path: string): boolean =>
    folderClash(ctx.repo.dir, path) || [...arriving].some((p) => nested(p, path));
  const here = await current(ctx, edit.path);
  const conflict = (status: 'conflict' | 'refused' = 'conflict', code?: string): Judged => ({
    edit,
    notes: [],
    result: {
      id: edit.id,
      status,
      currentHash: here.hash,
      currentText: here.text,
      ...(code ? { code } : {}),
    },
  });
  if (edit.op === 'write') {
    const text = edit.text as string;
    const hash = await storage.contentHash(text);
    if (here.hash === hash)
      return { edit, notes: [], result: { id: edit.id, status: 'duplicate', hash } };
    if (here.hash !== edit.baseHash) return conflict();
    if (here.hash !== null && classifier.classify(edit.path)?.role === 'source') {
      return conflict('refused', 'source-immutable');
    }
    if (here.hash === null && clashes(edit.path)) return conflict('refused', sync.NAME_CLASH);
    arriving.add(edit.path);
    return {
      edit,
      notes: [{ path: edit.path, hash, text }],
      result: { id: edit.id, status: 'applied', hash },
    };
  }
  if (edit.op === 'delete') {
    if (here.hash === null)
      return { edit, notes: [], result: { id: edit.id, status: 'duplicate', hash: null } };
    if (here.hash !== edit.baseHash) return conflict();
    return {
      edit,
      notes: [{ path: edit.path, deleted: true }],
      result: { id: edit.id, status: 'applied', hash: null },
    };
  }
  const to = edit.to as string;
  const there = await current(ctx, to);
  if (here.hash === null && there.hash === edit.baseHash) {
    return { edit, notes: [], result: { id: edit.id, status: 'duplicate', hash: there.hash } };
  }
  if (here.hash !== edit.baseHash || there.hash !== null) return conflict();
  if (clashes(to)) return conflict('refused', sync.NAME_CLASH);
  arriving.add(to);
  return {
    edit,
    notes: [{ path: edit.path, renamedTo: to }],
    result: { id: edit.id, status: 'applied', hash: here.hash },
  };
}

/** The paths an edit touches. */
const editPaths = (edit: Edit): string[] => (edit.to ? [edit.path, edit.to] : [edit.path]);

/** Text in one response page, at most (beyond the first note). */
export const PAGE_TEXT_BYTES = 16 * 1024 * 1024;

/**
 * Runs a validated sync request against a held brain and builds the
 * response page.
 */
export async function runSync(
  ctx: BrainContext,
  request: sync.SyncRequest,
  pageSize: number,
): Promise<sync.SyncResponse> {
  const classifier = markdown.createRoleClassifier(ctx.config.roles);
  const counter = Number(
    (
      await ctx.query<{ m: string }>('SELECT mutation_seq AS m FROM brains WHERE brain_id = $1', [
        ctx.brainId,
      ])
    )[0]?.m ?? 0,
  );
  if (request.since > counter) {
    throw new HttpError(
      409,
      'since-ahead',
      `since (${request.since}) is ahead of this brain's mutation counter (${counter}): the copy synced with another server or brain; reset its sync state`,
    );
  }

  // --- Edits: judge all, then store the applied ones, one commit per change set.
  const judged: Judged[] = [];
  const arriving = new Set<string>();
  for (const edit of request.edits) judged.push(await judge(ctx, edit, classifier, arriving));
  const applied = judged.filter((j) => j.result.status === 'applied');

  // Each applied edit goes with the latest change record that names one of its paths.
  const owner = new Map<Judged, sync.SyncChange | null>();
  for (const j of applied) {
    let best: sync.SyncChange | null = null;
    for (const c of request.changes) {
      if (!editPaths(j.edit).some((p) => c.paths.includes(p))) continue;
      if (!best || c.time > best.time || (c.time === best.time && c.id > best.id)) best = c;
    }
    owner.set(j, best);
  }
  const groups = new Map<string, { change: sync.SyncChange | null; items: Judged[] }>();
  for (const j of applied) {
    const change = owner.get(j) ?? null;
    const key = change ? `c:${change.id}` : 'none';
    const group = groups.get(key) ?? { change, items: [] };
    group.items.push(j);
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort(
    (a, b) => (a.change?.time ?? Infinity) - (b.change?.time ?? Infinity),
  );
  const ownMutations = new Set<number>();
  const client = request.client ?? 'unknown-client';
  for (const group of ordered) {
    await ctx.engine.applyRemote({ notes: group.items.flatMap((j) => j.notes) });
    const n = group.items.length;
    const committed = await ctx.commitChanges({
      author: group.change?.client ?? client,
      time: Math.min(group.change?.time ?? ctx.now, ctx.now),
      message:
        group.change?.message ??
        `sync: ${n} ${n === 1 ? 'note' : 'notes'} from ${group.change?.client ?? client}`,
    });
    for (const m of committed?.mutations ?? []) ownMutations.add(m);
  }

  // --- Log entries and change records (ids the brain has are skipped).
  if (request.events.length > 0 || request.changes.length > 0) {
    await ctx.engine.applyRemote({ events: request.events, changes: request.changes });
  }
  // Number them now, so this response can carry entries appended for the first time.
  await ctx.numberEntries();

  // --- The response page: everything after `since`, through `end`.
  const pushedEvents = new Set(request.events.map((e) => e.id));
  const pushedChanges = new Set(request.changes.map((c) => c.id));
  const page = await readPage(ctx, request.since, pageSize, ownMutations);
  return {
    mutation: page.end,
    more: page.more,
    results: judged.map((j) => j.result),
    notes: page.notes,
    events: page.events.filter((e) => !pushedEvents.has(e.id)),
    changes: page.changes.filter((c) => !pushedChanges.has(c.id)),
  };
}

interface Page {
  readonly end: number;
  readonly more: boolean;
  readonly notes: sync.SyncNote[];
  readonly events: sync.SyncEvent[];
  readonly changes: sync.SyncChange[];
}

/** One page of everything after `since`: at most `pageSize` mutation numbers (and about `PAGE_TEXT_BYTES` of text). */
export async function readPage(
  ctx: BrainContext,
  since: number,
  pageSize: number,
  skipMutations: ReadonlySet<number> = new Set(),
): Promise<Page> {
  const id = ctx.brainId;
  const numbers = (
    await ctx.query<{ m: string }>(
      `SELECT DISTINCT m FROM (
         (SELECT mutation AS m FROM note_versions WHERE brain_id = $1 AND mutation > $2 ORDER BY mutation LIMIT $3)
         UNION ALL
         (SELECT mutation FROM events WHERE brain_id = $1 AND mutation > $2 ORDER BY mutation LIMIT $3)
         UNION ALL
         (SELECT mutation FROM changes WHERE brain_id = $1 AND mutation > $2 ORDER BY mutation LIMIT $3)
       ) x ORDER BY m LIMIT $3`,
      [id, since, pageSize + 1],
    )
  ).map((r) => Number(r.m));
  const counter = Number(
    (
      await ctx.query<{ m: string }>('SELECT mutation_seq AS m FROM brains WHERE brain_id = $1', [
        id,
      ])
    )[0]?.m ?? 0,
  );
  let more = numbers.length > pageSize;
  let end = more ? (numbers[pageSize - 1] as number) : counter;

  // Notes: each path's latest version in (since, end].
  const versions = await ctx.query<{
    path: string;
    mutation: string;
    hash: string | null;
    renamed_to: string | null;
    commit: string;
  }>(
    `SELECT DISTINCT ON (path) path, mutation, hash, renamed_to, commit FROM note_versions
     WHERE brain_id = $1 AND mutation > $2 AND mutation <= $3
     ORDER BY path, mutation DESC`,
    [id, since, end],
  );
  versions.sort((a, b) => Number(a.mutation) - Number(b.mutation) || (a.path < b.path ? -1 : 1));
  const wanted = versions.filter((v) => !skipMutations.has(Number(v.mutation)));
  const texts = await ctx.repo.readAt(
    wanted.filter((v) => v.hash !== null).map((v) => ({ commit: v.commit, path: v.path })),
  );
  const kept: { note: sync.SyncNote; mutation: number }[] = [];
  let bytes = 0;
  let t = 0;
  for (const v of wanted) {
    const mutation = Number(v.mutation);
    if (v.hash === null) {
      kept.push({
        mutation,
        note: v.renamed_to
          ? { path: v.path, renamedTo: v.renamed_to }
          : { path: v.path, deleted: true },
      });
      continue;
    }
    const text = texts[t++];
    if (text === undefined)
      throw new Error('a recorded note version is missing from the repository');
    const size = storage.utf8Length(text);
    if (bytes > 0 && bytes + size > PAGE_TEXT_BYTES && mutation > since + 1) {
      // Cut the page before this version's mutation; the rest comes next time.
      // (A path whose latest version was after the cut is sent then, at that version.)
      end = mutation - 1;
      more = true;
      break;
    }
    bytes += size;
    kept.push({ mutation, note: { path: v.path, hash: v.hash, text } });
  }
  // Only what this brain's config accepts now: a folder excluded after its
  // notes were stored is never sent (its versions stay in git).
  const classifier = markdown.createRoleClassifier(ctx.config.roles);
  const accepts = (path: string): boolean => {
    const role = classifier.classify(path)?.role;
    return role !== undefined && role !== 'excluded';
  };
  const excluded = (item: string) => coreEngine.isExcludedItem(classifier, item);
  const notes: sync.SyncNote[] = [];
  for (const k of kept) {
    if (k.mutation > end || !accepts(k.note.path)) continue;
    const n = k.note;
    if ('renamedTo' in n && !accepts(n.renamedTo)) notes.push({ path: n.path, deleted: true });
    else notes.push(n);
  }

  const eventRows = await ctx.query<{
    id: string;
    kind: string;
    item: string;
    time: string;
    client: string;
    target: string | null;
  }>(
    `SELECT id, kind, item, time, client, target FROM events
     WHERE brain_id = $1 AND mutation > $2 AND mutation <= $3 ORDER BY mutation`,
    [id, since, end],
  );
  const events: sync.SyncEvent[] = eventRows
    .filter((r) => !excluded(r.item) && !(r.target !== null && excluded(r.target)))
    .map((r) =>
      r.kind === 'rename'
        ? {
            id: r.id,
            kind: 'rename',
            item: r.item,
            to: r.target as string,
            time: Number(r.time),
            client: r.client,
          }
        : {
            id: r.id,
            kind: r.kind as timescore.EventKind,
            item: r.item,
            time: Number(r.time),
            client: r.client,
          },
    );
  const changeRows = await ctx.query<{
    seq: string;
    id: string;
    time: string;
    client: string;
    message: string | null;
    op: string | null;
  }>(
    `SELECT seq, id, time, client, message, op FROM changes
     WHERE brain_id = $1 AND mutation > $2 AND mutation <= $3 ORDER BY mutation`,
    [id, since, end],
  );
  const pathRows = changeRows.length
    ? await ctx.query<{ change_seq: string; path: string }>(
        `SELECT change_seq, path FROM change_paths WHERE brain_id = $1 AND change_seq = ANY($2::int8[])`,
        [id, changeRows.map((r) => r.seq)],
      )
    : [];
  const pathsOf = new Map<string, string[]>();
  for (const p of pathRows) {
    const list = pathsOf.get(String(p.change_seq)) ?? [];
    list.push(p.path);
    pathsOf.set(String(p.change_seq), list);
  }
  const changes: sync.SyncChange[] = changeRows
    .map((r) => ({
      id: r.id,
      time: Number(r.time),
      client: r.client,
      message: r.message,
      op: r.op,
      paths: storage.normalizeChangePaths(pathsOf.get(String(r.seq)) ?? []),
    }))
    .filter((c) => !c.paths.some(excluded));
  return { end, more, notes, events, changes };
}
