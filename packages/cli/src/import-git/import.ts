// `import-git`: the one-time import of a brain's git history into its event
// log (PLAN.md section 4, "One-time import from git"; IMPLEMENTATION.md task
// 1.11).
//
// How history is read: one `git log --first-parent --reverse -M --raw -z`
// call, streamed, gives every commit oldest first with its file changes (status,
// modes, old and new blob ids, paths). Blob contents come from one long-running
// `git cat-file --batch`, read only for notes whose links must be compared, and
// each blob is parsed once. That beats parsing `git log -p` patches: added
// patch lines say nothing about code fences, links that only moved, or what a
// link resolved to before, while the two whole versions give exactly what the
// live indexer compares (`markdown.addedLinkItems`).
//
// Merges: only the first-parent chain is walked, and a merge is diffed against
// its first parent. A change made on a side branch is therefore counted once,
// at the merge's time, and the path set stays linear.
//
// Events follow the live index pass (packages/core/src/indexing/pass.ts), dated
// at each commit's author time (at most now):
// - `edit` for a memo (or blog post: every scored note, `markdown.isScoredRole`;
//   "memo" below means either) a commit added or changed (also a renamed one, R<100);
// - `mention` for each link item (memo path or dangling key) that a changed
//   memo or dated note's new version links and its old version did not, both
//   resolved against the note paths as of that commit; links into excluded
//   territory and links to attachments (`![[photo.png]]`) are dropped, by the
//   same rules as the live pass (core's `indexing` link helpers);
// - rename records for a rename between two memos, and from a dangling key
//   (one that has mentions) to the memo created for it;
// - a move between a memo and another role is a delete plus a new note;
// - deletes, and anything in an excluded folder, log nothing.
// Ignored commits log only their rename records. Change records: one per
// commit that touched a note.

import { indexing, markdown, storage } from '@somememos/core';
import { BlobReader, GitError, runGit, streamLog, type LogCommit } from './git.js';
import { importId } from './ids.js';

/** The client recorded on every imported event, rename and change record. */
export const IMPORT_CLIENT = 'import-git';

/**
 * The durable meta key (`Stores.meta`) holding the Unix time, in seconds, at
 * which the brain was first indexed. Live indexing records events from then
 * on, so the import takes only commits before it. The index pass's key
 * (`indexing.META_FIRST_INDEXED`).
 */
export const META_FIRST_INDEXED_AT = indexing.META_FIRST_INDEXED;

/** Notes larger than this are not read: they still get edit events, but no mentions. */
export const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Log entries (or change records) per append. */
export const DEFAULT_IMPORT_BATCH_SIZE = 2000;

/** How many parsed blobs to keep before the cache is cleared. */
const LINK_CACHE_LIMIT = 50_000;

export interface ImportGitOptions {
  /** The brain's directory; it must be inside a git work tree (or be its root). */
  readonly brainDir: string;
  readonly config: storage.BrainConfig;
  /**
   * Where to write, and where the first-index time is read from. Required
   * unless `dryRun`; a dry run with no stores uses "now" as the cutoff.
   */
  readonly stores?: Pick<storage.Stores, 'events' | 'meta'> | null;
  /** Commits (any revision git can resolve) whose events and change records are skipped. */
  readonly ignoreCommits?: readonly string[];
  /**
   * Stop at this point in history: a date (`YYYY-MM-DD`, the whole day in UTC;
   * or an ISO date-time), a Unix time in seconds prefixed with `@`, or a commit.
   */
  readonly until?: string;
  /** Count everything, write nothing. */
  readonly dryRun?: boolean;
  /** "Now" in Unix seconds. Default: the system clock. */
  readonly now?: number;
  readonly batchSize?: number;
  readonly maxFileBytes?: number;
}

export type CutoffSource = 'now' | 'first-indexed' | 'until-date' | 'until-commit';

export interface ImportGitResult {
  readonly dryRun: boolean;
  readonly commits: {
    /** Commits read from the log (first-parent commits that touch the brain). */
    readonly read: number;
    /** Commits that produced events or a change record. */
    readonly imported: number;
    /** Commits skipped by `ignoreCommits` (their renames were kept). */
    readonly ignored: number;
    /** Commits that touched only excluded or non-note files. */
    readonly withoutNotes: number;
    /** Commits at or after the cutoff, which ended the import (0 or 1: reading stops there). */
    readonly afterCutoff: number;
  };
  /** `ignoreCommits` entries that were not on the history walked. */
  readonly ignoreNotFound: number;
  readonly cutoff: {
    /** The newest time imported, Unix seconds (inclusive). */
    readonly time: number;
    readonly source: CutoffSource;
  };
  readonly events: { readonly edit: number; readonly mention: number };
  readonly renames: {
    /** Renames git reported. */
    readonly git: number;
    /** Dangling link keys whose note was created. */
    readonly dangling: number;
  };
  readonly changeRecords: number;
  /** What the stores newly stored; null for a dry run. */
  readonly appended: { readonly log: number; readonly changes: number } | null;
  /** Ids already stored (a repeated import); null for a dry run. */
  readonly duplicates: { readonly log: number; readonly changes: number } | null;
  /** Link resolvers built: one per commit that changed the note paths and had links to resolve. */
  readonly resolverBuilds: number;
  readonly blobs: { readonly read: number; readonly skipped: number };
  readonly elapsedMs: number;
}

/** Bad input to the import (an unknown commit, an unreadable date). */
export class ImportGitError extends Error {
  override name = 'ImportGitError';
}

type Role = markdown.FolderRole;
/** Memos and blog posts are scored items; "memo" below means either. */
const isScored = (role: Role | null): boolean => markdown.isScoredRole(role);
type Links = readonly { readonly target: string }[];

/** One note's change in a commit, after roles are applied. */
type NoteChange =
  | { readonly type: 'add'; readonly path: string; readonly sha: string }
  | { readonly type: 'remove'; readonly path: string }
  | {
      readonly type: 'modify';
      readonly path: string;
      readonly oldSha: string;
      readonly newSha: string;
    }
  | {
      readonly type: 'rename';
      readonly from: string;
      readonly to: string;
      readonly oldSha: string;
      readonly newSha: string;
      /** False for a pure rename (git's R100 with the same blob). */
      readonly changed: boolean;
    };

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** Parses a `--until` date. Returns null when `value` is not a date (it may be a commit). */
export function parseUntilDate(value: string): number | null {
  const m = DATE_ONLY.exec(value);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!markdown.isValidCalendarDate(y, mo, d)) {
      throw new ImportGitError(`not a valid date: ${value}`);
    }
    return Date.UTC(y, mo - 1, d) / 1000 + 86_399;
  }
  if (DATE_TIME.test(value)) {
    const ms = Date.parse(value.replace(' ', 'T'));
    if (Number.isNaN(ms)) throw new ImportGitError(`not a valid date: ${value}`);
    return Math.floor(ms / 1000);
  }
  if (/^@\d+$/.test(value)) return Number(value.slice(1));
  return null;
}

async function resolveCommit(cwd: string, rev: string): Promise<string> {
  if (rev.startsWith('-')) throw new ImportGitError(`not a commit: ${rev}`);
  try {
    return (await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])).trim();
  } catch {
    throw new ImportGitError(`not a commit in this repository: ${rev}`);
  }
}

async function readFirstIndexedAt(
  meta: storage.MetaStore | undefined,
): Promise<number | undefined> {
  const value = await meta?.get(META_FIRST_INDEXED_AT);
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Reads the git history of the repository containing `options.brainDir` and
 * appends its events, rename records and change records to the event log,
 * oldest first. Ids are derived from the commits, so running it again appends
 * nothing. Does not fold: call `storage.foldPending` afterwards.
 */
export async function importGitHistory(options: ImportGitOptions): Promise<ImportGitResult> {
  const started = performance.now();
  const { brainDir, config } = options;
  const dryRun = options.dryRun ?? false;
  const stores = options.stores ?? null;
  if (!dryRun && !stores) throw new TypeError('importGitHistory needs stores unless dryRun');
  const now = options.now ?? storage.unixNow();
  const batchSize = options.batchSize ?? DEFAULT_IMPORT_BATCH_SIZE;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  // Is this a git work tree? (`--show-prefix` fails outside one.)
  try {
    await runGit(brainDir, ['rev-parse', '--show-prefix']);
  } catch (error) {
    throw new ImportGitError(
      `the brain is not inside a git work tree (${(error as Error).message})`,
    );
  }

  // The cutoff: the earliest of now, the first index, and --until.
  let cutoff = now;
  let cutoffSource: CutoffSource = 'now';
  const firstIndexed = await readFirstIndexedAt(stores?.meta);
  if (firstIndexed !== undefined && firstIndexed - 1 < cutoff) {
    cutoff = firstIndexed - 1;
    cutoffSource = 'first-indexed';
  }
  let revision = 'HEAD';
  if (options.until !== undefined) {
    const date = parseUntilDate(options.until);
    if (date === null) {
      revision = await resolveCommit(brainDir, options.until);
      if (cutoffSource === 'now') cutoffSource = 'until-commit';
    } else if (date < cutoff) {
      cutoff = date;
      cutoffSource = 'until-date';
    }
  }
  // A cutoff from "now" only clamps times; any other cutoff ends the import.
  const stopsAtCutoff = cutoffSource === 'first-indexed' || cutoffSource === 'until-date';

  const ignore = new Set<string>();
  for (const rev of options.ignoreCommits ?? []) ignore.add(await resolveCommit(brainDir, rev));
  const ignoreSeen = new Set<string>();

  // Roles, cached by path. Only notes with a role other than `excluded` are
  // ever read, logged or counted.
  const classifier = markdown.createRoleClassifier(config.roles);
  const roles = new Map<string, Role | null>();
  /** The configured role (`excluded` included), or null for a path with none. */
  const configuredRole = (path: string): Role | null => {
    let role = roles.get(path);
    if (role === undefined) {
      role = classifier.classify(path)?.role ?? null;
      roles.set(path, role);
    }
    return role;
  };
  /** The role of a note that may be read: null for excluded and role-less paths. */
  const roleOf = (path: string): Role | null => {
    const role = configuredRole(path);
    return role === 'excluded' ? null : role;
  };
  const isFile = (mode: string): boolean => mode === '100644' || mode === '100755';
  const usable = (path: string, mode: string): boolean => isFile(mode) && roleOf(path) !== null;

  // The note paths as of the commit being read, and a resolver over them,
  // rebuilt only when the set changed and links need resolving.
  const paths = new Set<string>();
  let resolver: markdown.LinkResolver = markdown.createLinkResolver([]);
  let resolverStale = false;
  let resolverBuilds = 0;
  const currentResolver = (): markdown.LinkResolver => {
    if (resolverStale) {
      resolver = markdown.createLinkResolver(paths);
      resolverStale = false;
      resolverBuilds++;
    }
    return resolver;
  };

  // Excluded files' paths, held in memory only (never read or logged), so a
  // link into excluded territory is dropped instead of becoming a dangling
  // key that would name it. The same rule as the live index pass.
  const excludedLinks = new indexing.ExcludedLinks(configuredRole);

  // Dangling keys that have mentions, indexed by their last segment, so a
  // newly created note can find the keys it now resolves.
  const dangling = new Map<string, Set<string>>();
  const lastSegment = (key: string): string => key.slice(key.lastIndexOf('/') + 1);
  const addDangling = (key: string): void => {
    const seg = lastSegment(key);
    let set = dangling.get(seg);
    if (!set) dangling.set(seg, (set = new Set()));
    set.add(key);
  };

  // Parsed links by blob id; null when the blob could not be read.
  const linkCache = new Map<string, Links | null>();
  const blobs = new BlobReader(brainDir, maxFileBytes);
  let blobsRead = 0;
  let blobsSkipped = 0;
  const loadLinks = async (shas: readonly string[]): Promise<void> => {
    const wanted = [...new Set(shas.filter((s) => !linkCache.has(s)))];
    if (wanted.length === 0) return;
    if (linkCache.size + wanted.length > LINK_CACHE_LIMIT) linkCache.clear();
    const results = await blobs.read(wanted);
    wanted.forEach((sha, i) => {
      const r = results[i];
      if (r?.kind === 'text') {
        blobsRead++;
        linkCache.set(
          sha,
          markdown.parseLinks(r.text).map((l) => ({ target: l.target })),
        );
      } else {
        blobsSkipped++;
        linkCache.set(sha, null);
      }
    });
  };

  const entries: { entry: storage.LogInput; order: number }[] = [];
  const changes: storage.ChangeInput[] = [];
  let order = 0;
  const push = (entry: storage.LogInput): void => void entries.push({ entry, order: order++ });

  const counts = { edit: 0, mention: 0, gitRenames: 0, danglingRenames: 0 };
  const commits = { read: 0, imported: 0, ignored: 0, withoutNotes: 0, afterCutoff: 0 };

  const log = streamLog(brainDir, [revision]);
  try {
    for await (const commit of log) {
      commits.read++;
      if (stopsAtCutoff && Math.max(commit.authorTime, commit.committerTime) > cutoff) {
        commits.afterCutoff++;
        log.stop();
        break;
      }
      const ignored = ignore.has(commit.hash);
      if (ignored) {
        ignoreSeen.add(commit.hash);
        commits.ignored++;
      }
      const result = await importCommit(commit, ignored);
      if (!ignored) {
        if (result.touched) commits.imported++;
        else commits.withoutNotes++;
      }
    }
    await log.done();
  } finally {
    log.stop();
    blobs.close();
  }

  async function importCommit(commit: LogCommit, ignored: boolean): Promise<{ touched: boolean }> {
    const time = Math.min(commit.authorTime, now);
    const noteChanges: NoteChange[] = [];
    const touched = new Set<string>();

    // Excluded paths: only their names, to recognize links into them.
    const isExcludedFile = (path: string, mode: string): boolean =>
      isFile(mode) && configuredRole(path) === 'excluded';
    for (const c of commit.changes) {
      if (c.status !== 'A' && c.status !== 'C' && isExcludedFile(c.oldPath, c.oldMode)) {
        excludedLinks.delete(c.oldPath);
      }
    }
    for (const c of commit.changes) {
      if (c.status !== 'D' && isExcludedFile(c.newPath, c.newMode)) {
        excludedLinks.add(c.newPath);
      }
    }

    for (const c of commit.changes) {
      if (c.status === 'U' || c.status === 'X') continue;
      const oldOk = c.status !== 'A' && c.status !== 'C' && usable(c.oldPath, c.oldMode);
      const newOk = c.status !== 'D' && usable(c.newPath, c.newMode);
      if (oldOk) touched.add(c.oldPath);
      if (newOk) touched.add(c.newPath);
      // A move between a memo and another role is a delete plus a new note,
      // as in the live index pass.
      const sameKind =
        oldOk && newOk && isScored(roleOf(c.oldPath)) === isScored(roleOf(c.newPath));
      if (c.status === 'R' && sameKind) {
        noteChanges.push({
          type: 'rename',
          from: c.oldPath,
          to: c.newPath,
          oldSha: c.oldSha,
          newSha: c.newSha,
          changed: c.oldSha !== c.newSha,
        });
      } else if (oldOk && newOk && c.oldPath === c.newPath) {
        noteChanges.push({ type: 'modify', path: c.newPath, oldSha: c.oldSha, newSha: c.newSha });
      } else {
        if (oldOk) noteChanges.push({ type: 'remove', path: c.oldPath });
        if (newOk) noteChanges.push({ type: 'add', path: c.newPath, sha: c.newSha });
      }
    }
    if (noteChanges.length === 0) return { touched: false };

    // The path set after this commit: removals first, then additions.
    const appeared: string[] = [];
    for (const n of noteChanges) {
      if (n.type === 'remove') paths.delete(n.path);
      else if (n.type === 'rename') paths.delete(n.from);
    }
    for (const n of noteChanges) {
      if (n.type === 'add' && !paths.has(n.path)) {
        paths.add(n.path);
        appeared.push(n.path);
      } else if (n.type === 'rename' && !paths.has(n.to)) {
        paths.add(n.to);
        appeared.push(n.to);
      }
    }
    if (noteChanges.some((n) => n.type !== 'modify')) resolverStale = true;

    // Rename records, kept even for ignored commits so history follows the note.
    for (const n of noteChanges) {
      if (n.type !== 'rename' || !isScored(roleOf(n.from))) continue;
      push({
        id: importId([commit.hash, 'rename', n.from, n.to]),
        kind: 'rename',
        item: n.from,
        to: n.to,
        time,
        client: IMPORT_CLIENT,
      });
      counts.gitRenames++;
    }

    // A new memo that a dangling key with mentions now resolves to: the key's
    // history moves to the note, as the live indexer does.
    for (const path of appeared) {
      if (!isScored(roleOf(path))) continue;
      const keys = dangling.get(markdown.normalizeDanglingKey(markdown.baseName(path)));
      if (!keys) continue;
      for (const key of [...keys]) {
        const r = currentResolver().resolve(key, '');
        if (r.kind !== 'resolved' || r.path !== path) continue;
        push({
          id: importId([commit.hash, 'rename', key, path]),
          kind: 'rename',
          item: key,
          to: path,
          time,
          client: IMPORT_CLIENT,
        });
        counts.danglingRenames++;
        keys.delete(key);
      }
    }

    if (ignored) return { touched: touched.size > 0 };

    // Edit events.
    for (const n of noteChanges) {
      let item: string | null = null;
      if (n.type === 'add') item = n.path;
      else if (n.type === 'modify' && n.oldSha !== n.newSha) item = n.path;
      else if (n.type === 'rename' && n.changed) item = n.to;
      if (item === null || !isScored(roleOf(item))) continue;
      push({
        id: importId([commit.hash, 'edit', item]),
        kind: 'edit',
        item,
        time,
        client: IMPORT_CLIENT,
      });
      counts.edit++;
    }

    // Mention events: link items each changed memo or dated note's new version
    // adds. Sources are immutable and, as in the live pass, mention nothing.
    const sources: { path: string; oldSha: string | null; newSha: string }[] = [];
    for (const n of noteChanges) {
      if (roleOf(n.type === 'rename' ? n.to : n.path) === 'source') continue;
      if (n.type === 'add') sources.push({ path: n.path, oldSha: null, newSha: n.sha });
      else if (n.type === 'modify' && n.oldSha !== n.newSha) {
        sources.push({ path: n.path, oldSha: n.oldSha, newSha: n.newSha });
      } else if (n.type === 'rename' && n.changed) {
        sources.push({ path: n.to, oldSha: n.oldSha, newSha: n.newSha });
      }
    }
    if (sources.length > 0) {
      await loadLinks(sources.flatMap((s) => (s.oldSha ? [s.oldSha, s.newSha] : [s.newSha])));
      for (const s of sources) {
        const oldLinks = s.oldSha === null ? [] : linkCache.get(s.oldSha);
        const newLinks = linkCache.get(s.newSha);
        // An unreadable version (too large, binary): no mentions rather than wrong ones.
        if (!oldLinks || !newLinks) continue;
        if (newLinks.length === 0) continue;
        const resolver = currentResolver();
        const visible = (links: Links): Links =>
          links.filter((l) => indexing.countsAsLink(l.target, s.path, resolver, excludedLinks));
        const added = markdown.addedLinkItems(
          visible(oldLinks),
          visible(newLinks),
          s.path,
          resolver,
        );
        for (const item of added) {
          const isPath = paths.has(item);
          if (isPath && !isScored(roleOf(item))) continue;
          if (!isPath) addDangling(item);
          push({
            id: importId([commit.hash, 'mention', item, s.path]),
            kind: 'mention',
            item,
            time,
            client: IMPORT_CLIENT,
          });
          counts.mention++;
        }
      }
    }

    if (touched.size > 0) {
      const message = commit.message === '' ? null : commit.message;
      changes.push({
        id: importId([commit.hash, 'change']),
        time,
        client: IMPORT_CLIENT,
        message,
        op: storage.changeOp(message, config.changeOps),
        paths: [...touched],
      });
    }
    return { touched: touched.size > 0 };
  }

  // Time order; within a time, history order.
  entries.sort((a, b) => a.entry.time - b.entry.time || a.order - b.order);
  changes.sort((a, b) => a.time - b.time);

  let appended: ImportGitResult['appended'] = null;
  let duplicates: ImportGitResult['duplicates'] = null;
  if (!dryRun && stores) {
    const totals = { log: 0, changes: 0, logDup: 0, changesDup: 0 };
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize).map((e) => e.entry);
      const r = await stores.events.append(batch, { now });
      totals.log += r.appended;
      totals.logDup += r.duplicates;
    }
    for (let i = 0; i < changes.length; i += batchSize) {
      const r = await stores.events.appendChanges(changes.slice(i, i + batchSize), { now });
      totals.changes += r.appended;
      totals.changesDup += r.duplicates;
    }
    appended = { log: totals.log, changes: totals.changes };
    duplicates = { log: totals.logDup, changes: totals.changesDup };
  }

  return {
    dryRun,
    commits,
    ignoreNotFound: [...ignore].filter((h) => !ignoreSeen.has(h)).length,
    cutoff: { time: cutoff, source: cutoffSource },
    events: { edit: counts.edit, mention: counts.mention },
    renames: { git: counts.gitRenames, dangling: counts.danglingRenames },
    changeRecords: changes.length,
    appended,
    duplicates,
    resolverBuilds,
    blobs: { read: blobsRead, skipped: blobsSkipped },
    elapsedMs: Math.round(performance.now() - started),
  };
}

export { GitError };
