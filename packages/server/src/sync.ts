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
import { HttpError } from './errors.js';
import { parseRequest, syncCodes } from './requests.js';
import { folderClash } from './git-content.js';

type Edit = sync.SyncEdit;

/**
 * Validates a sync request for a brain with `classifier`'s roles: its shape
 * and limits (`sync.SyncRequestSchema`, errors as `syncCodes` maps them),
 * then what needs the brain or the clock. Throws an `HttpError` (400, 403,
 * 413 or 422) naming the problem, never a path; nothing is changed by an
 * invalid request.
 */
export function parseSyncRequest(
  body: unknown,
  classifier: markdown.RoleClassifier,
  now: number,
): sync.SyncRequest {
  const request = parseRequest(sync.SyncRequestSchema, body, syncCodes);
  const invalid = (message: string, code = 'invalid-request') => new HttpError(400, code, message);

  // Edits: distinct ids and paths, and every path accepted by the brain's roles.
  const role = (path: string, where: string): void => {
    const r = classifier.classify(path)?.role;
    if (r === 'excluded') throw new HttpError(403, 'excluded', `${where}: that path is excluded`);
    if (r === undefined) {
      throw invalid(`${where}: the path has no role in this brain's config`, 'no-role');
    }
  };
  const ids = new Set<string>();
  const paths = new Set<string>();
  request.edits.forEach((edit, i) => {
    const where = `edit ${i + 1}`;
    if (ids.has(edit.id)) throw invalid(`${where}: duplicate id`);
    ids.add(edit.id);
    for (const path of edit.op === 'rename' ? [edit.path, edit.to] : [edit.path]) {
      role(path, where);
      if (paths.has(path))
        throw invalid(`${where}: a path may appear in only one edit per request`);
      paths.add(path);
    }
  });

  // Log entries and change records: not ahead of this clock, and naming no excluded path.
  const at = now + sync.SYNC_CLOCK_SKEW;
  const future = (where: string) =>
    new HttpError(
      422,
      'future-event',
      `${where} is dated in the future; is this device's clock right?`,
    );
  const excluded = (item: string) => coreEngine.isExcludedItem(classifier, item);
  request.events.forEach((e, i) => {
    const where = `event ${i + 1}`;
    if (e.time > at) throw future(where);
    if (excluded(e.item) || (e.kind === 'rename' && excluded(e.to))) {
      throw new HttpError(403, 'excluded', `${where} names an excluded path`);
    }
  });
  request.changes.forEach((c, i) => {
    const where = `change ${i + 1}`;
    if (c.time > at) throw future(where);
    if (c.paths.some(excluded))
      throw new HttpError(403, 'excluded', `${where} names an excluded path`);
  });
  return request;
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
const editPaths = (edit: Edit): string[] =>
  edit.op === 'rename' ? [edit.path, edit.to] : [edit.path];

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
