// The engine's sync methods (PLAN.md section 7): storing changes that
// arrived from elsewhere without logging events (`applyRemote`, used by the
// server and by offline copies), and an offline copy's side of the protocol
// (`prepareSync`, `applySync`). Wired into `createEngine`, which serializes
// them with every other call. Isomorphic.

import type { IndexSummary } from '../indexing/pass.js';
import * as markdown from '../markdown/index.js';
import type { BrainConfig } from '../storage/config.js';
import { contentHash, sha256Hex, utf8Length, type ContentStore } from '../storage/content.js';
import { foldPending } from '../storage/fold.js';
import type {
  AppendResult,
  ChangeInput,
  ChangeRecord,
  LogEntry,
  LogInput,
  Stores,
} from '../storage/types.js';
import {
  SYNC_CLOCK_SKEW,
  SYNC_LIMITS,
  conflictPath,
  isSyncablePath,
  type SyncChange,
  type SyncEdit,
  type SyncEvent,
  type SyncNote,
  type SyncResponse,
} from '../sync/protocol.js';
import { readSyncState, writeSyncState, clearSyncState, type SyncState } from '../sync/state.js';
import {
  EngineError,
  type Engine,
  type PrepareSyncOptions,
  type PreparedSync,
  type RemoteApplyInput,
  type RemoteApplyResult,
  type SyncConflict,
  type SyncOutcome,
  type SyncStatus,
} from './types.js';

/** What the sync methods need from the engine. */
export interface SyncContext {
  readonly stores: Stores;
  readonly content: ContentStore;
  readonly config: BrainConfig;
  readonly classifier: markdown.RoleClassifier;
  readonly now: () => number;
  /** An index pass (`record: false` logs nothing). */
  readonly pass: (opts?: {
    readonly paths?: readonly string[];
    readonly record?: boolean;
  }) => Promise<IndexSummary>;
  /** Appends a change record for `paths` (and drops them from the uncommitted list). */
  readonly recordChange: (
    paths: readonly string[],
    message: string | null,
  ) => Promise<ChangeRecord>;
  /** `localDate(now())`. */
  readonly today: () => string;
}

const DEFAULT_PREPARE: Required<PrepareSyncOptions> = {
  maxEdits: 200,
  maxEditBytes: 8 * 1024 * 1024,
  maxEvents: 5000,
  maxChanges: 1000,
};

/** A log entry on the wire. */
export function toSyncEvent(e: LogEntry | LogInput): SyncEvent {
  return e.kind === 'rename'
    ? { id: e.id, kind: 'rename', item: e.item, to: e.to, time: e.time, client: e.client }
    : { id: e.id, kind: e.kind, item: e.item, time: e.time, client: e.client };
}

/** A change record on the wire. */
export function toSyncChange(c: ChangeRecord | ChangeInput): SyncChange {
  return {
    id: c.id,
    time: c.time,
    client: c.client,
    message: c.message,
    op: c.op,
    paths: [...c.paths],
  };
}

function fromSyncEvent(e: SyncEvent): LogInput {
  return e.kind === 'rename'
    ? { id: e.id, kind: 'rename', item: e.item, to: e.to, time: e.time, client: e.client }
    : { id: e.id, kind: e.kind, item: e.item, time: e.time, client: e.client };
}

function fromSyncChange(c: SyncChange): ChangeInput {
  return {
    id: c.id,
    time: c.time,
    client: c.client,
    message: c.message ?? null,
    op: c.op ?? null,
    paths: [...(c.paths ?? [])],
  };
}

/**
 * True when a log item (a note path or a dangling key) names excluded
 * territory: the path, or the key read as a path, has the `excluded` role.
 * Such entries are never stored.
 */
export function isExcludedItem(classifier: markdown.RoleClassifier, item: string): boolean {
  const asPath = markdown.isMarkdownPath(item) ? item : `${item}.md`;
  return classifier.classify(asPath)?.role === 'excluded';
}

/** A deterministic edit id, so a repeated request carries the same ids. */
async function editId(parts: readonly (string | null)[]): Promise<string> {
  return `ed-${(await sha256Hex(parts.map((p) => p ?? '\u0001').join('\0'))).slice(0, 40)}`;
}

export function createSyncMethods(ctx: SyncContext) {
  const { stores, content, config, classifier, now } = ctx;

  /** True when a note path may be stored by sync here: syncable, with a role, not excluded. */
  const accepts = (path: string): boolean => {
    if (!isSyncablePath(path)) return false;
    const role = classifier.classify(path)?.role;
    return role !== undefined && role !== 'excluded';
  };

  const localHash = async (path: string): Promise<string | undefined> => {
    const entry = await content.stat(path);
    if (!entry) return undefined;
    if (entry.hash !== undefined) return entry.hash;
    const text = await content.read(path);
    return text === undefined ? undefined : contentHash(text);
  };

  /** Appends entries from elsewhere (excluded ones dropped), then folds. */
  const appendRemote = async (
    events: readonly SyncEvent[],
    changes: readonly SyncChange[],
  ): Promise<{ events: AppendResult; changes: AppendResult; skipped: number }> => {
    let skipped = 0;
    const log: LogInput[] = [];
    for (const e of events) {
      if (
        isExcludedItem(classifier, e.item) ||
        (e.kind === 'rename' && isExcludedItem(classifier, e.to))
      ) {
        skipped++;
        continue;
      }
      log.push(fromSyncEvent(e));
    }
    const records: ChangeInput[] = [];
    for (const c of changes) {
      if ((c.paths ?? []).some((p) => isExcludedItem(classifier, p))) {
        skipped++;
        continue;
      }
      records.push(fromSyncChange(c));
    }
    const at = now() + SYNC_CLOCK_SKEW;
    const appendedEvents =
      log.length > 0
        ? await stores.events.append(log, { now: at })
        : { appended: 0, duplicates: 0 };
    const appendedChanges =
      records.length > 0
        ? await stores.events.appendChanges(records, { now: at })
        : { appended: 0, duplicates: 0 };
    await foldPending(stores.events, stores.scores, { halfLives: config.halfLives });
    return { events: appendedEvents, changes: appendedChanges, skipped };
  };

  /** Writes note states as given (no base checks). Returns what it did; paths to re-index in `touched`. */
  const writeNotes = async (notes: readonly SyncNote[]) => {
    const written: string[] = [];
    const removed: string[] = [];
    const renamed: { from: string; to: string }[] = [];
    const touched = new Set<string>();
    let skipped = 0;
    for (const note of notes) {
      if (!accepts(note.path)) {
        skipped++;
        continue;
      }
      if ('text' in note) {
        if (typeof note.text !== 'string' || (await contentHash(note.text)) !== note.hash) {
          throw new EngineError('invalid-argument', 'a note from sync does not match its hash');
        }
        await content.write(note.path, note.text, { mtime: now() });
        written.push(note.path);
        touched.add(note.path);
      } else if (
        'renamedTo' in note &&
        accepts(note.renamedTo) &&
        (await content.stat(note.path))
      ) {
        if (await content.stat(note.renamedTo)) {
          await content.remove(note.path);
          removed.push(note.path);
        } else {
          await content.rename(note.path, note.renamedTo);
          renamed.push({ from: note.path, to: note.renamedTo });
          touched.add(note.renamedTo);
        }
        touched.add(note.path);
      } else if (await content.remove(note.path)) {
        removed.push(note.path);
        touched.add(note.path);
      }
    }
    return { written, removed, renamed, touched, skipped };
  };

  const applyRemote = async (input: RemoteApplyInput): Promise<RemoteApplyResult> => {
    // Local changes first, logged as the local edits they are.
    await ctx.pass();
    const w = await writeNotes(input.notes ?? []);
    const index = await ctx.pass({ paths: [...w.touched], record: false });
    const appended = await appendRemote(input.events ?? [], input.changes ?? []);
    return {
      written: w.written,
      removed: w.removed,
      renamed: w.renamed,
      skipped: w.skipped + appended.skipped,
      events: appended.events,
      changes: appended.changes,
      index,
    };
  };

  /** The synced notes this copy holds: path to hash (indexed, syncable, with a role). */
  const localNotes = async (): Promise<Map<string, string>> => {
    const out = new Map<string, string>();
    for (const n of await stores.notes.listNotes()) {
      if (isSyncablePath(n.path)) out.set(n.path, n.contentHash);
    }
    return out;
  };

  const lastChangeSeq = async (): Promise<number> => {
    let last = 0;
    for (const c of await stores.events.changes()) last = Math.max(last, c.seq);
    return last;
  };

  const changesAfter = async (cursor: number): Promise<ChangeRecord[]> =>
    (await stores.events.changes()).filter((c) => c.seq > cursor).sort((a, b) => a.seq - b.seq);

  const syncStatus = async (): Promise<SyncStatus> => {
    const state = await readSyncState(stores.meta);
    const local = await localNotes();
    let pendingNotes = 0;
    for (const [path, hash] of local) if (state.bases[path] !== hash) pendingNotes++;
    for (const path of Object.keys(state.bases)) if (!local.has(path)) pendingNotes++;
    return {
      since: state.since,
      pushedEventSeq: state.pushedEventSeq,
      pushedChangeSeq: state.pushedChangeSeq,
      synced: Object.keys(state.bases).length,
      lastSyncAt: state.lastSyncAt,
      pending: {
        notes: pendingNotes,
        events: Math.max(0, (await stores.events.lastSeq()) - state.pushedEventSeq),
        changes: (await changesAfter(state.pushedChangeSeq)).length,
      },
    };
  };

  const prepareSync = async (options: PrepareSyncOptions = {}): Promise<PreparedSync> => {
    const limits = { ...DEFAULT_PREPARE, ...options };
    for (const [key, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new EngineError('invalid-argument', `${key} must be a positive integer`);
      }
    }
    await ctx.pass();
    const state = await readSyncState(stores.meta);
    const local = await localNotes();
    const bases = state.bases;

    // --- Edits: the difference between the notes and their bases.
    const created = [...local.keys()].filter((p) => bases[p] === undefined).sort();
    const gone = Object.keys(bases)
      .filter((p) => !local.has(p))
      .sort();
    const changed = [...local.keys()]
      .filter((p) => bases[p] !== undefined && bases[p] !== local.get(p))
      .sort();
    // A base that vanished plus a new note with the same hash is a rename.
    const createdByHash = new Map<string, string[]>();
    for (const p of created) {
      const h = local.get(p) as string;
      const list = createdByHash.get(h);
      if (list) list.push(p);
      else createdByHash.set(h, [p]);
    }
    const planned: {
      op: SyncEdit['op'];
      path: string;
      to?: string;
      baseHash: string | null;
      hash?: string;
    }[] = [];
    const renamedTo = new Set<string>();
    for (const p of gone) {
      const base = bases[p] as string;
      const to = createdByHash.get(base)?.shift();
      if (to !== undefined) {
        planned.push({ op: 'rename', path: p, to, baseHash: base });
        renamedTo.add(to);
      } else {
        planned.push({ op: 'delete', path: p, baseHash: base });
      }
    }
    for (const p of changed) {
      planned.push({
        op: 'write',
        path: p,
        baseHash: bases[p] as string,
        hash: local.get(p) as string,
      });
    }
    for (const p of created) {
      if (!renamedTo.has(p))
        planned.push({ op: 'write', path: p, baseHash: null, hash: local.get(p) as string });
    }

    const edits: SyncEdit[] = [];
    const tooLarge: string[] = [];
    let bytes = 0;
    let more = false;
    for (const plan of planned) {
      if (edits.length >= limits.maxEdits) {
        more = true;
        break;
      }
      if (plan.op !== 'write') {
        edits.push({
          id: await editId([plan.op, plan.path, plan.to ?? null, plan.baseHash]),
          op: plan.op,
          path: plan.path,
          ...(plan.to !== undefined ? { to: plan.to } : {}),
          baseHash: plan.baseHash,
        });
        continue;
      }
      const text = await content.read(plan.path);
      if (text === undefined) continue; // vanished since the pass
      const size = utf8Length(text);
      if (size > SYNC_LIMITS.maxNoteBytes) {
        tooLarge.push(plan.path);
        continue;
      }
      if (bytes > 0 && bytes + size > limits.maxEditBytes) {
        more = true;
        break;
      }
      bytes += size;
      edits.push({
        id: await editId(['write', plan.path, plan.baseHash, await contentHash(text)]),
        op: 'write',
        path: plan.path,
        baseHash: plan.baseHash,
        text,
      });
    }

    // --- Log entries and change records after the pushed cursors.
    const entries = await stores.events.readAfter(state.pushedEventSeq, {
      limit: limits.maxEvents,
    });
    if (
      entries.length === limits.maxEvents &&
      (await stores.events.lastSeq()) > (entries.at(-1)?.seq ?? 0)
    ) {
      more = true;
    }
    const allChanges = await changesAfter(state.pushedChangeSeq);
    const changes = allChanges.slice(0, limits.maxChanges);
    if (allChanges.length > changes.length) more = true;

    return {
      request: {
        since: state.since,
        client: config.clientId,
        events: entries.map(toSyncEvent),
        changes: changes.map(toSyncChange),
        edits,
      },
      cursor: {
        eventSeq: entries.at(-1)?.seq ?? state.pushedEventSeq,
        changeSeq: changes.at(-1)?.seq ?? state.pushedChangeSeq,
      },
      more,
      tooLarge,
    };
  };

  const applySync = async (
    prepared: PreparedSync,
    response: SyncResponse,
  ): Promise<SyncOutcome> => {
    const edits = prepared?.request?.edits;
    if (!Array.isArray(edits) || !response || !Array.isArray(response.results)) {
      throw new EngineError(
        'invalid-argument',
        'applySync needs a prepared request and its response',
      );
    }
    if (!Number.isSafeInteger(response.mutation) || response.mutation < prepared.request.since) {
      throw new EngineError(
        'invalid-argument',
        `the server's mutation number (${response.mutation}) is behind this copy's (${prepared.request.since}); was the server reset?`,
      );
    }
    const results = new Map(response.results.map((r) => [r.id, r]));

    // Local changes made since `prepareSync`, logged as local edits.
    await ctx.pass();
    const state: SyncState = await readSyncState(stores.meta);
    const bases: Record<string, string> = { ...state.bases };
    const touched = new Set<string>();
    const conflicts: SyncConflict[] = [];
    const conflictFiles: { path: string; original: string }[] = [];
    let applied = 0;
    let duplicates = 0;

    const takeServerVersion = async (
      path: string,
      hash: string | null | undefined,
      text: string | null | undefined,
    ) => {
      if (typeof text === 'string' && typeof hash === 'string') {
        await content.write(path, text, { mtime: now() });
        bases[path] = hash;
      } else {
        await content.remove(path);
        delete bases[path];
      }
      touched.add(path);
    };

    for (const edit of edits) {
      const result = results.get(edit.id);
      if (!result) {
        throw new EngineError(
          'invalid-argument',
          'the response has no result for an edit that was sent',
        );
      }
      if (result.status === 'applied' || result.status === 'duplicate') {
        if (result.status === 'applied') applied++;
        else duplicates++;
        if (edit.op === 'write') {
          bases[edit.path] =
            typeof result.hash === 'string' ? result.hash : await contentHash(edit.text ?? '');
        } else if (edit.op === 'delete') {
          delete bases[edit.path];
        } else if (edit.to !== undefined) {
          delete bases[edit.path];
          bases[edit.to] =
            typeof result.hash === 'string' ? result.hash : (edit.baseHash as string);
        }
        continue;
      }
      // Conflict or refused: keep this copy's version beside the server's.
      const localPath = edit.op === 'rename' && edit.to !== undefined ? edit.to : edit.path;
      let kept: string | null = null;
      if (edit.op !== 'delete') {
        const text = await content.read(localPath);
        if (text !== undefined && (await contentHash(text)) !== result.currentHash) {
          const taken = new Set<string>();
          for (const e of await content.list()) taken.add(e.path);
          kept = conflictPath(localPath, config.clientId, ctx.today(), (p) => taken.has(p));
          await content.write(kept, text, { mtime: now() });
          touched.add(kept);
          conflictFiles.push({ path: kept, original: edit.path });
        }
        if (localPath !== edit.path) {
          await content.remove(localPath);
          touched.add(localPath);
        }
      }
      await takeServerVersion(edit.path, result.currentHash, result.currentText);
      conflicts.push({
        path: edit.path,
        status: result.status === 'refused' ? 'refused' : 'conflict',
        code: result.code ?? null,
        conflictPath: kept,
      });
    }

    // The server's notes, unless this copy changed them since the last sync.
    const waiting: string[] = [];
    let skipped = 0;
    for (const note of response.notes ?? []) {
      if (!accepts(note.path)) {
        skipped++;
        continue;
      }
      const mine = await localHash(note.path);
      const base = bases[note.path];
      if ('text' in note) {
        if (mine === note.hash) {
          bases[note.path] = note.hash;
        } else if (mine === base) {
          if ((await contentHash(note.text)) !== note.hash) {
            throw new EngineError('invalid-argument', 'a note from sync does not match its hash');
          }
          await content.write(note.path, note.text, { mtime: now() });
          bases[note.path] = note.hash;
          touched.add(note.path);
        } else {
          waiting.push(note.path);
        }
      } else if (mine === undefined) {
        delete bases[note.path];
      } else if (mine === base) {
        await content.remove(note.path);
        delete bases[note.path];
        touched.add(note.path);
      } else {
        waiting.push(note.path);
      }
    }

    await ctx.pass({ paths: [...touched], record: false });

    // Entries: remember whether anything local is waiting to be pushed
    // before the server's entries are appended after it. If not, the cursor
    // moves past them, so they are not pushed back.
    const pushedEventSeq = Math.max(state.pushedEventSeq, prepared.cursor.eventSeq);
    const pushedChangeSeq = Math.max(state.pushedChangeSeq, prepared.cursor.changeSeq);
    const eventsCaughtUp = (await stores.events.lastSeq()) === pushedEventSeq;
    const changesCaughtUp = (await lastChangeSeq()) === pushedChangeSeq;
    const appended = await appendRemote(response.events ?? [], response.changes ?? []);
    skipped += appended.skipped;
    const nextEventSeq = eventsCaughtUp ? await stores.events.lastSeq() : pushedEventSeq;
    const nextChangeSeq = changesCaughtUp ? await lastChangeSeq() : pushedChangeSeq;

    // Each conflict file gets a change record of its own (after the cursor, so it is pushed).
    for (const file of conflictFiles) {
      await ctx.recordChange(
        [file.path],
        `sync conflict: kept this copy's version of ${file.original}`,
      );
    }

    await writeSyncState(stores.meta, {
      since: response.mutation,
      pushedEventSeq: nextEventSeq,
      pushedChangeSeq: nextChangeSeq,
      bases,
      lastSyncAt: now(),
    });

    return {
      mutation: response.mutation,
      // A conflict file, or a note waiting behind a local change, is pushed next round.
      more:
        Boolean(response.more) || prepared.more || conflictFiles.length > 0 || waiting.length > 0,
      pushed: {
        edits: edits.length,
        applied,
        duplicates,
        events: prepared.request.events.length,
        changes: prepared.request.changes.length,
      },
      conflicts,
      received: {
        notes: (response.notes ?? []).length,
        events: appended.events.appended,
        changes: appended.changes.appended,
      },
      waiting,
      skipped,
    };
  };

  return {
    applyRemote,
    syncStatus,
    prepareSync,
    applySync,
    resetSync: () => clearSyncState(stores.meta),
  };
}

/** Sends one sync request and returns the server's response (over HTTP, or directly in tests). */
export type SyncTransport = (request: PreparedSync['request']) => Promise<SyncResponse>;

export interface RunSyncResult {
  /** Rounds made (requests sent). */
  readonly rounds: number;
  readonly mutation: number;
  readonly conflicts: SyncConflict[];
  readonly waiting: string[];
  readonly outcomes: SyncOutcome[];
}

/**
 * Syncs until nothing is left to push or pull: `prepareSync`, `send`,
 * `applySync`, repeated while the outcome says `more` (at most `maxRounds`
 * times). Calls made on the engine meanwhile (a read, a save) run between
 * rounds; anything they change is picked up by the next round.
 */
export async function runSync(
  engine: Pick<Engine, 'prepareSync' | 'applySync'>,
  send: SyncTransport,
  options: PrepareSyncOptions & { readonly maxRounds?: number } = {},
): Promise<RunSyncResult> {
  const { maxRounds = 1000, ...prepare } = options;
  const outcomes: SyncOutcome[] = [];
  for (let round = 1; round <= maxRounds; round++) {
    const prepared = await engine.prepareSync(prepare);
    const response = await send(prepared.request);
    const outcome = await engine.applySync(prepared, response);
    outcomes.push(outcome);
    if (!outcome.more) {
      return {
        rounds: round,
        mutation: outcome.mutation,
        conflicts: outcomes.flatMap((o) => o.conflicts),
        waiting: outcome.waiting,
        outcomes,
      };
    }
  }
  throw new EngineError('invalid-argument', `sync did not finish in ${maxRounds} rounds`);
}
