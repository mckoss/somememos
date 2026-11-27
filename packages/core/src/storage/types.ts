// Storage interfaces (PLAN.md sections 4 and 9; IMPLEMENTATION.md task 0.8).
//
// Storage is defined as operations, never SQL, so that each database can
// implement it: SQLite in offline clients (packages/sqlite-store), Postgres on
// the server (M3), and the in-memory reference here (./memory.ts). Every
// implementation must pass the same conformance suite (./conformance.testing.ts).
//
// Every method returns `Awaitable<T>`: SQLite answers synchronously, Postgres
// asynchronously. Callers always `await`.
//
// Two groups of data, treated differently (PLAN.md section 2):
// - Original data: the event log (events and rename records), change records
//   and durable meta. An offline client keeps them in `events.sqlite`. Never
//   deleted.
// - Derived data: notes, links, sections, postings, scores, the fold cursor
//   and index meta. An offline client keeps them in `index.sqlite`. Always
//   rebuildable: `Stores.resetIndex()` deletes it all.

import type { AnalyzerOptions } from '../keyword/analyze.js';
import type { FieldValues } from '../keyword/document.js';
import type { IndexStatistics } from '../keyword/memory-index.js';
import type { Awaitable, PostingsSource } from '../keyword/search.js';
import type { FolderRole } from '../markdown/roles.js';
import type { EventKind } from '../timescore/kinds.js';
import type { LogScore } from '../timescore/timescore.js';
import type { ItemScores } from '../timescore/events.js';

export type { Awaitable } from '../keyword/search.js';

// ---------------------------------------------------------------------------
// The event log

/**
 * An event to append: an interaction with an item (a note path, or a
 * dangling link key). Every event is worth 1 when folded.
 */
export interface EventInput {
  /** Globally unique. Appending an id the log already has is a no-op (sync dedup). */
  readonly id: string;
  readonly kind: EventKind;
  /** Note path, or dangling link key. */
  readonly item: string;
  /** Unix seconds, an integer: when the interaction happened. Never in the future. */
  readonly time: number;
  /** The client that recorded it. */
  readonly client: string;
}

/**
 * A rename record: from `time` on, `item` is called `to`. Its history (scores)
 * moves to `to`, and events dated at or before `time` that arrive later
 * for `item` land on `to` too (see `foldPending`).
 */
export interface RenameInput {
  readonly id: string;
  readonly kind: 'rename';
  /** The old item. */
  readonly item: string;
  /** The new item. Must differ from `item`. */
  readonly to: string;
  readonly time: number;
  readonly client: string;
}

/** Anything the event log holds. Events and renames share one id space and one sequence. */
export type LogInput = EventInput | RenameInput;

/** `kind` of a log entry: an event kind, or `'rename'`. */
export type LogKind = EventKind | 'rename';

/** A stored log entry: the input plus `seq`, its local arrival order (1, 2, …). */
export type LogEntry = (EventInput | RenameInput) & { readonly seq: number };
export type StoredEvent = EventInput & { readonly seq: number };
export type StoredRename = RenameInput & { readonly seq: number };

export interface AppendOptions {
  /**
   * "Now" in Unix seconds for the future-event check. Default: the stores'
   * clock (`StoresOptions.now`, else the system clock).
   */
  readonly now?: number;
}

export interface AppendResult {
  /** Entries newly stored. */
  readonly appended: number;
  /** Entries skipped because their id was already stored (or repeated in the batch). */
  readonly duplicates: number;
}

/** A commit's record in the change log (PLAN.md section 4, "The change log"). */
export interface ChangeInput {
  /** Globally unique. Appending an id already stored is a no-op. */
  readonly id: string;
  /** Unix seconds, an integer. Never in the future. */
  readonly time: number;
  readonly client: string;
  /** The commit message, or null when none was given. */
  readonly message: string | null;
  /**
   * The operation tag: the message's first word when it is one of the
   * configured op names, else null. Compute it with `changeOp(message, ops)`.
   */
  readonly op: string | null;
  /** The notes the change touched. Stored deduplicated and sorted. */
  readonly paths: readonly string[];
}

export type ChangeRecord = ChangeInput & { readonly seq: number };

/** Filters for `EventLog.changes`. All given filters must hold. */
export interface ChangeFilter {
  /** Only changes that touched this path. */
  readonly path?: string;
  /** Only changes with this op. */
  readonly op?: string;
  /** Only changes with `time >= since`. */
  readonly since?: number;
  /** Only changes with `time < until` (half-open, like `since`/`until` in most logs). */
  readonly until?: number;
  /** At most this many records. */
  readonly limit?: number;
}

/**
 * The event log: original data, append-only. Every write validates all its
 * input first and then stores it in one transaction, so a batch is stored
 * whole or not at all.
 */
export interface EventLog {
  /**
   * Appends events and rename records in one transaction, in the given order.
   * Ids already stored (or repeated earlier in the batch) are skipped.
   * Throws, storing nothing, if any entry is invalid (`InvalidEventError`,
   * via `timescore.assertValidEvent` for events) or dated after `now`
   * (`FutureEventError`).
   */
  append(entries: readonly LogInput[], options?: AppendOptions): Awaitable<AppendResult>;
  /** Entries with `seq > cursor`, in seq order; at most `limit` of them. */
  readAfter(cursor: number, options?: { readonly limit?: number }): Awaitable<LogEntry[]>;
  /** Rename records with `seq <= throughSeq` (default: all), in seq order. */
  renames(options?: { readonly throughSeq?: number }): Awaitable<StoredRename[]>;
  /** The highest seq stored, or 0 for an empty log. */
  lastSeq(): Awaitable<number>;
  /** How many entries of each kind are stored (every kind present, 0 when none). */
  countByKind(): Awaitable<Record<LogKind, number>>;

  /** Appends change records in one transaction; ids already stored are skipped. */
  appendChanges(changes: readonly ChangeInput[], options?: AppendOptions): Awaitable<AppendResult>;
  /** Change records matching `filter`, newest first (time descending, then seq descending). */
  changes(filter?: ChangeFilter): Awaitable<ChangeRecord[]>;
}

// ---------------------------------------------------------------------------
// Scores

/** Half-life lengths in seconds, by name (`timescore.HALF_LIVES` by default). */
export type HalfLives = Readonly<Record<string, number>>;

/** One step of a fold, applied in order by `ScoreStore.applyFold`. */
export type ScoreOp =
  /** `L(item, kind, halfLife) = combine(L, logScore)`. */
  | {
      readonly type: 'add';
      readonly item: string;
      readonly kind: EventKind;
      readonly halfLife: string;
      readonly logScore: LogScore;
    }
  /**
   * Every score of `from` is combined into `to`, and `from` is left with none.
   * A no-op when `from` has no scores or `from === to`.
   */
  | { readonly type: 'move'; readonly from: string; readonly to: string }
  /**
   * The burst rule's state (./burst.ts): the last counted time of
   * `(item, kind)` becomes the later of its stored value and `time`. A `move`
   * moves this state with the scores (keeping the later time where both
   * items have one).
   */
  | {
      readonly type: 'last';
      readonly item: string;
      readonly kind: EventKind;
      /** Unix seconds, an integer. */
      readonly time: number;
    };

/** A batch of folded contributions, applied atomically with the cursor. */
export interface FoldBatch {
  /** The cursor the batch was computed from. Must equal the stored cursor. */
  readonly fromCursor: number;
  /** The seq of the last log entry folded into the batch; the new cursor. */
  readonly toCursor: number;
  /** The half-lives the batch was computed with. Must equal the recorded ones, if any. */
  readonly halfLives: HalfLives;
  /**
   * The burst window the batch was computed with (./burst.ts), in seconds.
   * Absent or 0: off. Must equal the recorded one when scores are stored.
   */
  readonly burstWindow?: number;
  readonly ops: readonly ScoreOp[];
}

export interface FoldState {
  /** The seq of the last log entry folded; 0 when nothing is folded. */
  readonly cursor: number;
  /** The half-lives the stored scores were folded with; null before the first fold. */
  readonly halfLives: HalfLives | null;
  /**
   * The burst window the stored scores were folded with, in seconds. Present
   * only when the scores were folded with a window > 0; absent means 0 (off),
   * or nothing folded yet.
   */
  readonly burstWindow?: number;
}

/** The burst rule's state of some items: item → kind → last counted time. */
export type BurstState = Map<string, Partial<Record<EventKind, number>>>;

/**
 * Derived TimeScore scores: one log score per (item, kind, half-life),
 * unweighted. Weight them at read time with `timescore.weightedTotal`.
 * Normally written only by `foldPending`.
 */
export interface ScoreStore {
  foldState(): Awaitable<FoldState>;
  /** One item's scores, by half-life then kind; undefined when it has none. */
  getItem(item: string): Awaitable<ItemScores<string> | undefined>;
  /** Every item's scores, keyed by item in sorted order. */
  getAll(): Awaitable<Map<string, ItemScores<string>>>;
  /**
   * Applies `batch.ops` in order and sets the cursor to `batch.toCursor`, all
   * in one transaction. Throws `FoldConflictError` (changing nothing) if the
   * stored cursor is not `batch.fromCursor`, which is how two concurrent
   * folders avoid counting an entry twice; `HalfLifeMismatchError` if the
   * stored scores were folded with other half-lives; and a RangeError for an
   * invalid op (rolling back any ops already applied).
   */
  applyFold(batch: FoldBatch): Awaitable<void>;
  /**
   * The burst rule's state (the `'last'` ops applied so far) of the given
   * items; items without any are left out. Derived data, cleared with the scores.
   */
  burstState(items: readonly string[]): Awaitable<BurstState>;
  /** Deletes every score and the burst state, sets the cursor to 0 and forgets the half-lives and burst window. */
  clear(): Awaitable<void>;
}

// ---------------------------------------------------------------------------
// Notes and links

/** Roles a stored note can have. Excluded files are never stored. */
export type NoteRole = Exclude<FolderRole, 'excluded'>;

export interface NoteRecord {
  /** Brain-relative, `/` separators. */
  readonly path: string;
  readonly title: string;
  /** The content hash, for change detection and sync. */
  readonly contentHash: string;
  /** File modification time, Unix seconds (an integer). */
  readonly mtime: number;
  readonly role: NoteRole;
  /** For a `dated` note, or a `blog` post with a date in its path, the date (`YYYY-MM-DD`); otherwise null. */
  readonly date: string | null;
}

/** An outgoing `[[link]]` of a note. */
export interface NoteLink {
  /** The resolved note path, or the dangling key. */
  readonly target: string;
  /** True when `target` is a dangling key. */
  readonly dangling: boolean;
  /**
   * For a dangling link: the link text as written (its first occurrence in
   * the note, trimmed, without `.md`), so a note created from it can keep the
   * writer's capitals. Absent for resolved links, and when not recorded.
   */
  readonly display?: string;
}

export interface DanglingCount {
  /** The dangling key (normalized, lower-cased): the scored item. */
  readonly key: string;
  /**
   * The link text as written, to show and to name a new note with. Of the
   * forms linking notes use, the one most notes use; ties go to the form
   * that sorts first (`compareStrings`, so capitals before lower case). The
   * key itself when no form was recorded. See `pickDanglingDisplay`.
   */
  readonly display: string;
  /** How many notes link to it. */
  readonly count: number;
}

/** The notes table and the link graph. Derived from the markdown. */
export interface NoteStore {
  /** Inserts or replaces the note at `note.path`. */
  upsertNote(note: NoteRecord): Awaitable<void>;
  /** Deletes the note and its outgoing links. Returns false if it was not stored. */
  removeNote(path: string): Awaitable<boolean>;
  getNote(path: string): Awaitable<NoteRecord | undefined>;
  /** Every note (of one role, if given), sorted by path. */
  listNotes(filter?: { readonly role?: NoteRole }): Awaitable<NoteRecord[]>;
  /**
   * Replaces `source`'s outgoing links (deduplicated by target; when a target
   * repeats, the last entry's flag wins). Does not require the note to be stored.
   */
  replaceLinks(source: string, links: readonly NoteLink[]): Awaitable<void>;
  /** `source`'s outgoing links, sorted by target. */
  linksFrom(source: string): Awaitable<NoteLink[]>;
  /** The notes that link to `target` (a path or a dangling key), sorted. */
  backlinks(target: string): Awaitable<string[]>;
  /** Every dangling key with the number of notes linking to it; most linked first, then by key. */
  danglingTargets(): Awaitable<DanglingCount[]>;
}

// ---------------------------------------------------------------------------
// The term index

/** A section to index. `markdown.Section` fits (its `index` is ignored). */
export interface SectionInput {
  /** The heading text; null for the preamble. Indexed as `''`. */
  readonly heading: string | null;
  readonly body: string;
  /** 1-based first and last lines, for display. Default 0. */
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface StoredSection {
  /** `sectionId(path, index)`: stable across rebuilds. This is the hit id in search results. */
  readonly id: string;
  readonly path: string;
  /** Position in the note's section list. */
  readonly index: number;
  /** The note's title (the same for every section of a note). */
  readonly title: string;
  readonly heading: string | null;
  readonly body: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Field lengths in tokens. */
  readonly lengths: FieldValues;
}

export interface AnalyzerMismatch {
  /** What the stored index was built with. */
  readonly stored: AnalyzerOptions;
  /** What was asked for. */
  readonly requested: AnalyzerOptions;
}

/**
 * The keyword term index: sections, field lengths, and per-term per-field
 * frequencies and positions (never scores). It is a `keyword.PostingsSource`,
 * so `keyword.searchSource(terms, query)` ranks over it exactly as over a
 * `keyword.MemoryKeywordIndex` with the same content.
 */
export interface TermIndex extends PostingsSource {
  /**
   * The analyzer this index was built with, and uses for every write. Fixed
   * until `Stores.resetIndex({ analyzer })`.
   */
  readonly analyzer: AnalyzerOptions;
  /** Null when `requested` (defaults filled in) equals `analyzer`, else both. */
  analyzerMismatch(requested?: Partial<AnalyzerOptions>): AnalyzerMismatch | null;
  /** Replaces every section of the note at `path`, analyzing each with `analyzer`. */
  replaceSections(path: string, title: string, sections: readonly SectionInput[]): Awaitable<void>;
  /** Deletes every section of the note. Returns false if it had none. */
  removeSections(path: string): Awaitable<boolean>;
  getSection(id: string): Awaitable<StoredSection | undefined>;
  /** The note's sections, in order. */
  sectionsOf(path: string): Awaitable<StoredSection[]>;
  /** Index-wide counts; equal to a fresh `MemoryKeywordIndex`'s for the same sections. */
  statistics(): Awaitable<IndexStatistics>;
}

// ---------------------------------------------------------------------------
// Meta and the aggregate

/** A small string key-value store. */
export interface MetaStore {
  get(key: string): Awaitable<string | undefined>;
  set(key: string, value: string): Awaitable<void>;
  delete(key: string): Awaitable<void>;
}

export interface StoresOptions {
  /** Analyzer for a new or reset term index. Default `keyword.DEFAULT_ANALYZER_OPTIONS`. */
  readonly analyzer?: Partial<AnalyzerOptions>;
  /** The clock, in Unix seconds, for future-event checks. Default: the system clock. */
  readonly now?: () => number;
}

/** Every store of one brain. */
export interface Stores {
  /** Original data. */
  readonly events: EventLog;
  /** Durable meta, kept beside the event log (survives `resetIndex`). */
  readonly meta: MetaStore;
  /** Derived data. */
  readonly scores: ScoreStore;
  readonly notes: NoteStore;
  readonly terms: TermIndex;
  /** Derived meta, deleted by `resetIndex`. */
  readonly indexMeta: MetaStore;
  /**
   * Runs `fn` so that its writes to the derived stores (notes, links, terms,
   * scores, index meta) commit together, or not at all if it throws. Writes to
   * `events` and `meta` are not covered. Use it around an index pass: it is
   * also much faster than one transaction per write. Calls may nest (the
   * inner one joins the outer). Don't run other writes concurrently on the
   * same stores while it is pending.
   */
  indexTransaction<T>(fn: () => Awaitable<T>): Promise<T>;
  /**
   * Deletes all derived data (notes, links, sections, postings, scores,
   * fold cursor, index meta) and keeps the event log, change records and meta.
   * The term index then uses `options.analyzer` (default: the analyzer the
   * stores were opened with).
   */
  resetIndex(options?: { readonly analyzer?: Partial<AnalyzerOptions> }): Awaitable<void>;
  close(): Awaitable<void>;
}

// ---------------------------------------------------------------------------
// Errors

/** `applyFold` was given a batch computed from a stale cursor. Re-read and retry. */
export class FoldConflictError extends Error {
  override name = 'FoldConflictError';
  readonly expected: number;
  readonly actual: number;
  constructor(expected: number, actual: number) {
    super(`fold cursor is ${actual}, but the batch was computed from ${expected}`);
    this.expected = expected;
    this.actual = actual;
  }
}

/** Scores were folded with other half-lives; they must be rebuilt from the log. */
export class HalfLifeMismatchError extends Error {
  override name = 'HalfLifeMismatchError';
  readonly stored: HalfLives;
  readonly requested: HalfLives;
  constructor(stored: HalfLives, requested: HalfLives) {
    super(
      `scores were folded with half-lives ${JSON.stringify(stored)}, not ${JSON.stringify(requested)}; rebuild them from the event log`,
    );
    this.stored = stored;
    this.requested = requested;
  }
}

/** Scores were folded with another burst window; they must be rebuilt from the log. */
export class BurstWindowMismatchError extends Error {
  override name = 'BurstWindowMismatchError';
  readonly stored: number;
  readonly requested: number;
  constructor(stored: number, requested: number) {
    super(
      `scores were folded with burst window ${stored}, not ${requested}; rebuild them from the event log`,
    );
    this.stored = stored;
    this.requested = requested;
  }
}

/** A stored database needs a migration this version cannot do. Nothing was changed. */
export class MigrationRequiredError extends Error {
  override name = 'MigrationRequiredError';
}
