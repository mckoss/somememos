// The incremental index pass (IMPLEMENTATION.md tasks 1.7 to 1.10 and 2.0;
// PLAN.md section 4): bring the derived stores up to date with a
// `ContentStore`, and log the `edit`, `mention` and rename records the changes
// imply. Isomorphic: the CLI runs it over the file system, the web app over a
// table in the browser.
//
// Change detection is cheap first: a file whose fingerprint
// (`storage.contentFingerprint`: size and nanosecond mtime on the file system,
// size, mtime and hash in a table) equals the last pass's is not read.
// Otherwise its content is hashed (SHA-256 of the UTF-8 text, unless the store
// already knows the hash), and only a different hash re-indexes it. Paths
// given in `paths` are always compared, whatever their fingerprint.
//
// Events, only after the baseline (the first pass over an empty index logs
// nothing, since nothing is known to have changed):
// - `edit`, for a scored note (a memo or a blog post; `markdown.isScoredRole`)
//   whose content changed, or a new one, at the file's mtime (at most now).
//   Below, "memo" means any scored note.
// - `mention`, for each link item (memo path or dangling key) that a changed
//   or new memo or dated note's new version links and its old version did not
//   (`markdown.addedLinkItems` semantics, both versions resolved against the
//   brain as it is now), at the same time as the note's edit.
// - Source-role files log nothing; a changed one is reported as a warning.
// - Links into excluded territory and links to attachments (a target with a
//   non-`.md` extension that resolves to no note, such as `![[photo.png]]`)
//   are dropped (./links.ts).
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
// (`indexTransaction`; `BEGIN IMMEDIATE` in SQLite) from before it re-lists
// the content and the stored notes until it commits. A second process's
// pass waits for the lock, then sees the first pass's results, finds nothing
// left to do, and logs nothing. As a second guarantee, which also covers a
// crash between appending to the event log and committing the index, every
// id the pass logs is derived from what it describes (kind, path, old and new
// content hash, time), so logging the same change twice stores it once.
//
// Changes from elsewhere. Sync records the notes it is about to write
// (`indexer.pendingRemote`, ./state.ts) before writing them. A pass treats a
// note whose content hash equals its pending hash as such a change and logs
// nothing for it (no edit, mention or rename, and it is not uncommitted),
// even when a crash came between the write and sync's own no-logging pass.
// A note edited locally since then has another hash and is logged as usual.

import * as markdown from '../markdown/index.js';
import {
  contentFingerprint,
  contentHash,
  sha256Hex,
  type ContentEntry,
  type ContentStore,
} from '../storage/content.js';
import { foldOptions, type BrainConfig } from '../storage/config.js';
import { foldPending, rebuildScores } from '../storage/fold.js';
import type { LogInput, NoteLink, NoteRecord, NoteRole, Stores } from '../storage/types.js';
import { unixNow } from '../storage/validate.js';
import { ExcludedLinks, linkItemsOf } from './links.js';
import {
  META_BASELINE,
  META_FIRST_INDEXED,
  clearPendingRemote,
  deleteLinkTargets,
  readPendingRemote,
  readFingerprints,
  readLinkTargets,
  readUncommitted,
  type PendingRemote,
  writeFingerprints,
  writeLinkTargets,
  writeUncommitted,
} from './state.js';

export interface IndexPassOptions {
  readonly stores: Stores;
  /** Where the notes' text lives. */
  readonly content: ContentStore;
  readonly config: BrainConfig;
  /** `markdown.createRoleClassifier(config.roles)`. Default: built from `config`. */
  readonly classifier?: markdown.RoleClassifier;
  /** The clock, whole Unix seconds. Default: the system clock. */
  readonly now?: () => number;
  /**
   * Delete all derived data and rebuild it from the content and the event
   * log. Events are still logged for files that changed since the last pass.
   */
  readonly rebuild?: boolean;
  /**
   * Paths the caller knows changed (written, created, removed or renamed,
   * both sides): each is re-read and compared even when its fingerprint looks
   * unchanged, and the pass never takes the read-only shortcut. Other files
   * are still listed, so new and vanished files are found too; an unchanged
   * one is not read. Use it after a save, so a coarse mtime can't hide it.
   */
  readonly paths?: readonly string[];
  /**
   * Log the events the changes imply, and mark changed paths as uncommitted.
   * Default true. False is for changes that arrived from elsewhere (sync,
   * PLAN.md section 4, "What does not count"): the client that made them
   * already logged their edits, mentions, renames and dangling carry-overs,
   * and those records arrive through the event log. The derived data
   * (notes, links, sections, relinking) is updated exactly as usual.
   */
  readonly record?: boolean;
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

/** A deterministic log id: the same change described twice gets the same id. */
export async function derivedId(...parts: readonly (string | number)[]): Promise<string> {
  return `ix-${await sha256Hex(parts.join('\0'))}`;
}

/** An indexable file in a content listing, classified. */
export interface ListedFile {
  readonly path: string;
  readonly role: NoteRole;
  /** For a `dated` file or a dated `blog` post, its date (`YYYY-MM-DD`); otherwise null. */
  readonly date: string | null;
  readonly size: number;
  /** Whole Unix seconds (what notes and events record). */
  readonly mtime: number;
  /** `storage.contentFingerprint(entry)`. */
  readonly fingerprint: string;
  /** The hash, when the store knows it without reading. */
  readonly hash: string | undefined;
}

export interface ContentListing {
  /** Indexable files (role memo, dated, source or blog), by path, in sorted path order. */
  readonly files: ReadonlyMap<string, ListedFile>;
  /**
   * Paths of `excluded` files. Kept in memory only, so links to them can be
   * dropped; never stored, logged or printed.
   */
  readonly excluded: ReadonlySet<string>;
}

function listedFile(entry: ContentEntry, role: NoteRole, date: string | null): ListedFile {
  return {
    path: entry.path,
    role,
    date,
    size: entry.size,
    mtime: entry.mtime,
    fingerprint: contentFingerprint(entry),
    hash: entry.hash,
  };
}

/**
 * Lists `content` and classifies each markdown file with `classifier`. Files
 * whose role is `excluded` go to `excluded`; files with no role (roles are
 * declared and none matched) and paths that are not markdown are ignored.
 */
export async function listContent(
  content: ContentStore,
  classifier: markdown.RoleClassifier,
): Promise<ContentListing> {
  const found: ListedFile[] = [];
  const excluded = new Set<string>();
  for (const entry of await content.list()) {
    if (!markdown.isMarkdownPath(entry.path)) continue;
    const match = classifier.classify(entry.path);
    if (!match) continue;
    if (match.role === 'excluded') excluded.add(entry.path);
    else found.push(listedFile(entry, match.role, match.date ?? null));
  }
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files: new Map(found.map((f) => [f.path, f])), excluded };
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

/**
 * True when the stored index matches the listing exactly: a baseline exists,
 * the same paths, and each with the same fingerprint, role and date.
 * Reads only; this is how a pass with nothing to do stays write-free.
 */
async function upToDate(stores: Stores, listing: ContentListing): Promise<boolean> {
  if ((await stores.indexMeta.get(META_BASELINE)) === undefined) return false;
  const notes = await stores.notes.listNotes();
  if (notes.length !== listing.files.size) return false;
  const prints = await readFingerprints(stores.indexMeta);
  for (const note of notes) {
    const file = listing.files.get(note.path);
    if (!file || prints[note.path] !== file.fingerprint) return false;
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
async function indexChanges(
  opts: IndexPassOptions,
  rebuild: boolean,
  pendingRemote: PendingRemote,
): Promise<PassResult> {
  const { stores, content, config } = opts;
  const classifier = opts.classifier ?? markdown.createRoleClassifier(config.roles);
  const nowFn = opts.now ?? unixNow;
  const now = nowFn();
  const { indexMeta, meta, notes: noteStore, terms } = stores;
  const warnings: string[] = [];
  const forced = new Set([...(opts.paths ?? []), ...Object.keys(pendingRemote)]);
  /**
   * True when sync recorded that it writes `path` with `hash` (null: removes
   * it) from elsewhere: nothing is logged for it, as with `record: false`.
   */
  const fromElsewhere = (path: string, hash: string | null): boolean =>
    Object.hasOwn(pendingRemote, path) && pendingRemote[path] === hash;

  // Re-list under the lock: another process may have changed things.
  const listing = await listContent(content, classifier);
  const files = new Map(listing.files);

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
  const logEvents = !baseline && (opts.record ?? true);

  // --- Classify each listed file.
  interface Loaded {
    file: ListedFile;
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
      !forced.has(file.path) &&
      prints[file.path] === file.fingerprint &&
      before.role === file.role &&
      before.date === file.date
    ) {
      continue;
    }
    const text = await content.read(file.path);
    if (text === undefined) {
      // Vanished since the listing.
      files.delete(file.path);
      continue;
    }
    const loaded: Loaded = { file, text, hash: file.hash ?? (await contentHash(text)) };
    if (!before) added.set(file.path, loaded);
    else if (before.contentHash !== loaded.hash) changedContent.set(file.path, loaded);
    else sameContent.set(file.path, loaded);
  }

  const missing = [...prior.keys()].filter((p) => !files.has(p)).sort();
  const pathSetChanged = added.size > 0 || missing.length > 0;

  // --- Moves: a missing path and a new path with the same content.
  const byHash = new Map<string, string[]>();
  for (const path of missing) {
    const hash = (prior.get(path) as NoteRecord).contentHash;
    const list = byHash.get(hash);
    if (list) list.push(path);
    else byHash.set(hash, [path]);
  }
  const moves: { from: string; to: string }[] = [];
  const movedFrom = new Set<string>();
  for (const [path, loaded] of [...added].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const candidates = byHash.get(loaded.hash);
    if (!candidates) continue;
    const isMemo = markdown.isScoredRole(loaded.file.role);
    const i = candidates.findIndex(
      (m) => markdown.isScoredRole((prior.get(m) as NoteRecord).role) === isMemo,
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
  const excludedLinks = new ExcludedLinks(
    (path) => classifier.classify(path)?.role,
    listing.excluded,
  );
  const isExcludedLink = (target: string, source: string): boolean =>
    excludedLinks.has(target, source);

  /** Distinct link items of `targets` from `source` (self, excluded and attachment links dropped). */
  const resolveLinks = (targets: readonly string[], source: string): NoteLink[] =>
    linkItemsOf(targets, source, resolver, excludedLinks);

  // Load every prior link list the steps below need before anything is
  // overwritten or deleted.
  for (const path of pathSetChanged ? prior.keys() : changedContent.keys()) {
    await priorTargets(path);
  }

  // --- Writes.
  const logEntries: LogInput[] = [];
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
    await noteStore.replaceLinks(file.path, resolveLinks(targets, file.path));
    await writeLinkTargets(indexMeta, file.path, targets);
    return targets;
  };

  const eventTime = (file: ListedFile): number => Math.max(0, Math.min(file.mtime, now));

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
    if (!logEvents || fromElsewhere(file.path, hash)) return;
    const time = eventTime(file);
    if (markdown.isScoredRole(file.role)) {
      logEntries.push({
        id: await derivedId('edit', file.path, oldHash, hash, time),
        kind: 'edit',
        item: file.path,
        time,
        client,
      });
      events.edit++;
    }
    const before = new Set(resolveLinks(oldTargets, file.path).map((l) => l.target));
    for (const link of resolveLinks(newTargets, file.path)) {
      if (before.has(link.target)) continue;
      if (!link.dangling && !markdown.isScoredRole(files.get(link.target)?.role)) continue;
      logEntries.push({
        id: await derivedId('mention', file.path, link.target, oldHash, hash, time),
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
    const oldHash = (prior.get(path) as NoteRecord).contentHash;
    const targets = await writeNote(loaded);
    indexed++;
    if (!fromElsewhere(path, loaded.hash)) changed.add(path);
    await logContentChange(loaded, targets, oldTargets, oldHash);
  }
  for (const [path, loaded] of added) {
    const targets = await writeNote(loaded);
    indexed++;
    const remote = fromElsewhere(path, loaded.hash);
    if (!remote) changed.add(path);
    const from = movedTo.get(path);
    if (from !== undefined) {
      if (!remote) changed.add(from);
      if (markdown.isScoredRole(loaded.file.role) && logEvents && !remote) {
        logEntries.push({
          id: await derivedId('rename', from, path, loaded.hash),
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
      const before = prior.get(path) as NoteRecord;
      await noteStore.upsertNote({
        ...before,
        mtime: loaded.file.mtime,
        role: loaded.file.role,
        date: loaded.file.date,
      });
    }
  }
  for (const path of deleted) if (!fromElsewhere(path, null)) changed.add(path);

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
          // An attachment link that dangled was ignored: it has no history to carry.
          if (markdown.hasNonMarkdownExtension(target)) continue;
          const is = resolver.resolve(target, newPath);
          if (is.kind !== 'resolved' || !added.has(is.path)) continue;
          if (!markdown.isScoredRole(files.get(is.path)?.role)) continue;
          if (fromElsewhere(is.path, (added.get(is.path) as Loaded).hash)) continue;
          carried.set(was.key, is.path);
        }
      }

      // Re-resolve the stored links of notes this pass did not rewrite.
      if (
        !changedContent.has(oldPath) &&
        !added.has(newPath) &&
        !(rebuild && sameContent.has(oldPath))
      ) {
        await noteStore.replaceLinks(oldPath, resolveLinks(targets, oldPath));
        relinked++;
      }
    }
    for (const [key, path] of [...carried].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const hash = (added.get(path) as Loaded).hash;
      logEntries.push({
        id: await derivedId('rename', key, path, hash),
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
  for (const file of files.values()) nextPrints[file.path] = file.fingerprint;
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
  // With `record: false`, `changed` is not reported either: nothing is uncommitted.
  if (changedList.length > 0) {
    await writeUncommitted(meta, [...(await readUncommitted(meta)), ...changedList]);
  }

  let folded = { events: 0, renames: 0 };
  if (rebuild) {
    // Refold inside the transaction, so no reader sees the scores half rebuilt.
    const f = await rebuildScores(stores.events, stores.scores, foldOptions(config));
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

  // Notes sync recorded as being written from elsewhere (indexing/state.ts).
  const pendingRemote = await readPendingRemote(stores.meta);
  const hasPending = Object.keys(pendingRemote).length > 0;

  let result: PassResult;
  if (rebuild) {
    result = await stores.indexTransaction(() => indexChanges(opts, true, pendingRemote));
  } else {
    const classifier = opts.classifier ?? markdown.createRoleClassifier(config.roles);
    const listing = await listContent(opts.content, classifier);
    const forced = (opts.paths?.length ?? 0) > 0 || hasPending;
    if (forced || !(await upToDate(stores, listing))) {
      result = await stores.indexTransaction(() =>
        indexChanges({ ...opts, classifier }, false, pendingRemote),
      );
    } else {
      result = {
        scanned: listing.files.size,
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

  // The pass has indexed those notes and committed: they are no longer pending.
  if (hasPending) await clearPendingRemote(stores.meta, pendingRemote);

  const fold = await foldPending(stores.events, stores.scores, foldOptions(config));
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
