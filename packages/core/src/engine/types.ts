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
   * Only dated notes whose date (`YYYY-MM-DD`, from the path) is on or after
   * this date. Giving `since` or `until` restricts the results to dated notes.
   */
  readonly since?: string;
  /** Only dated notes whose date is on or before this date (inclusive). */
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
  /** The note's title, or the dangling key. */
  readonly title: string;
  /** The note's role; null for a dangling item. */
  readonly role: NoteRole | null;
  /** A dated note's date; otherwise null. */
  readonly date: string | null;
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
  /** Log a `read` event (memos only). Default true. */
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
  readonly sections: SectionView[];
  /** Outgoing links: resolved note paths, or dangling keys (`dangling: true`). Sorted. */
  readonly links: NoteLink[];
  /** Notes linking here, sorted. */
  readonly backlinks: string[];
  /** True when this read was logged as a `read` event. */
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
    readonly roles: FolderRolesConfig;
    readonly analyzer: BrainConfig['analyzer'];
    readonly changeOps: readonly string[];
  };
}

export interface NoteTitle {
  readonly path: string;
  readonly title: string;
  readonly role: NoteRole;
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
  /** The activation list for `mode` (default `'hot'`): memos and dangling items. Logs nothing. */
  list(mode?: RankMode, options?: ListOptions): Promise<SearchResponse>;
  /** A note with its sections, links and backlinks; logs a `read` for a memo unless `record: false`. */
  readNote(path: string, options?: ReadNoteOptions): Promise<NoteView>;
  /** Writes a note (creating it if needed), indexes it, and records a change. */
  saveNote(path: string, text: string, options?: SaveNoteOptions): Promise<SaveResult>;
  renameNote(from: string, to: string, options?: ChangeOptions): Promise<RenameResult>;
  deleteNote(path: string, options?: ChangeOptions): Promise<DeleteResult>;
  /** The local-mode commit: an index pass, then one change record for the uncommitted paths. */
  commit(options?: CommitOptions): Promise<CommitResult>;
  /** Change records, newest first. */
  log(options?: LogOptions): Promise<ChangeRecord[]>;
  status(): Promise<EngineStatus>;
  /** Every indexed note's path, title and role, sorted by path (for link autocomplete). */
  noteTitles(): Promise<NoteTitle[]>;
  /** Dangling link targets, most linked first. */
  danglingLinks(): Promise<DanglingCount[]>;
  /** The dated entry's path for `date` (default: today, in the host's local time zone). */
  diaryPath(date?: string): Promise<DiaryPath>;
  /** `diaryPath`, creating the file (and indexing it) if it does not exist. */
  ensureDiary(date?: string): Promise<DiaryEntry>;
  /** The event log and change records as JSON lines, in time order. */
  exportLog(): Promise<string>;
  /** Appends exported records (JSON lines, or parsed), skipping ids already stored, then folds. */
  importLog(entries: string | readonly ExportRecord[]): Promise<ImportResult>;
}
