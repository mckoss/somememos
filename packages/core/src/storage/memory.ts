// In-memory implementations of every storage interface: the reference the
// conformance suite is checked against, and a store for the evaluation
// harness (which folds a log in memory with experimental parameters).
//
// The state lives in a `MemoryBrainData`, so stores can be closed and opened
// again over the same data (as a database file would be).

import {
  type AnalyzerOptions,
  DEFAULT_ANALYZER_OPTIONS,
  resolveAnalyzerOptions,
} from '../keyword/analyze.js';
import type { CorpusStats } from '../keyword/bm25f.js';
import { type AnalyzedSection, FIELDS, analyzeSection } from '../keyword/document.js';
import type { IndexStatistics } from '../keyword/memory-index.js';
import type { Posting } from '../keyword/search.js';
import { EVENT_KINDS, type EventKind } from '../timescore/kinds.js';
import type { ItemScores } from '../timescore/events.js';
import { combine } from '../timescore/timescore.js';
import { assertValidBurstWindow } from './burst.js';
import type { ScoresByKind } from '../timescore/weights.js';
import {
  BurstWindowMismatchError,
  FoldConflictError,
  HalfLifeMismatchError,
  type AnalyzerMismatch,
  type BurstState,
  type AppendOptions,
  type AppendResult,
  type ChangeFilter,
  type ChangeInput,
  type ChangeRecord,
  type DanglingCount,
  type EventLog,
  type FoldBatch,
  type FoldState,
  type HalfLives,
  type LogEntry,
  type LogInput,
  type LogKind,
  type MetaStore,
  type NoteLink,
  type NoteRecord,
  type NoteRole,
  type NoteStore,
  type ScoreStore,
  type SectionInput,
  type StoredRename,
  type StoredSection,
  type Stores,
  type StoresOptions,
  type TermIndex,
} from './types.js';
import {
  assertValidChangeInput,
  assertValidHalfLives,
  assertValidLogInput,
  assertValidNote,
  assertValidScoreOp,
  compareAnalyzers,
  compareStrings,
  danglingCounts,
  linkDisplay,
  normalizeChangePaths,
  sameHalfLives,
  sectionId,
  unixNow,
} from './validate.js';

interface MemoryDoc {
  readonly sections: readonly StoredSection[];
  readonly analyzed: readonly AnalyzedSection[];
}

/** The derived state (what `index.sqlite` holds for SQLite). */
interface MemoryIndexState {
  analyzer: AnalyzerOptions;
  notes: Map<string, NoteRecord>;
  /** source → target → link. Inner maps are replaced, never mutated. */
  links: Map<string, ReadonlyMap<string, StoredLink>>;
  docs: Map<string, MemoryDoc>;
  /** item → "kind\0halfLife" → log score. Inner maps are replaced, never mutated. */
  scores: Map<string, ReadonlyMap<string, number>>;
  /** item → kind → last counted time (the burst rule). Inner maps are replaced, never mutated. */
  burst: Map<string, ReadonlyMap<EventKind, number>>;
  cursor: number;
  halfLives: HalfLives | null;
  /** 0 when off or nothing folded. */
  burstWindow: number;
  meta: Map<string, string>;
}

interface StoredLink {
  readonly dangling: boolean;
  readonly display?: string;
}

/** Everything a memory brain holds. Pass the same object to reopen it. */
export class MemoryBrainData {
  /** @internal */ readonly log: LogEntry[] = [];
  /** @internal */ readonly logIds = new Set<string>();
  /** @internal */ readonly changes: ChangeRecord[] = [];
  /** @internal */ readonly changeIds = new Set<string>();
  /** @internal */ readonly meta = new Map<string, string>();
  /** @internal */ index: MemoryIndexState | null = null;
}

function newIndexState(analyzer: AnalyzerOptions): MemoryIndexState {
  return {
    analyzer,
    notes: new Map(),
    links: new Map(),
    docs: new Map(),
    scores: new Map(),
    burst: new Map(),
    cursor: 0,
    halfLives: null,
    burstWindow: 0,
    meta: new Map(),
  };
}

function snapshotIndex(s: MemoryIndexState): MemoryIndexState {
  return {
    analyzer: s.analyzer,
    notes: new Map(s.notes),
    links: new Map(s.links),
    docs: new Map(s.docs),
    scores: new Map(s.scores),
    burst: new Map(s.burst),
    cursor: s.cursor,
    halfLives: s.halfLives,
    burstWindow: s.burstWindow,
    meta: new Map(s.meta),
  };
}

// ---------------------------------------------------------------------------
// Event log

class MemoryEventLog implements EventLog {
  private readonly data: MemoryBrainData;
  private readonly clock: () => number;
  constructor(data: MemoryBrainData, clock: () => number) {
    this.data = data;
    this.clock = clock;
  }

  append(entries: readonly LogInput[], options?: AppendOptions): AppendResult {
    const now = options?.now ?? this.clock();
    for (const entry of entries) assertValidLogInput(entry, now);
    let appended = 0;
    let duplicates = 0;
    for (const entry of entries) {
      if (this.data.logIds.has(entry.id)) {
        duplicates++;
        continue;
      }
      this.data.logIds.add(entry.id);
      const seq = this.data.log.length + 1;
      const stored: LogEntry =
        entry.kind === 'rename'
          ? {
              seq,
              id: entry.id,
              kind: 'rename',
              item: entry.item,
              to: entry.to,
              time: entry.time,
              client: entry.client,
            }
          : {
              seq,
              id: entry.id,
              kind: entry.kind,
              item: entry.item,
              time: entry.time,
              client: entry.client,
            };
      this.data.log.push(stored);
      appended++;
    }
    return { appended, duplicates };
  }

  readAfter(cursor: number, options?: { readonly limit?: number }): LogEntry[] {
    const start = Math.max(0, Math.floor(cursor));
    const end = options?.limit === undefined ? undefined : start + Math.max(0, options.limit);
    return this.data.log.slice(start, end);
  }

  renames(options?: { readonly throughSeq?: number }): StoredRename[] {
    const through = options?.throughSeq ?? Infinity;
    return this.data.log.filter((e): e is StoredRename => e.kind === 'rename' && e.seq <= through);
  }

  lastSeq(): number {
    return this.data.log.length;
  }

  countByKind(): Record<LogKind, number> {
    const counts: Record<LogKind, number> = { read: 0, edit: 0, mention: 0, rename: 0 };
    for (const e of this.data.log) counts[e.kind]++;
    return counts;
  }

  appendChanges(changes: readonly ChangeInput[], options?: AppendOptions): AppendResult {
    const now = options?.now ?? this.clock();
    for (const change of changes) assertValidChangeInput(change, now);
    let appended = 0;
    let duplicates = 0;
    for (const c of changes) {
      if (this.data.changeIds.has(c.id)) {
        duplicates++;
        continue;
      }
      this.data.changeIds.add(c.id);
      this.data.changes.push({
        seq: this.data.changes.length + 1,
        id: c.id,
        time: c.time,
        client: c.client,
        message: c.message,
        op: c.op,
        paths: normalizeChangePaths(c.paths),
      });
      appended++;
    }
    return { appended, duplicates };
  }

  changes(filter: ChangeFilter = {}): ChangeRecord[] {
    const out = this.data.changes.filter(
      (c) =>
        (filter.path === undefined || c.paths.includes(filter.path)) &&
        (filter.op === undefined || c.op === filter.op) &&
        (filter.since === undefined || c.time >= filter.since) &&
        (filter.until === undefined || c.time < filter.until),
    );
    out.sort((a, b) => b.time - a.time || b.seq - a.seq);
    return filter.limit === undefined ? out : out.slice(0, Math.max(0, filter.limit));
  }
}

// ---------------------------------------------------------------------------
// Meta

class MemoryMeta implements MetaStore {
  private readonly map: () => Map<string, string>;
  constructor(map: () => Map<string, string>) {
    this.map = map;
  }
  get(key: string): string | undefined {
    return this.map().get(key);
  }
  set(key: string, value: string): void {
    if (typeof value !== 'string') throw new TypeError('meta values must be strings');
    this.map().set(key, value);
  }
  delete(key: string): void {
    this.map().delete(key);
  }
}

// ---------------------------------------------------------------------------
// Scores

const scoreKey = (kind: EventKind, halfLife: string): string => `${kind}\0${halfLife}`;

function toItemScores(inner: ReadonlyMap<string, number>): ItemScores<string> {
  const out: Record<string, ScoresByKind> = {};
  for (const [key, value] of inner) {
    const [kind, halfLife] = key.split('\0') as [EventKind, string];
    (out[halfLife] ??= {})[kind] = value;
  }
  // Kinds in canonical order, for stable output.
  for (const hl of Object.keys(out)) {
    const byKind = out[hl] as ScoresByKind;
    const ordered: ScoresByKind = {};
    for (const k of EVENT_KINDS) if (byKind[k] !== undefined) ordered[k] = byKind[k];
    out[hl] = ordered;
  }
  return out;
}

class MemoryScoreStore implements ScoreStore {
  private readonly state: () => MemoryIndexState;
  constructor(state: () => MemoryIndexState) {
    this.state = state;
  }

  foldState(): FoldState {
    const s = this.state();
    return s.burstWindow > 0
      ? { cursor: s.cursor, halfLives: s.halfLives, burstWindow: s.burstWindow }
      : { cursor: s.cursor, halfLives: s.halfLives };
  }

  burstState(items: readonly string[]): BurstState {
    const s = this.state();
    const out: BurstState = new Map();
    for (const item of new Set(items)) {
      const inner = s.burst.get(item);
      if (inner && inner.size > 0) out.set(item, Object.fromEntries(inner));
    }
    return out;
  }

  getItem(item: string): ItemScores<string> | undefined {
    const inner = this.state().scores.get(item);
    return inner ? toItemScores(inner) : undefined;
  }

  getAll(): Map<string, ItemScores<string>> {
    const s = this.state();
    const out = new Map<string, ItemScores<string>>();
    for (const item of [...s.scores.keys()].sort(compareStrings)) {
      out.set(item, toItemScores(s.scores.get(item) as ReadonlyMap<string, number>));
    }
    return out;
  }

  applyFold(batch: FoldBatch): void {
    const s = this.state();
    if (s.cursor !== batch.fromCursor) throw new FoldConflictError(batch.fromCursor, s.cursor);
    assertValidHalfLives(batch.halfLives);
    if (s.halfLives && !sameHalfLives(s.halfLives, batch.halfLives)) {
      throw new HalfLifeMismatchError(s.halfLives, batch.halfLives);
    }
    const window = batch.burstWindow ?? 0;
    assertValidBurstWindow(window);
    if (s.halfLives && s.burstWindow !== window) {
      throw new BurstWindowMismatchError(s.burstWindow, window);
    }
    if (!Number.isSafeInteger(batch.toCursor) || batch.toCursor < batch.fromCursor) {
      throw new RangeError(`toCursor must be an integer >= fromCursor, not ${batch.toCursor}`);
    }
    const burst = new Map(s.burst);
    const burstOwned = new Set<string>();
    const burstOf = (item: string): Map<EventKind, number> => {
      if (!burstOwned.has(item)) {
        burst.set(item, new Map(burst.get(item) ?? []));
        burstOwned.add(item);
      }
      return burst.get(item) as Map<EventKind, number>;
    };
    // Stage on a copy, so an invalid op part-way through changes nothing.
    const staged = new Map(s.scores);
    const owned = new Set<string>();
    const mutable = (item: string): Map<string, number> => {
      if (!owned.has(item)) {
        staged.set(item, new Map(staged.get(item) ?? []));
        owned.add(item);
      }
      return staged.get(item) as Map<string, number>;
    };
    for (const op of batch.ops) {
      assertValidScoreOp(op, batch.halfLives);
      if (op.type === 'add') {
        const inner = mutable(op.item);
        const key = scoreKey(op.kind, op.halfLife);
        inner.set(key, combine(inner.get(key) ?? -Infinity, op.logScore));
      } else if (op.type === 'last') {
        const inner = burstOf(op.item);
        inner.set(op.kind, Math.max(inner.get(op.kind) ?? -Infinity, op.time));
      } else {
        if (op.from === op.to) continue;
        const fromBurst = burst.get(op.from);
        if (fromBurst) {
          const to = burstOf(op.to);
          for (const [kind, time] of fromBurst)
            to.set(kind, Math.max(to.get(kind) ?? -Infinity, time));
          burst.delete(op.from);
          burstOwned.delete(op.from);
        }
        const from = staged.get(op.from);
        if (!from) continue;
        const to = mutable(op.to);
        for (const [key, value] of from) to.set(key, combine(to.get(key) ?? -Infinity, value));
        staged.delete(op.from);
        owned.delete(op.from);
      }
    }
    s.scores = staged;
    s.burst = burst;
    s.cursor = batch.toCursor;
    s.halfLives = batch.halfLives;
    s.burstWindow = window;
  }

  clear(): void {
    const s = this.state();
    s.scores = new Map();
    s.burst = new Map();
    s.cursor = 0;
    s.halfLives = null;
    s.burstWindow = 0;
  }
}

// ---------------------------------------------------------------------------
// Notes and links

class MemoryNoteStore implements NoteStore {
  private readonly state: () => MemoryIndexState;
  constructor(state: () => MemoryIndexState) {
    this.state = state;
  }

  upsertNote(note: NoteRecord): void {
    assertValidNote(note);
    this.state().notes.set(note.path, {
      path: note.path,
      title: note.title,
      contentHash: note.contentHash,
      mtime: note.mtime,
      role: note.role,
      date: note.date,
    });
  }

  removeNote(path: string): boolean {
    const s = this.state();
    s.links.delete(path);
    return s.notes.delete(path);
  }

  getNote(path: string): NoteRecord | undefined {
    return this.state().notes.get(path);
  }

  listNotes(filter?: { readonly role?: NoteRole }): NoteRecord[] {
    return [...this.state().notes.values()]
      .filter((n) => filter?.role === undefined || n.role === filter.role)
      .sort((a, b) => compareStrings(a.path, b.path));
  }

  replaceLinks(source: string, links: readonly NoteLink[]): void {
    const inner = new Map<string, StoredLink>();
    for (const link of links) {
      if (typeof link.target !== 'string' || link.target === '') {
        throw new RangeError('link target must be a non-empty string');
      }
      const display = linkDisplay(link);
      inner.set(link.target, {
        dangling: Boolean(link.dangling),
        ...(display !== undefined ? { display } : {}),
      });
    }
    const s = this.state();
    if (inner.size === 0) s.links.delete(source);
    else s.links.set(source, inner);
  }

  linksFrom(source: string): NoteLink[] {
    const inner = this.state().links.get(source);
    if (!inner) return [];
    return [...inner]
      .map(([target, l]) => ({
        target,
        dangling: l.dangling,
        ...(l.display !== undefined ? { display: l.display } : {}),
      }))
      .sort((a, b) => compareStrings(a.target, b.target));
  }

  backlinks(target: string): string[] {
    const out: string[] = [];
    for (const [source, inner] of this.state().links) if (inner.has(target)) out.push(source);
    return out.sort(compareStrings);
  }

  danglingTargets(): DanglingCount[] {
    const links: { key: string; display: string | undefined }[] = [];
    for (const inner of this.state().links.values()) {
      for (const [target, l] of inner) {
        if (l.dangling) links.push({ key: target, display: l.display });
      }
    }
    return danglingCounts(links);
  }
}

// ---------------------------------------------------------------------------
// Term index

class MemoryTermIndex implements TermIndex {
  private readonly state: () => MemoryIndexState;
  /** term → section id → posting; derived from `state().docs`. */
  private postingMap = new Map<string, Map<string, Posting>>();
  private totals = { title: 0, heading: 0, body: 0 };
  private sectionCount = 0;

  constructor(state: () => MemoryIndexState) {
    this.state = state;
    this.rebuild();
  }

  get analyzer(): AnalyzerOptions {
    return this.state().analyzer;
  }

  /** Recomputes the posting maps from the stored docs (after open, reset or rollback). */
  rebuild(): void {
    this.postingMap = new Map();
    this.totals = { title: 0, heading: 0, body: 0 };
    this.sectionCount = 0;
    for (const doc of this.state().docs.values()) this.insertDoc(doc);
  }

  private insertDoc(doc: MemoryDoc): void {
    doc.sections.forEach((section, i) => {
      const analyzed = doc.analyzed[i] as AnalyzedSection;
      this.sectionCount++;
      for (const f of FIELDS) this.totals[f] += analyzed.lengths[f];
      for (const [term, entry] of analyzed.terms) {
        let list = this.postingMap.get(term);
        if (!list) this.postingMap.set(term, (list = new Map()));
        list.set(section.id, {
          id: section.id,
          tf: entry.tf,
          lengths: analyzed.lengths,
          positions: entry.positions,
        });
      }
    });
  }

  private removeDoc(doc: MemoryDoc): void {
    doc.sections.forEach((section, i) => {
      const analyzed = doc.analyzed[i] as AnalyzedSection;
      this.sectionCount--;
      for (const f of FIELDS) this.totals[f] -= analyzed.lengths[f];
      for (const term of analyzed.terms.keys()) {
        const list = this.postingMap.get(term) as Map<string, Posting>;
        list.delete(section.id);
        if (list.size === 0) this.postingMap.delete(term);
      }
    });
  }

  analyzerMismatch(requested?: Partial<AnalyzerOptions>): AnalyzerMismatch | null {
    return compareAnalyzers(this.analyzer, requested);
  }

  replaceSections(path: string, title: string, sections: readonly SectionInput[]): void {
    if (typeof path !== 'string' || path === '') throw new RangeError('path must be non-empty');
    const stored: StoredSection[] = [];
    const analyzed: AnalyzedSection[] = [];
    sections.forEach((input, index) => {
      const a = analyzeSection(
        { title, heading: input.heading ?? '', body: input.body },
        this.analyzer,
      );
      analyzed.push(a);
      stored.push({
        id: sectionId(path, index),
        path,
        index,
        title,
        heading: input.heading,
        body: input.body,
        startLine: input.startLine ?? 0,
        endLine: input.endLine ?? 0,
        lengths: a.lengths,
      });
    });
    this.removeSections(path);
    if (stored.length === 0) return;
    const doc = { sections: stored, analyzed };
    this.state().docs.set(path, doc);
    this.insertDoc(doc);
  }

  removeSections(path: string): boolean {
    const docs = this.state().docs;
    const doc = docs.get(path);
    if (!doc) return false;
    docs.delete(path);
    this.removeDoc(doc);
    return true;
  }

  getSection(id: string): StoredSection | undefined {
    const at = id.lastIndexOf('#');
    if (at < 0) return undefined;
    const doc = this.state().docs.get(id.slice(0, at));
    return doc?.sections.find((s) => s.id === id);
  }

  sectionsOf(path: string): StoredSection[] {
    return [...(this.state().docs.get(path)?.sections ?? [])];
  }

  statistics(): IndexStatistics {
    const documentFrequencies = [...this.postingMap]
      .map(([term, list]) => [term, list.size] as const)
      .sort(([a], [b]) => compareStrings(a, b));
    return {
      sectionCount: this.sectionCount,
      totalFieldLengths: { ...this.totals },
      documentFrequencies,
    };
  }

  corpusStats(): CorpusStats {
    const n = this.sectionCount;
    const avg = (f: (typeof FIELDS)[number]): number => (n === 0 ? 0 : this.totals[f] / n);
    return {
      sectionCount: n,
      averageFieldLengths: { title: avg('title'), heading: avg('heading'), body: avg('body') },
    };
  }

  documentFrequency(term: string): number {
    return this.postingMap.get(term)?.size ?? 0;
  }

  postings(term: string): Posting[] {
    return [...(this.postingMap.get(term)?.values() ?? [])];
  }
}

// ---------------------------------------------------------------------------
// The aggregate

export interface MemoryStoresOptions extends StoresOptions {
  /** The data to open; a new, empty brain when omitted. */
  readonly data?: MemoryBrainData;
}

/** The memory stores, plus the data object they use (to reopen it later). */
export interface MemoryStores extends Stores {
  readonly data: MemoryBrainData;
}

/**
 * Opens memory stores over `options.data` (or a new, empty brain). Like a
 * database file, a term index that holds sections keeps the analyzer it was
 * built with; check `terms.analyzerMismatch(...)`.
 */
export function createMemoryStores(options: MemoryStoresOptions = {}): MemoryStores {
  const data = options.data ?? new MemoryBrainData();
  const requested = resolveAnalyzerOptions(options.analyzer ?? DEFAULT_ANALYZER_OPTIONS);
  if (!data.index) data.index = newIndexState(requested);
  else if (data.index.docs.size === 0) data.index.analyzer = requested;
  const clock = options.now ?? unixNow;
  let closed = false;
  let depth = 0;
  const state = (): MemoryIndexState => {
    if (closed) throw new Error('these memory stores are closed');
    return data.index as MemoryIndexState;
  };

  const terms = new MemoryTermIndex(state);
  const stores: MemoryStores = {
    data,
    events: new MemoryEventLog(data, clock),
    meta: new MemoryMeta(() => data.meta),
    scores: new MemoryScoreStore(state),
    notes: new MemoryNoteStore(state),
    terms,
    indexMeta: new MemoryMeta(() => state().meta),
    async indexTransaction<T>(fn: () => T | Promise<T>): Promise<T> {
      if (depth > 0) return await fn();
      const before = snapshotIndex(state());
      depth++;
      try {
        return await fn();
      } catch (error) {
        data.index = before;
        terms.rebuild();
        throw error;
      } finally {
        depth--;
      }
    },
    resetIndex(resetOptions?: { readonly analyzer?: Partial<AnalyzerOptions> }): void {
      const analyzer = resetOptions?.analyzer
        ? resolveAnalyzerOptions(resetOptions.analyzer)
        : requested;
      data.index = newIndexState(analyzer);
      terms.rebuild();
    },
    close(): void {
      closed = true;
    },
  };
  return stores;
}
