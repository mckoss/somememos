// The brain engine (IMPLEMENTATION.md tasks 2.0 and 2.2): one object over a
// brain's stores and content that every host calls. The CLI commands run it
// over SQLite files and the file system; the web app's worker over SQLite in
// the browser. Isomorphic.

import { runIndexPass, type IndexSummary } from '../indexing/pass.js';
import { matchesAllClauses, parseQuery } from '../keyword/query.js';
import { firstIndexedAt, readUncommitted, writeUncommitted } from '../indexing/state.js';
import * as markdown from '../markdown/index.js';
import { decayed } from '../ranking/decayed.js';
import { isRankMode, rankingParamsFromConfig, type RankMode } from '../ranking/params.js';
import type { RankedResult } from '../ranking/rank.js';
import { rankActivation, rankSearch } from '../ranking/stores.js';
import { foldOptions, type BrainConfig } from '../storage/config.js';
import { contentHash, type ContentStore } from '../storage/content.js';
import { foldPending } from '../storage/fold.js';
import type {
  ChangeInput,
  ChangeRecord,
  LogInput,
  NoteRecord,
  NoteRole,
  Stores,
} from '../storage/types.js';
import { changeOp, newId, normalizeChangePaths, unixNow } from '../storage/validate.js';
import { createSyncMethods } from './sync.js';
import {
  EngineError,
  type ChangeOptions,
  type CommitOptions,
  type CommitResult,
  type DeleteResult,
  type DiaryEntry,
  type DiaryPath,
  type Engine,
  type EngineStatus,
  type ExportRecord,
  type Finite,
  type ImportResult,
  type IndexOptions,
  type ListOptions,
  type LogOptions,
  type NoteTitle,
  type NoteView,
  type ReadNoteOptions,
  type RenameResult,
  type ResultView,
  type SaveNoteOptions,
  type SaveResult,
  type SearchOptions,
  type SearchResponse,
} from './types.js';

export interface EngineOptions {
  readonly stores: Stores;
  readonly content: ContentStore;
  readonly config: BrainConfig;
  /** The clock, whole Unix seconds. Default: the system clock. Use the stores' clock. */
  readonly now?: () => number;
}

/** Results per search or list when no limit is given. */
export const DEFAULT_RESULT_LIMIT = 20;

/** Deep copy with every non-finite number replaced by null (`Finite<T>`). */
export function finite<T>(value: T): Finite<T> {
  if (typeof value === 'number') return (Number.isFinite(value) ? value : null) as Finite<T>;
  if (Array.isArray(value)) return value.map((v) => finite(v)) as Finite<T>;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = finite(v);
    return out as Finite<T>;
  }
  return value as Finite<T>;
}

/** The local calendar date of a Unix time, `YYYY-MM-DD`, in the host's time zone. */
export function localDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Whether `path` is `filter` or lies inside the folder `filter` (`''` is the whole brain). */
export function pathCovers(filter: string, path: string): boolean {
  const f = filter.replace(/\/+$/, '');
  return f === '' || path === f || path.startsWith(`${f}/`);
}

/**
 * A brain-relative note path, normalized (`./` and `..` applied, no leading
 * `/`), or an `EngineError('invalid-path')`.
 */
export function normalizeNotePath(path: string): string {
  if (typeof path !== 'string' || path.trim() === '' || path.startsWith('/')) {
    throw new EngineError('invalid-path', `not a brain-relative path: ${JSON.stringify(path)}`);
  }
  const normalized = markdown.normalizePath(path);
  if (normalized === null || normalized === '' || !markdown.isMarkdownPath(normalized)) {
    throw new EngineError('invalid-path', `not a markdown note path inside the brain: ${path}`);
  }
  return normalized;
}

function isDateString(value: string): boolean {
  return markdown.parseCalendarDate(value) !== null;
}

/** Creates the engine for one brain. The host owns `stores` and closes them. */
export function createEngine(options: EngineOptions): Engine {
  const { stores, content, config } = options;
  const now = options.now ?? unixNow;
  const classifier = markdown.createRoleClassifier(config.roles);
  const rankingInput = rankingParamsFromConfig(config);

  // Calls run one at a time, in order.
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };

  /** The role of a note path, or an EngineError for excluded and role-less paths. */
  const roleOf = (path: string): NoteRole => {
    const match = classifier.classify(path);
    if (match?.role === 'excluded') {
      throw new EngineError('excluded', 'that path is excluded from somememos', null);
    }
    if (!match) {
      throw new EngineError('not-found', `${path} has no role in this brain's config`, path);
    }
    return match.role;
  };

  /** A blog post's publish state, read from its front matter; null for other roles. */
  const publishedOf = async (note: NoteRecord): Promise<boolean | null> => {
    if (note.role !== 'blog') return null;
    const text = await content.read(note.path);
    return text === undefined ? false : markdown.isPublished(text);
  };

  const pass = (opts: IndexOptions & { readonly record?: boolean } = {}): Promise<IndexSummary> =>
    runIndexPass({
      stores,
      content,
      config,
      classifier,
      now,
      ...(opts.rebuild ? { rebuild: true } : {}),
      ...(opts.paths && opts.paths.length > 0 ? { paths: opts.paths } : {}),
      ...(opts.record === false ? { record: false } : {}),
    });

  /** Appends one change record for `paths` and drops them from the uncommitted list. Under the index lock. */
  const recordChange = async (
    paths: readonly string[],
    message: string | null | undefined,
  ): Promise<ChangeRecord> => {
    const msg = message?.trim() ? message.trim() : null;
    const input: ChangeInput = {
      id: newId(),
      time: now(),
      client: config.clientId,
      message: msg,
      op: changeOp(msg, config.changeOps),
      paths: normalizeChangePaths(paths),
    };
    await stores.events.appendChanges([input]);
    const covered = new Set(input.paths);
    await writeUncommitted(
      stores.meta,
      (await readUncommitted(stores.meta)).filter((p) => !covered.has(p)),
    );
    // The stored record carries its seq; find it (newest first, so it is near the top).
    const stored = (await stores.events.changes({ since: input.time, limit: 50 })).find(
      (c) => c.id === input.id,
    );
    return stored ?? { ...input, seq: 0 };
  };

  const view = async (
    results: readonly RankedResult[],
    mode: RankMode,
    query: string | null,
  ): Promise<SearchResponse> => {
    const at = now();
    const notes = new Map<string, NoteRecord>();
    const published = new Map<string, boolean | null>();
    const displays = new Map<string, string>();
    if (results.some((r) => r.dangling)) {
      for (const d of await stores.notes.danglingTargets()) displays.set(d.key, d.display);
    }
    for (const r of results) {
      if (r.path === null || notes.has(r.path)) continue;
      const n = await stores.notes.getNote(r.path);
      if (n) {
        notes.set(r.path, n);
        published.set(r.path, await publishedOf(n));
      }
    }
    return {
      mode,
      query,
      at,
      results: results.map((r): ResultView => {
        const note = r.path === null ? undefined : notes.get(r.path);
        return {
          item: r.item,
          path: r.path,
          dangling: r.dangling,
          title: r.dangling ? (displays.get(r.item) ?? r.title) : r.title,
          role: note?.role ?? null,
          date: note?.date ?? null,
          published: r.path === null ? null : (published.get(r.path) ?? null),
          sectionId: r.sectionId,
          heading: r.heading,
          snippet: r.snippet,
          rankKey: Number.isFinite(r.rankKey) ? r.rankKey : null,
          components: finite(r.components),
          now: finite(decayed(r.components, at, config.halfLives)),
        };
      }),
    };
  };

  const checkMode = (mode: unknown): RankMode => {
    if (!isRankMode(mode)) {
      throw new EngineError('invalid-argument', `unknown mode: ${String(mode)}`);
    }
    return mode;
  };

  const checkLimit = (limit: number | undefined): number => {
    const n = limit ?? DEFAULT_RESULT_LIMIT;
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new EngineError('invalid-argument', `limit must be an integer >= 0, not ${limit}`);
    }
    return n;
  };

  const listImpl = async (mode: RankMode, limit: number): Promise<SearchResponse> => {
    const ranked = await rankActivation(stores, mode, { ...rankingInput, limit });
    return view(ranked, mode, null);
  };

  const diaryPathImpl = (date: string | undefined): DiaryPath => {
    const pattern = classifier.datedPatterns[0];
    if (pattern === undefined) {
      throw new EngineError(
        'no-dated-pattern',
        'this brain declares no dated pattern; add one to "roles" in its config, e.g. "dated": ["diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md"]',
      );
    }
    const day = date ?? localDate(now());
    if (!isDateString(day)) {
      throw new EngineError('invalid-argument', `not a calendar date like 2026-01-31: ${day}`);
    }
    let path: string;
    try {
      path = markdown.renderDatedPath(pattern, day);
    } catch (error) {
      throw new EngineError(
        'no-dated-pattern',
        `the first dated pattern '${pattern}' cannot name an entry: ${(error as Error).message}`,
      );
    }
    if (classifier.classify(path)?.role !== 'dated') {
      throw new EngineError(
        'no-dated-pattern',
        `the first dated pattern '${pattern}' names a path whose role is not dated; check the roles in the config`,
      );
    }
    return { path, date: day };
  };

  const sync = createSyncMethods({
    stores,
    content,
    config,
    classifier,
    now,
    pass: (opts = {}) => pass(opts),
    recordChange: (paths, message) => recordChange(paths, message),
    today: () => localDate(now()),
  });

  const engine: Engine = {
    config,

    applyRemote: (input) => serial(() => sync.applyRemote(input ?? {})),
    syncStatus: () => serial(() => sync.syncStatus()),
    prepareSync: (opts) => serial(() => sync.prepareSync(opts)),
    applySync: (prepared, response) => serial(() => sync.applySync(prepared, response)),
    resetSync: () => serial(() => sync.resetSync()),

    index: (opts = {}) => serial(() => pass(opts)),

    search: (query, opts: SearchOptions = {}) =>
      serial(async () => {
        const mode = checkMode(opts.mode ?? 'hot');
        const limit = checkLimit(opts.limit);
        for (const d of [opts.since, opts.until]) {
          if (d !== undefined && !isDateString(d)) {
            throw new EngineError('invalid-argument', `not a calendar date like 2026-01-31: ${d}`);
          }
        }
        if (typeof query !== 'string' || query.trim() === '') return listImpl(mode, limit);
        const dated = opts.since !== undefined || opts.until !== undefined;
        let ranked = await rankSearch(stores, query, {
          ...rankingInput,
          mode,
          ...(dated ? { searchRoles: ['dated', 'blog'] as const } : { limit }),
        });
        if (dated) {
          const inRange = async (r: RankedResult): Promise<boolean> => {
            const date = r.path === null ? null : (await stores.notes.getNote(r.path))?.date;
            if (!date) return false;
            if (opts.since !== undefined && date < opts.since) return false;
            if (opts.until !== undefined && date > opts.until) return false;
            return true;
          };
          const kept: RankedResult[] = [];
          for (const r of ranked) {
            if (kept.length >= limit) break;
            if (await inRange(r)) kept.push(r);
          }
          ranked = kept;
        }
        return view(ranked, mode, query);
      }),

    list: (mode = 'hot', opts: ListOptions = {}) =>
      serial(() => listImpl(checkMode(mode), checkLimit(opts.limit))),

    readNote: (rawPath, opts: ReadNoteOptions = {}) =>
      serial(async (): Promise<NoteView> => {
        const path = normalizeNotePath(rawPath);
        const role = roleOf(path);
        const text = await content.read(path);
        if (text === undefined) throw new EngineError('not-found', `no note at ${path}`, path);
        const hash = await contentHash(text);
        let note = await stores.notes.getNote(path);
        if (!note || note.contentHash !== hash || note.role !== role) {
          await pass({ paths: [path] });
          note = await stores.notes.getNote(path);
        }
        if (!note) throw new EngineError('not-found', `no note at ${path}`, path);
        let recorded = false;
        if ((opts.record ?? true) && markdown.isScoredRole(note.role)) {
          const time = now();
          const event: LogInput = {
            id: newId(),
            kind: 'read',
            item: path,
            time,
            client: config.clientId,
          };
          await stores.events.append([event], { now: time });
          await foldPending(stores.events, stores.scores, foldOptions(config));
          recorded = true;
        }
        return {
          path,
          text,
          hash,
          mtime: note.mtime,
          title: note.title,
          role: note.role,
          date: note.date,
          published: note.role === 'blog' ? markdown.isPublished(text) : null,
          sections: (await stores.terms.sectionsOf(path)).map((s) => ({
            index: s.index,
            heading: s.heading,
            startLine: s.startLine,
            endLine: s.endLine,
          })),
          links: await stores.notes.linksFrom(path),
          backlinks: await stores.notes.backlinks(path),
          recorded,
        };
      }),

    saveNote: (rawPath, text, opts: SaveNoteOptions = {}) =>
      serial(async (): Promise<SaveResult> => {
        if (typeof text !== 'string')
          throw new EngineError('invalid-argument', 'text must be a string');
        const path = normalizeNotePath(rawPath);
        const role = roleOf(path);
        const existing = await content.stat(path);
        let currentText: string | null = null;
        let currentHash: string | null = null;
        if (existing) {
          currentText = (await content.read(path)) ?? null;
          currentHash = currentText === null ? null : await contentHash(currentText);
        }
        if (opts.baseHash !== undefined && opts.baseHash !== currentHash) {
          return { status: 'conflict', path, baseHash: opts.baseHash, currentHash, currentText };
        }
        const hash = await contentHash(text);
        if (currentHash !== null && currentHash === hash)
          return { status: 'unchanged', path, hash };
        if (role === 'source' && currentHash !== null) {
          throw new EngineError(
            'source-immutable',
            `${path} is a source; sources are immutable once they exist`,
            path,
          );
        }
        const written = await content.write(path, text, { mtime: now() });
        return stores.indexTransaction(async () => {
          const index = await pass({ paths: [path] });
          const change = await recordChange([path], opts.message);
          return {
            status: 'saved' as const,
            path,
            hash,
            created: currentHash === null,
            mtime: written.mtime,
            change,
            index,
          };
        });
      }),

    renameNote: (rawFrom, rawTo, opts: ChangeOptions = {}) =>
      serial(async (): Promise<RenameResult> => {
        const from = normalizeNotePath(rawFrom);
        const to = normalizeNotePath(rawTo);
        roleOf(from);
        roleOf(to);
        if (from === to)
          throw new EngineError('invalid-argument', 'a note cannot be renamed to itself');
        if (!(await content.stat(from)))
          throw new EngineError('not-found', `no note at ${from}`, from);
        if (await content.stat(to)) throw new EngineError('exists', `a note exists at ${to}`, to);
        await content.rename(from, to);
        return stores.indexTransaction(async () => {
          const index = await pass({ paths: [from, to] });
          const change = await recordChange([from, to], opts.message);
          return { status: 'renamed' as const, from, to, change, index };
        });
      }),

    deleteNote: (rawPath, opts: ChangeOptions = {}) =>
      serial(async (): Promise<DeleteResult> => {
        const path = normalizeNotePath(rawPath);
        roleOf(path);
        if (!(await content.remove(path))) {
          throw new EngineError('not-found', `no note at ${path}`, path);
        }
        return stores.indexTransaction(async () => {
          const index = await pass({ paths: [path] });
          const change = await recordChange([path], opts.message);
          return { status: 'deleted' as const, path, change, index };
        });
      }),

    commit: (opts: CommitOptions = {}) =>
      serial(() =>
        stores.indexTransaction(async (): Promise<CommitResult> => {
          const index = await pass();
          const pending = await readUncommitted(stores.meta);
          const filters = opts.paths ?? [];
          const selected =
            filters.length === 0
              ? pending
              : pending.filter((p) => filters.some((f) => pathCovers(f, p)));
          const chosen = new Set(selected);
          const remaining = pending.filter((p) => !chosen.has(p));
          if (selected.length === 0) return { committed: false, change: null, remaining, index };
          const change = await recordChange(selected, opts.message);
          return { committed: true, change, remaining, index };
        }),
      ),

    log: (opts: LogOptions = {}) =>
      serial(async () => {
        if (opts.query !== undefined && typeof opts.query !== 'string') {
          throw new EngineError('invalid-argument', 'query must be a string');
        }
        const query = opts.query?.trim() ? parseQuery(opts.query, stores.terms.analyzer) : null;
        const changes = await stores.events.changes({
          ...(opts.path !== undefined ? { path: opts.path } : {}),
          ...(opts.op !== undefined ? { op: opts.op } : {}),
          ...(opts.since !== undefined ? { since: opts.since } : {}),
          ...(opts.until !== undefined ? { until: opts.until } : {}),
          ...(opts.all && opts.limit !== undefined && !query ? { limit: opts.limit } : {}),
        });
        // A message search scans the change records, newest first; at personal-brain
        // scale (thousands of records) that is a few milliseconds, so there is no index.
        const matching = query
          ? changes.filter(
              (c) =>
                c.message !== null && matchesAllClauses(c.message, query, stores.terms.analyzer),
            )
          : changes;
        const shown = opts.all
          ? matching
          : matching.filter(
              (c) =>
                c.paths.length === 0 ||
                c.paths.some((p) => classifier.classify(p)?.role !== 'dated'),
            );
        return opts.limit === undefined ? shown : shown.slice(0, Math.max(0, opts.limit));
      }),

    status: () =>
      serial(async (): Promise<EngineStatus> => {
        const notes = await stores.notes.listNotes();
        const byRole = { memo: 0, dated: 0, source: 0, blog: 0 };
        for (const n of notes) byRole[n.role]++;
        return {
          clientId: config.clientId,
          notes: { total: notes.length, ...byRole },
          sections: (await stores.terms.statistics()).sectionCount,
          dangling: (await stores.notes.danglingTargets()).length,
          events: await stores.events.countByKind(),
          changes: (await stores.events.changes()).length,
          uncommitted: await readUncommitted(stores.meta),
          fold: {
            cursor: (await stores.scores.foldState()).cursor,
            lastSeq: await stores.events.lastSeq(),
          },
          firstIndexedAt: await firstIndexedAt(stores.meta),
          config: {
            weights: config.weights,
            alpha: config.alpha,
            halfLives: config.halfLives,
            burstWindow: config.burstWindow,
            roles: config.roles,
            analyzer: config.analyzer,
            changeOps: config.changeOps,
          },
        };
      }),

    noteTitles: () =>
      serial(async () => {
        const out: NoteTitle[] = [];
        for (const n of await stores.notes.listNotes()) {
          out.push({
            path: n.path,
            title: n.title,
            role: n.role,
            date: n.date,
            published: await publishedOf(n),
          });
        }
        return out;
      }),

    danglingLinks: () => serial(async () => stores.notes.danglingTargets()),

    diaryPath: (date) => serial(async () => diaryPathImpl(date)),

    ensureDiary: (date) =>
      serial(async (): Promise<DiaryEntry> => {
        const { path, date: day } = diaryPathImpl(date);
        if (await content.stat(path)) return { path, date: day, created: false };
        await content.write(path, `# ${day}\n`, { mtime: now() });
        await pass({ paths: [path] });
        return { path, date: day, created: true };
      }),

    exportLog: () =>
      serial(async () => {
        const records: { time: number; order: number; record: ExportRecord }[] = [];
        let order = 0;
        for (const e of await stores.events.readAfter(0)) {
          const record: ExportRecord =
            e.kind === 'rename'
              ? {
                  type: 'log',
                  id: e.id,
                  kind: e.kind,
                  item: e.item,
                  to: e.to,
                  time: e.time,
                  client: e.client,
                }
              : {
                  type: 'log',
                  id: e.id,
                  kind: e.kind,
                  item: e.item,
                  time: e.time,
                  client: e.client,
                };
          records.push({ time: e.time, order: order++, record });
        }
        for (const c of (await stores.events.changes()).reverse()) {
          records.push({
            time: c.time,
            order: order++,
            record: {
              type: 'change',
              id: c.id,
              time: c.time,
              client: c.client,
              message: c.message,
              op: c.op,
              paths: [...c.paths],
            },
          });
        }
        records.sort((a, b) => a.time - b.time || a.order - b.order);
        return records.map((r) => `${JSON.stringify(r.record)}\n`).join('');
      }),

    importLog: (entries) =>
      serial(async (): Promise<ImportResult> => {
        const records = typeof entries === 'string' ? parseExport(entries) : entries;
        const log: LogInput[] = [];
        const changes: ChangeInput[] = [];
        for (const r of records) {
          if (r.type === 'log') {
            if (r.kind === 'rename') {
              if (typeof r.to !== 'string') {
                throw new EngineError('invalid-argument', `rename record ${r.id} has no "to"`);
              }
              log.push({
                id: r.id,
                kind: 'rename',
                item: r.item,
                to: r.to,
                time: r.time,
                client: r.client,
              });
            } else {
              log.push({ id: r.id, kind: r.kind, item: r.item, time: r.time, client: r.client });
            }
          } else if (r.type === 'change') {
            changes.push({
              id: r.id,
              time: r.time,
              client: r.client,
              message: r.message ?? null,
              op: r.op ?? null,
              paths: r.paths ?? [],
            });
          } else {
            throw new EngineError(
              'invalid-argument',
              `unknown record type: ${String((r as { type?: unknown }).type)}`,
            );
          }
        }
        const appendedLog = await stores.events.append(log);
        const appendedChanges = await stores.events.appendChanges(changes);
        const f = await foldPending(stores.events, stores.scores, foldOptions(config));
        return {
          log: appendedLog,
          changes: appendedChanges,
          folded: { events: f.events, renames: f.renames },
        };
      }),
  };
  return engine;
}

/** Parses `events.jsonl` text into records (blank lines skipped). */
export function parseExport(text: string): ExportRecord[] {
  const out: ExportRecord[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new EngineError(
        'invalid-argument',
        `line ${i + 1} is not JSON: ${(error as Error).message}`,
      );
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new EngineError('invalid-argument', `line ${i + 1} is not a JSON object`);
    }
    out.push(value as ExportRecord);
  });
  return out;
}
