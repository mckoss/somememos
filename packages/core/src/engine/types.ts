// The engine's request and result types: the contract between the brain
// logic and its hosts (the CLI commands, the web app's worker, later the
// server). Every argument and result is plain data that survives
// `JSON.stringify`/`JSON.parse` unchanged (no Map, no Date, no undefined that
// matters, no non-finite numbers), so it can cross a worker boundary or a
// network. Failures a caller must handle are results (`SaveResult` with
// status `'conflict'`); misuse throws an `EngineError` (see `toJSON`).

import type { IndexSummary } from '../indexing/pass.js';
import type { Snippet } from '../keyword/snippet.js';
import type { FolderRolesConfig } from '../markdown/roles.js';
import type { DecayedView } from '../ranking/decayed.js';
import type { RankComponents } from '../ranking/rank.js';
import type { RankMode } from '../ranking/params.js';
import type { BrainConfig } from '../storage/config.js';
import type {
  SyncChange,
  SyncEvent,
  SyncNote,
  SyncRequest,
  SyncResponse,
} from '../sync/protocol.js';
import type {
  AppendResult,
  ChangeRecord,
  DanglingCount,
  HalfLives,
  LogKind,
  NoteLink,
  NoteRole,
} from '../storage/types.js';

export type { IndexSummary } from '../indexing/pass.js';
export type { RankMode } from '../ranking/params.js';
export type { ChangeRecord, DanglingCount, NoteLink, NoteRole } from '../storage/types.js';

/**
 * `T` with every number widened to `number | null`: a non-finite number
 * (`-Infinity`, timescore's EMPTY log score: "no events") is sent as `null`.
 */
export type Finite<T> = T extends number
  ? number | null
  : T extends readonly (infer U)[]
    ? Finite<U>[]
    : T extends object
      ? { [K in keyof T]: Finite<T[K]> }
      : T;

// ---------------------------------------------------------------------------
// Errors

export type EngineErrorCode =
  /** Not a brain-relative markdown path (empty, absolute, climbs out, not `.md`). */
  | 'invalid-path'
  /** The path's role is `excluded`. Nothing about it is read, stored or logged. */
  | 'excluded'
  /** No such note, or the path has no role (roles are declared and none matches). */
  | 'not-found'
  /** A note already exists at the target of a rename. */
  | 'exists'
  /** The note is a `source`, which is immutable once it exists. */
  | 'source-immutable'
  /** The brain declares no `dated` pattern, so there is no diary. */
  | 'no-dated-pattern'
  /** Any other bad argument (a malformed date, an unknown mode, a bad export line). */
  | 'invalid-argument';

/** A request the engine refuses. Thrown; `toJSON()` gives `{ name, code, message, path }`. */
export class EngineError extends Error {
  override name = 'EngineError';
  readonly code: EngineErrorCode;
  /** The path concerned, when there is one. */
  readonly path: string | null;
  constructor(code: EngineErrorCode, message: string, path: string | null = null) {
    super(message);
    this.code = code;
    this.path = path;
  }
  toJSON(): { name: string; code: EngineErrorCode; message: string; path: string | null } {
    return { name: this.name, code: this.code, message: this.message, path: this.path };
  }
}

/** True for an `EngineError`, or its `toJSON()` form after crossing a boundary. */
export function isEngineError(value: unknown): value is { code: EngineErrorCode; message: string } {
  return (
    value instanceof EngineError ||
    (typeof value === 'object' &&
      value !== null &&
      (value as { name?: unknown }).name === 'EngineError' &&
      typeof (value as { code?: unknown }).code === 'string')
  );
}

// ---------------------------------------------------------------------------
// Index

export interface IndexOptions {
  /** Delete all derived data and rebuild it from the content and the event log. */
  readonly rebuild?: boolean;
  /** Paths known to have changed; always re-read (see `indexing.IndexPassOptions.paths`). */
  readonly paths?: readonly string[];
}

// ---------------------------------------------------------------------------
// Search and lists

export interface SearchOptions {
  /** Default `'hot'`. */
  readonly mode?: RankMode;
  /** At most this many results. Default 20. */
  readonly limit?: number;
  /**
   * Only notes whose date (`YYYY-MM-DD`, from the path) is on or after this
   * date. Giving `since` or `until` restricts the results to notes with a
   * date: dated entries and dated blog posts.
   */
  readonly since?: string;
  /** Only notes whose date is on or before this date (inclusive). */
  readonly until?: string;
}

export interface ListOptions {
  /** At most this many results. Default 20. */
  readonly limit?: number;
}

/** One ranked note or dangling item, ready to display and explain. */
export interface ResultView {
  /** The scored item: a note path or a dangling key. */
  readonly item: string;
  /** The note path, or null for a dangling item. */
  readonly path: string | null;
  readonly dangling: boolean;
  /**
   * The note's title; for a dangling item, the link text as written
   * (`DanglingCount.display`, capitals kept), or the key when no link to it
   * is left.
   */
  readonly title: string;
  /** The note's role; null for a dangling item. */
  readonly role: NoteRole | null;
  /** A dated note's (or dated blog post's) date; otherwise null. */
  readonly date: string | null;
  /**
   * For a blog post, whether its front matter says `published: true`; null
   * otherwise (dangling items included). Always set by the engine; optional so
   * older callers' literals still type-check.
   */
  readonly published?: boolean | null;
  /** The best-matching section (search only), `<path>#<index>`. */
  readonly sectionId: string | null;
  readonly heading: string | null;
  /** Search only. */
  readonly snippet: Snippet | null;
  /** Higher ranks first. */
  readonly rankKey: number | null;
  /** Why it ranked here: relevance, log scores per half-life and kind, the signal. */
  readonly components: Finite<RankComponents>;
  /** The same activity as "score now" numbers (`ranking.decayed`), for display. */
  readonly now: Finite<DecayedView>;
}

export interface SearchResponse {
  readonly mode: RankMode;
  /** The query as given; null for an activation list. */
  readonly query: string | null;
  /** The time the "score now" view was computed for, Unix seconds. */
  readonly at: number;
  readonly results: ResultView[];
}

// ---------------------------------------------------------------------------
// Notes

export interface ReadNoteOptions {
  /** Log a `read` event (scored notes only: memos and blog posts). Default true. */
  readonly record?: boolean;
}

export interface SectionView {
  readonly index: number;
  /** Null for the preamble. */
  readonly heading: string | null;
  /** 1-based first and last lines. */
  readonly startLine: number;
  readonly endLine: number;
}

export interface NoteView {
  readonly path: string;
  /** The note's text, byte for byte as stored. */
  readonly text: string;
  /** `storage.contentHash(text)`: pass it back as `baseHash` when saving. */
  readonly hash: string;
  /** Modification time, Unix seconds. */
  readonly mtime: number;
  readonly title: string;
  readonly role: NoteRole;
  readonly date: string | null;
  /**
   * For a blog post: true when its front matter says `published: true`
   * (`markdown.isPublished`), false for a draft. Null for every other role.
   */
  readonly published: boolean | null;
  readonly sections: SectionView[];
  /** Outgoing links: resolved note paths, or dangling keys (`dangling: true`). Sorted. */
  readonly links: NoteLink[];
  /** Notes linking here, sorted. */
  readonly backlinks: string[];
  /** True when this read was logged as a `read` event (scored notes only: memos and blog posts). */
  readonly recorded: boolean;
}

export interface SaveNoteOptions {
  /** The reason, for the change record. Its first word may be an op tag. */
  readonly message?: string | null;
  /**
   * The hash the edit was made against (`NoteView.hash`). If the stored note's
   * hash differs, nothing is written and the result is a conflict. `null`
   * means "create only": a conflict if the note exists. Omit to overwrite.
   */
  readonly baseHash?: string | null;
}

export interface ChangeOptions {
  readonly message?: string | null;
}

export type SaveResult =
  | {
      readonly status: 'saved';
      readonly path: string;
      readonly hash: string;
      /** True when the note did not exist before. */
      readonly created: boolean;
      readonly mtime: number;
      readonly change: ChangeRecord;
      readonly index: IndexSummary;
    }
  /** The text equals the stored text: nothing was written or recorded. */
  | { readonly status: 'unchanged'; readonly path: string; readonly hash: string }
  | {
      readonly status: 'conflict';
      readonly path: string;
      readonly baseHash: string | null;
      /** The stored version's hash; null when the note does not exist. */
      readonly currentHash: string | null;
      /** The stored version, to merge against; null when the note does not exist. */
      readonly currentText: string | null;
    };

export interface RenameResult {
  readonly status: 'renamed';
  readonly from: string;
  readonly to: string;
  readonly change: ChangeRecord;
  readonly index: IndexSummary;
}

export interface DeleteResult {
  readonly status: 'deleted';
  readonly path: string;
  readonly change: ChangeRecord;
  readonly index: IndexSummary;
}

// ---------------------------------------------------------------------------
// Commit, log, status

export interface CommitOptions {
  readonly message?: string | null;
  /**
   * Commit only uncommitted paths equal to or inside these brain-relative
   * paths or folders (`''` is the whole brain). Default: every uncommitted path.
   */
  readonly paths?: readonly string[];
}

export interface CommitResult {
  /** False when nothing (among `paths`) was uncommitted. */
  readonly committed: boolean;
  readonly change: ChangeRecord | null;
  /** Uncommitted paths left after this commit. */
  readonly remaining: string[];
  /** The index pass the commit ran first. */
  readonly index: IndexSummary;
}

export interface LogOptions {
  /** Only changes that touched this path. */
  readonly path?: string;
  /** Only changes with this op tag. */
  readonly op?: string;
  /** Only changes at or after this Unix time. */
  readonly since?: number;
  /** Only changes before this Unix time (half-open). */
  readonly until?: number;
  /** At most this many records. */
  readonly limit?: number;
  /** Include changes that touch only `dated` files. Default false. */
  readonly all?: boolean;
  /**
   * Only changes whose message matches these words: every word (stemmed like
   * search, with core's tokenizer) must occur in the message, and a quoted
   * phrase must occur as written. Newest first, like every log. Blank: no
   * filter. Change messages are searched here, never mixed into note search.
   */
  readonly query?: string;
}

export interface EngineStatus {
  readonly clientId: string;
  readonly notes: { readonly total: number } & Readonly<Record<NoteRole, number>>;
  readonly sections: number;
  /** Distinct dangling link targets. */
  readonly dangling: number;
  readonly events: Readonly<Record<LogKind, number>>;
  /** Change records. */
  readonly changes: number;
  /** Paths changed since the last change record, sorted. */
  readonly uncommitted: string[];
  readonly fold: { readonly cursor: number; readonly lastSeq: number };
  /** When the brain was first indexed, Unix seconds; null if never. */
  readonly firstIndexedAt: number | null;
  readonly config: {
    readonly weights: BrainConfig['weights'];
    readonly alpha: number;
    readonly halfLives: HalfLives;
    /** The burst rule's window in seconds (`BrainConfig.burstWindow`). Always set by the engine. */
    readonly burstWindow?: number;
    readonly roles: FolderRolesConfig;
    readonly analyzer: BrainConfig['analyzer'];
    readonly changeOps: readonly string[];
  };
}

export interface NoteTitle {
  readonly path: string;
  readonly title: string;
  readonly role: NoteRole;
  /**
   * A dated note's (or dated blog post's) date; otherwise null. Always set by
   * the engine; optional so older callers' literals still type-check.
   */
  readonly date?: string | null;
  /** For a blog post, whether it is published (`NoteView.published`); null otherwise. Always set by the engine. */
  readonly published?: boolean | null;
}

export interface DiaryPath {
  /** Brain-relative path of the day's dated entry. */
  readonly path: string;
  /** `YYYY-MM-DD`. */
  readonly date: string;
}

export interface DiaryEntry extends DiaryPath {
  /** True when this call created the file (with a `# <date>` heading). */
  readonly created: boolean;
}

// ---------------------------------------------------------------------------
// Export and import (PLAN.md section 4, "Export format")

/** One line of `events.jsonl`. */
export type ExportRecord =
  | {
      readonly type: 'log';
      readonly id: string;
      readonly kind: LogKind;
      readonly item: string;
      /** For `kind: 'rename'` only: the new item. */
      readonly to?: string;
      readonly time: number;
      readonly client: string;
    }
  | {
      readonly type: 'change';
      readonly id: string;
      readonly time: number;
      readonly client: string;
      readonly message: string | null;
      readonly op: string | null;
      readonly paths: readonly string[];
    };

export interface ImportResult {
  /** Events and rename records. */
  readonly log: AppendResult;
  readonly changes: AppendResult;
  /** What folding into scores did afterwards. */
  readonly folded: { readonly events: number; readonly renames: number };
}

// ---------------------------------------------------------------------------
// Sync (PLAN.md section 7, "Sync protocol (first version)")

/**
 * Changes that arrived from elsewhere, to store as they are: note states
 * (written, deleted or renamed without any base check), log entries and change
 * records. Nothing is logged for them (PLAN.md section 4, "What does not
 * count"): the client that made them logged their events, which are among
 * `events` here or arrive later.
 */
export interface RemoteApplyInput {
  readonly notes?: readonly SyncNote[];
  readonly events?: readonly SyncEvent[];
  readonly changes?: readonly SyncChange[];
}

export interface RemoteApplyResult {
  /** Paths written, removed and moved, in the order applied. */
  readonly written: string[];
  readonly removed: string[];
  readonly renamed: { readonly from: string; readonly to: string }[];
  /**
   * Notes and log entries left out because they name an excluded path, a
   * path with no role, or a path sync never carries (`sync.syncPathProblem`).
   */
  readonly skipped: number;
  readonly events: AppendResult;
  readonly changes: AppendResult;
  /** The index pass over the written paths (it logged nothing). */
  readonly index: IndexSummary;
}

/** `Engine.syncStatus()`: where this copy stands with its server. */
export interface SyncStatus {
  /** The last server mutation number applied; 0 before the first sync. */
  readonly since: number;
  readonly pushedEventSeq: number;
  readonly pushedChangeSeq: number;
  /** Notes whose server version is known (they have a base hash). */
  readonly synced: number;
  /** When a sync last completed, Unix seconds; null if never. */
  readonly lastSyncAt: number | null;
  /** What the next sync would push: notes changed, created or deleted since their base; log entries and change records. */
  readonly pending: { readonly notes: number; readonly events: number; readonly changes: number };
}

export interface PrepareSyncOptions {
  /** At most this many edits. Default 200. */
  readonly maxEdits?: number;
  /** At most about this many bytes of note text (one edit is always taken). Default 8 MiB. */
  readonly maxEditBytes?: number;
  /** At most this many log entries. Default 5000. */
  readonly maxEvents?: number;
  /** At most this many change records. Default 1000. */
  readonly maxChanges?: number;
}

/** `Engine.prepareSync()`: the request to send, plus what `applySync` needs to finish it. */
export interface PreparedSync {
  readonly request: SyncRequest;
  /** The local seq of the last event and change record in the request (or the previous cursor). */
  readonly cursor: { readonly eventSeq: number; readonly changeSeq: number };
  /** True when there was more to push than fits in one request. */
  readonly more: boolean;
  /** Notes too large to sync (over `sync.SYNC_LIMITS.maxNoteBytes`); they stay local. */
  readonly tooLarge: string[];
}

export interface SyncConflict {
  /** The note's path; the server's version is now there (or it was removed, if the server has none). */
  readonly path: string;
  readonly status: 'conflict' | 'refused';
  /** For `refused`: why (e.g. `source-immutable`). */
  readonly code: string | null;
  /** Where this copy's version was kept; null when it had none to keep (a delete). */
  readonly conflictPath: string | null;
}

/** `Engine.applySync()`: what one round did. */
export interface SyncOutcome {
  /** The server mutation number this copy is now at (the next `since`). */
  readonly mutation: number;
  /** True when another round is needed: the server has more, or there is more to push. */
  readonly more: boolean;
  readonly pushed: {
    readonly edits: number;
    readonly applied: number;
    readonly duplicates: number;
    readonly events: number;
    readonly changes: number;
  };
  /** Edits the server refused; tell the person. Nothing was lost. */
  readonly conflicts: SyncConflict[];
  readonly received: { readonly notes: number; readonly events: number; readonly changes: number };
  /**
   * Notes the server sent that were not applied because this copy changed
   * them since the last sync. The next round pushes this copy's version,
   * which then conflicts and is kept beside the server's.
   */
  readonly waiting: string[];
  /** Notes and entries from the server left out (excluded, no role, or not syncable). */
  readonly skipped: number;
}

// ---------------------------------------------------------------------------
// The engine

/**
 * One brain's logic, over its stores and content. Every method is async and
 * its arguments and results are plain, JSON-safe data. Calls are serialized:
 * a call starts after the previous one finished, so a host may fire several
 * at once.
 */
export interface Engine {
  /** The config the engine was created with. */
  readonly config: BrainConfig;
  /** Runs an index pass (and the fold); returns its summary. */
  index(options?: IndexOptions): Promise<IndexSummary>;
  /** Keyword search over every indexed role. An empty query is `list(mode)`. Logs nothing. */
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;
  /** The activation list for `mode` (default `'hot'`): scored notes (memos, blog posts) and dangling items. Logs nothing. */
  list(mode?: RankMode, options?: ListOptions): Promise<SearchResponse>;
  /** A note with its sections, links and backlinks; logs a `read` for a memo or blog post unless `record: false`. */
  readNote(path: string, options?: ReadNoteOptions): Promise<NoteView>;
  /** Writes a note (creating it if needed), indexes it, and records a change. */
  saveNote(path: string, text: string, options?: SaveNoteOptions): Promise<SaveResult>;
  renameNote(from: string, to: string, options?: ChangeOptions): Promise<RenameResult>;
  deleteNote(path: string, options?: ChangeOptions): Promise<DeleteResult>;
  /** The local-mode commit: an index pass, then one change record for the uncommitted paths. */
  commit(options?: CommitOptions): Promise<CommitResult>;
  /** Change records, newest first; `query` searches their messages. */
  log(options?: LogOptions): Promise<ChangeRecord[]>;
  status(): Promise<EngineStatus>;
  /** Every indexed note's path, title and role, sorted by path (for link autocomplete). */
  noteTitles(): Promise<NoteTitle[]>;
  /**
   * Dangling link targets, most linked first: `{ key, display, count }`.
   * `key` is the normalized (lower-cased) item; `display` is the link text
   * as written, to show and to name a note created from it.
   */
  danglingLinks(): Promise<DanglingCount[]>;
  /** The dated entry's path for `date` (default: today, in the host's local time zone). */
  diaryPath(date?: string): Promise<DiaryPath>;
  /** `diaryPath`, creating the file (and indexing it) if it does not exist. */
  ensureDiary(date?: string): Promise<DiaryEntry>;
  /** The event log and change records as JSON lines, in time order. */
  exportLog(): Promise<string>;
  /** Appends exported records (JSON lines, or parsed), skipping ids already stored, then folds. */
  importLog(entries: string | readonly ExportRecord[]): Promise<ImportResult>;

  // --- Sync. An offline copy calls `prepareSync`, sends `request` to the
  // server, and passes the response to `applySync`, repeating while the
  // outcome says `more` (`runSync` does the loop). The server calls
  // `applyRemote` to store pushed edits and entries.

  /**
   * Stores changes that arrived from elsewhere without logging events:
   * writes, deletes and renames notes, re-indexes them (relinking other notes
   * and resolving dangling links as usual), appends the log entries and
   * change records (ids already stored are skipped), and folds. Local changes
   * not yet indexed are indexed (and logged) first, so they are never taken
   * for remote ones. Does not change the sync state.
   */
  applyRemote(input: RemoteApplyInput): Promise<RemoteApplyResult>;
  /** Where this copy stands with its server, and what is waiting to be pushed. */
  syncStatus(): Promise<SyncStatus>;
  /**
   * Indexes local changes, then builds the next sync request: notes changed
   * since their base hash (as writes, deletes and renames), and the log
   * entries and change records after the pushed cursors. Changes nothing.
   */
  prepareSync(options?: PrepareSyncOptions): Promise<PreparedSync>;
  /**
   * Applies the server's response to a prepared request: records the
   * results (a conflicting or refused edit keeps this copy's text as a
   * conflict file and takes the server's version), writes the notes the
   * server sent unless this copy changed them since the last sync, appends
   * the entries and change records, folds, and advances the sync state.
   */
  applySync(prepared: PreparedSync, response: SyncResponse): Promise<SyncOutcome>;
  /** Forgets the sync state: the next sync starts from `since: 0` and pushes every note. */
  resetSync(): Promise<void>;
}
