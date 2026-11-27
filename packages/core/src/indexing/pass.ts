// The incremental index pass (IMPLEMENTATION.md tasks 1.7 to 1.10; PLAN.md
// section 4): bring the derived stores up to date with the working tree, and
// log the `edit`, `mention` and rename records the changes imply.
//
// Change detection is cheap first: a file whose size and nanosecond mtime
// equal the last pass's is not read. Otherwise its content is hashed
// (SHA-256), and only a different hash re-indexes it.
//
// Events, only after the baseline (the first pass over an empty index logs
// nothing, since nothing is known to have changed):
// - `edit`, for a memo whose content changed, or a new memo, at the file's
//   mtime (at most now).
// - `mention`, for each link item (memo path or dangling key) that a changed
//   or new memo or dated note's new version links and its old version did not
//   (`markdown.addedLinkItems` semantics, both versions resolved against the
//   brain as it is now), at the same time as the note's edit.
// - Source-role files log nothing; a changed one is reported as a warning.
// - Rename records, dated at the pass's time: a path that disappeared plus a
//   new path with the same content is a move. Between two memos it logs a
//   rename record and no edit. A move that also changed the content is, by
//   construction, a delete plus a new note (nothing matches its hash). A move
//   between a memo and another role is a delete plus a new note too. And when
//   a new memo resolves a link that used to dangle, a rename record from the
//   dangling key to the memo carries the key's history over.
// - A deleted note's sections, links and stored link targets are removed; its
//   scores stay with its path (history is history).
//
// Concurrency. Every pass that writes holds the index database's write lock
// (`indexTransaction` is `BEGIN IMMEDIATE`) from before it re-reads the
// working tree and the stored notes until it commits. A second process's
// pass waits for the lock, then sees the first pass's results, finds nothing
// left to do, and logs nothing. As a second guarantee, which also covers a
// crash between appending to the event log and committing the index, every
// id the pass logs is derived from what it describes (kind, path, old and new
// content hash, time), so logging the same change twice stores it once.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { markdown, storage } from '@somememos/core';
import {
  META_BASELINE,
  META_FIRST_INDEXED,
  deleteLinkTargets,
  readFingerprints,
  readLinkTargets,
  readUncommitted,
  writeFingerprints,
  writeLinkTargets,
  writeUncommitted,
} from './state.js';
import { fingerprint, walkBrain, type WalkResult, type WalkedFile } from './walk.js';

export interface IndexPassOptions {
  /** The brain's root directory. */
  readonly root: string;
  readonly stores: storage.Stores;
  readonly config: storage.BrainConfig;
  /** `markdown.createRoleClassifier(config.roles)`. */
  readonly classifier: markdown.RoleClassifier;
  /** The clock, whole Unix seconds. Default: the system clock. */
  readonly now?: () => number;
  /**
   * Delete all derived data and rebuild it from the files and the event log.
   * Events are still logged for files that changed since the last pass.
   */
  readonly rebuild?: boolean;
}

export interface IndexSummary {
  /** Indexable markdown files found (excluded files are not counted). */
  scanned: number;
  /** Notes parsed and written: new, changed, moved, or all of them on a rebuild. */
  indexed: number;
  /** Notes removed because their file is gone (moves not counted). */
  removed: number;
  /** Moves detected (same content at a new path). */
  renamed: number;
  /** Unchanged notes whose links were re-resolved because the set of notes changed. */
  relinked: number;
  /**
   * Log entries this pass recorded. `rename` counts moves and dangling
   * carry-overs. An entry the log already held (from a pass that crashed
   * before committing) is counted but not stored twice.
   */
  events: { edit: number; mention: number; rename: number };
  /** One line each, safe to print. */
  warnings: string[];
  /** Paths this pass marked as changed and not yet committed. */
  changed: string[];
  /** True when this was a baseline pass (an empty index), which logs no events. */
  baseline: boolean;
  /** True when derived data was deleted and rebuilt. */
  rebuilt: boolean;
  /** What folding the event log into scores did afterwards. */
  folded: { events: number; renames: number };
  /** Wall time of the pass, in milliseconds. */
  ms: number;
}

/** SHA-256 of a file's bytes, hex. */
export function contentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A deterministic log id: the same change described twice gets the same id. */
export function derivedId(...parts: readonly (string | number)[]): string {
  return `ix-${createHash('sha256').update(parts.join('\0')).digest('hex')}`;
}

/** The comparable last segment of a link target or path: no `.md`, case-folded, spaces collapsed. */
function nameKey(target: string): string {
  const trimmed = target.trim().replace(/\/+$/, '');
  return markdown
    .stripMd(markdown.baseName(trimmed))
    .normalize('NFC')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function distinct(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

/** Read a file; undefined if it vanished since the walk. */
function readBytes(root: string, path: string): Buffer | undefined {
  try {
    return readFileSync(join(root, path));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') return undefined;
    throw error;
  }
}

/**
 * True when the stored index matches the walk exactly: a baseline exists,
 * the same paths, and each with the same stat fingerprint, role and date.
 * Reads only; this is how a pass with nothing to do stays write-free.
 */
async function upToDate(stores: storage.Stores, walk: WalkResult): Promise<boolean> {
  if ((await stores.indexMeta.get(META_BASELINE)) === undefined) return false;
  const notes = await stores.notes.listNotes();
  if (notes.length !== walk.files.size) return false;
  const prints = await readFingerprints(stores.indexMeta);
  for (const note of notes) {
    const file = walk.files.get(note.path);
    if (!file || prints[note.path] !== fingerprint(file)) return false;
    if (file.role !== note.role || file.date !== note.date) return false;
  }
  return true;
}

/** Counts and lists the pass fills in. */
interface PassResult {
  scanned: number;
  indexed: number;
  removed: number;
  renamed: number;
  relinked: number;
  events: { edit: number; mention: number; rename: number };
  warnings: string[];
  changed: string[];
  baseline: boolean;
  rebuilt: boolean;
  folded: { events: number; renames: number };
}

/** Index everything that changed. Runs inside `indexTransaction`. */
async function indexChanges(opts: IndexPassOptions, rebuild: boolean): Promise<PassResult> {
  const { root, stores, config, classifier } = opts;
  const nowFn = opts.now ?? storage.unixNow;
  const now = nowFn();
  const { indexMeta, meta, notes: noteStore, terms } = stores;
  const warnings: string[] = [];

  // Re-walk under the lock: another process may have changed things.
  const walk = walkBrain(root, classifier);
  const files = new Map(walk.files);

  // --- Prior state: what the last pass stored.
  const baseline = (await indexMeta.get(META_BASELINE)) === undefined;
  const prior = new Map((await noteStore.listNotes()).map((n) => [n.path, n]));
  const priorTargetsCache = new Map<string, string[]>();
  const priorTargets = async (path: string): Promise<string[]> => {
    let t = priorTargetsCache.get(path);
    if (!t) priorTargetsCache.set(path, (t = await readLinkTargets(indexMeta, path)));
    return t;
  };
  let prints: Record<string, string> = await readFingerprints(indexMeta);

  if (rebuild) {
    // Snapshot what the rebuild needs from the old index, then delete it.
    for (const path of prior.keys()) await priorTargets(path);
    await stores.resetIndex({ analyzer: config.analyzer });
    prints = {};
  }
  if (baseline && !rebuild) {
    if ((await meta.get(META_FIRST_INDEXED)) !== undefined) {
      warnings.push(
        'the index was empty, so changes made since the last pass were indexed but not logged as events',
      );
    }
  }
  const logEvents = !baseline;

  // --- Classify each walked file.
  interface Loaded {
    file: WalkedFile;
    text: string;
    hash: string;
  }
  const changedContent = new Map<string, Loaded>(); // existed before, content differs
  const added = new Map<string, Loaded>(); // no note at this path before
  const sameContent = new Map<string, Loaded>(); // re-read, same hash (touched, role change, or rebuild)

  for (const file of [...files.values()]) {
    const before = prior.get(file.path);
    if (
      before &&
      !rebuild &&
      prints[file.path] === fingerprint(file) &&
      before.role === file.role &&
      before.date === file.date
    ) {
      continue;
    }
    const bytes = readBytes(root, file.path);
    if (!bytes) {
      files.delete(file.path);
      continue;
    }
    const loaded: Loaded = { file, text: bytes.toString('utf8'), hash: contentHash(bytes) };
    if (!before) added.set(file.path, loaded);
    else if (before.contentHash !== loaded.hash) changedContent.set(file.path, loaded);
    else sameContent.set(file.path, loaded);
  }

  const missing = [...prior.keys()].filter((p) => !files.has(p)).sort();
  const pathSetChanged = added.size > 0 || missing.length > 0;

  // --- Moves: a missing path and a new path with the same content.
  const byHash = new Map<string, string[]>();
  for (const path of missing) {
    const hash = (prior.get(path) as storage.NoteRecord).contentHash;
    const list = byHash.get(hash);
    if (list) list.push(path);
    else byHash.set(hash, [path]);
  }
  const moves: { from: string; to: string }[] = [];
  const movedFrom = new Set<string>();
  for (const [path, loaded] of [...added].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const candidates = byHash.get(loaded.hash);
    if (!candidates) continue;
    const isMemo = loaded.file.role === 'memo';
    const i = candidates.findIndex(
      (m) => ((prior.get(m) as storage.NoteRecord).role === 'memo') === isMemo,
    );
    if (i < 0) continue;
    const from = candidates.splice(i, 1)[0] as string;
    moves.push({ from, to: path });
    movedFrom.add(from);
  }
  const movedTo = new Map(moves.map((m) => [m.to, m.from]));
  const movedToOf = new Map(moves.map((m) => [m.from, m.to]));
  const deleted = missing.filter((p) => !movedFrom.has(p));
  const deletedSet = new Set(deleted);

  // --- Resolvers.
  const resolver = markdown.createLinkResolver(files.keys());
  const oldResolver = pathSetChanged ? markdown.createLinkResolver(prior.keys()) : resolver;
  const excludedResolver =
    walk.excluded.size > 0 ? markdown.createLinkResolver(walk.excluded) : null;

  /** True when a link points into excluded territory: it is dropped entirely. */
  const isExcludedLink = (target: string, source: string): boolean => {
    if (excludedResolver?.resolve(target, source).kind === 'resolved') return true;
    const candidates: (string | null)[] = [markdown.normalizePath(target)];
    if (!target.startsWith('/')) {
      const folder = markdown.dirName(source);
      candidates.push(markdown.normalizePath(folder === '' ? target : `${folder}/${target}`));
    }
    for (const c of candidates) {
      if (c === null) continue;
      const path = markdown.isMarkdownPath(c) ? c : `${c}.md`;
      if (classifier.classify(path)?.role === 'excluded') return true;
    }
    return false;
  };

  /** Distinct link items of `targets` from `source` (self-links and excluded links dropped). */
  const resolveLinks = (
    targets: readonly string[],
    source: string,
    using: markdown.LinkResolver,
  ): storage.NoteLink[] => {
    const out = new Map<string, boolean>();
    for (const target of targets) {
      if (isExcludedLink(target, source)) continue;
      const r = using.resolve(target, source);
      if (r.kind === 'resolved' && r.path === source) continue;
      const item = markdown.resolutionItem(r);
      if (!out.has(item)) out.set(item, r.kind === 'dangling');
    }
    return [...out].map(([target, dangling]) => ({ target, dangling }));
  };

  // Load every prior link list the steps below need before anything is
  // overwritten or deleted.
  for (const path of pathSetChanged ? prior.keys() : changedContent.keys()) {
    await priorTargets(path);
  }

  // --- Writes.
  const logEntries: storage.LogInput[] = [];
  const events = { edit: 0, mention: 0, rename: 0 };
  const client = config.clientId;
  const changed = new Set<string>();

  for (const path of missing) {
    await noteStore.removeNote(path);
    await terms.removeSections(path);
    await deleteLinkTargets(indexMeta, path);
  }

  const writeNote = async (loaded: Loaded): Promise<string[]> => {
    const { file, text, hash } = loaded;
    const parsed = markdown.parseNote(file.path, text);
    const targets = distinct(parsed.links.map((l) => l.target));
    await noteStore.upsertNote({
      path: file.path,
      title: parsed.title,
      contentHash: hash,
      mtime: file.mtime,
      role: file.role,
      date: file.date,
    });
    await terms.replaceSections(file.path, parsed.title, parsed.sections);
    await noteStore.replaceLinks(file.path, resolveLinks(targets, file.path, resolver));
    await writeLinkTargets(indexMeta, file.path, targets);
    return targets;
  };

  const eventTime = (file: WalkedFile): number => Math.max(0, Math.min(file.mtime, now));

  /** Edit and mention events for a note whose content is new or changed. */
  const logContentChange = async (
    loaded: Loaded,
    newTargets: readonly string[],
    oldTargets: readonly string[],
    oldHash: string,
  ): Promise<void> => {
    const { file, hash } = loaded;
    if (file.role === 'source') {
      if (oldHash !== '') {
        warnings.push(
          `source changed: ${file.path} (re-indexed; sources are immutable, no event logged)`,
        );
      }
      return;
    }
    if (!logEvents) return;
    const time = eventTime(file);
    if (file.role === 'memo') {
      logEntries.push({
        id: derivedId('edit', file.path, oldHash, hash, time),
        kind: 'edit',
        item: file.path,
        time,
        client,
      });
      events.edit++;
    }
    const before = new Set(resolveLinks(oldTargets, file.path, resolver).map((l) => l.target));
    for (const link of resolveLinks(newTargets, file.path, resolver)) {
      if (before.has(link.target)) continue;
      if (!link.dangling && files.get(link.target)?.role !== 'memo') continue;
      logEntries.push({
        id: derivedId('mention', file.path, link.target, oldHash, hash, time),
        kind: 'mention',
        item: link.target,
        time,
        client,
      });
      events.mention++;
    }
  };

  let indexed = 0;
  for (const [path, loaded] of changedContent) {
    const oldTargets = await priorTargets(path);
    const oldHash = (prior.get(path) as storage.NoteRecord).contentHash;
    const targets = await writeNote(loaded);
    indexed++;
    changed.add(path);
    await logContentChange(loaded, targets, oldTargets, oldHash);
  }
  for (const [path, loaded] of added) {
    const targets = await writeNote(loaded);
    indexed++;
    changed.add(path);
    const from = movedTo.get(path);
    if (from !== undefined) {
      changed.add(from);
      if (loaded.file.role === 'memo' && logEvents) {
        logEntries.push({
          id: derivedId('rename', from, path, loaded.hash),
          kind: 'rename',
          item: from,
          to: path,
          time: now,
          client,
        });
        events.rename++;
      }
      continue;
    }
    await logContentChange(loaded, targets, [], '');
  }
  for (const [path, loaded] of sameContent) {
    if (rebuild) {
      await writeNote(loaded);
      indexed++;
    } else {
      // Touched, or its role changed: the content (and so sections and links) is the same.
      const before = prior.get(path) as storage.NoteRecord;
      await noteStore.upsertNote({
        ...before,
        mtime: loaded.file.mtime,
        role: loaded.file.role,
        date: loaded.file.date,
      });
    }
  }
  for (const path of deleted) changed.add(path);

  // --- Notes whose links may resolve differently now that the set of notes
  // changed: those with a link whose name matches an added or removed path.
  let relinked = 0;
  if (pathSetChanged) {
    const touchedNames = new Set([...added.keys(), ...missing].map(nameKey));
    const addedNames = new Set([...added.keys()].map(nameKey));
    const carried = new Map<string, string>(); // dangling key -> new memo
    for (const [oldPath] of prior) {
      if (deletedSet.has(oldPath)) continue;
      const newPath = movedToOf.get(oldPath) ?? oldPath;
      const targets = await priorTargets(oldPath);
      if (!targets.some((t) => touchedNames.has(nameKey(t)))) continue;

      // Dangling carry-over: a link that dangled and now resolves to a new memo.
      if (logEvents) {
        for (const target of targets) {
          if (!addedNames.has(nameKey(target)) || isExcludedLink(target, oldPath)) continue;
          const was = oldResolver.resolve(target, oldPath);
          if (was.kind !== 'dangling' || carried.has(was.key)) continue;
          const is = resolver.resolve(target, newPath);
          if (is.kind !== 'resolved' || !added.has(is.path)) continue;
          if (files.get(is.path)?.role !== 'memo') continue;
          carried.set(was.key, is.path);
        }
      }

      // Re-resolve the stored links of notes this pass did not rewrite.
      if (
        !changedContent.has(oldPath) &&
        !added.has(newPath) &&
        !(rebuild && sameContent.has(oldPath))
      ) {
        await noteStore.replaceLinks(oldPath, resolveLinks(targets, oldPath, resolver));
        relinked++;
      }
    }
    for (const [key, path] of [...carried].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const hash = (added.get(path) as Loaded).hash;
      logEntries.push({
        id: derivedId('rename', key, path, hash),
        kind: 'rename',
        item: key,
        to: path,
        time: now,
        client,
      });
      events.rename++;
    }
  }

  // --- Bookkeeping.
  const nextPrints: Record<string, string> = {};
  for (const file of files.values()) nextPrints[file.path] = fingerprint(file);
  await writeFingerprints(indexMeta, nextPrints);
  // `resetIndex` deleted the marker on a rebuild; the rebuilt index has a baseline again.
  if (baseline || rebuild) await indexMeta.set(META_BASELINE, String(now));
  if ((await meta.get(META_FIRST_INDEXED)) === undefined) {
    await meta.set(META_FIRST_INDEXED, String(now));
  }

  // Renames first, so the log reads in the order things happened in this pass.
  logEntries.sort((a, b) => Number(b.kind === 'rename') - Number(a.kind === 'rename'));
  if (logEntries.length > 0) await stores.events.append(logEntries, { now });

  const changedList = logEvents ? [...changed].sort() : [];
  if (changedList.length > 0) {
    await writeUncommitted(meta, [...(await readUncommitted(meta)), ...changedList]);
  }

  let folded = { events: 0, renames: 0 };
  if (rebuild) {
    // Refold inside the transaction, so no reader sees the scores half rebuilt.
    const f = await storage.rebuildScores(stores.events, stores.scores, {
      halfLives: config.halfLives,
    });
    folded = { events: f.events, renames: f.renames };
  }

  return {
    scanned: files.size,
    indexed,
    removed: deleted.length,
    renamed: moves.length,
    relinked,
    events,
    warnings,
    changed: changedList,
    baseline,
    rebuilt: rebuild,
    folded,
  };
}

/**
 * Runs one index pass and folds the event log into scores. With nothing to
 * do it only reads. Safe to run from several processes at once.
 */
export async function runIndexPass(opts: IndexPassOptions): Promise<IndexSummary> {
  const started = performance.now();
  const { stores, config } = opts;
  let rebuild = opts.rebuild ?? false;
  const notes: string[] = [];
  if (!rebuild && stores.terms.analyzerMismatch(config.analyzer)) {
    rebuild = true;
    notes.push('the keyword index was built with other analyzer options, so it was rebuilt');
  }

  let result: PassResult;
  if (rebuild) {
    result = await stores.indexTransaction(() => indexChanges(opts, true));
  } else {
    const walk = walkBrain(opts.root, opts.classifier);
    if (!(await upToDate(stores, walk))) {
      result = await stores.indexTransaction(() => indexChanges(opts, false));
    } else {
      result = {
        scanned: walk.files.size,
        indexed: 0,
        removed: 0,
        renamed: 0,
        relinked: 0,
        events: { edit: 0, mention: 0, rename: 0 },
        warnings: [],
        changed: [],
        baseline: false,
        rebuilt: false,
        folded: { events: 0, renames: 0 },
      };
    }
  }

  const fold = await storage.foldPending(stores.events, stores.scores, {
    halfLives: config.halfLives,
  });
  return {
    ...result,
    warnings: [...notes, ...result.warnings],
    folded: {
      events: result.folded.events + fold.events,
      renames: result.folded.renames + fold.renames,
    },
    rebuilt: result.rebuilt || fold.rebuilt,
    ms: Math.round((performance.now() - started) * 10) / 10,
  };
}
