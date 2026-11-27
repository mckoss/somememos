// Search cases from a brain's git history (PLAN.md section 5, "Evaluation";
// IMPLEMENTATION.md task 1.21): for a sampled commit, the query is its
// message and the answers are the scored notes (memos and blog posts) it
// changed that already existed. Each case is run against a keyword index
// built as of the commit's parent, in memory, from the parent's tree (`git
// ls-tree` plus `git cat-file --batch`, the same plumbing as `import-git`),
// with note metadata and links as of that commit too, so text the commit (or
// anything later) added can't leak the answer. No checkout, nothing written.
//
// Everything here is private when the brain is real: cases name notes and
// carry commit messages. Only aggregates leave the brain.

import { evaluation, indexing, keyword, markdown, ranking, storage } from '@somememos/core';
import { BlobReader, listTree, streamLog, type LogCommit } from '../../import-git/git.js';

/** Commits that change more scored notes than this are skipped (mass rewrites). */
export const DEFAULT_MAX_ANSWERS = 20;

/** Notes larger than this are left out of the as-of-parent index. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Parsed texts kept across snapshots, by blob id. */
const TEXT_CACHE_LIMIT = 50_000;

/** A search case from history, with the commit whose parent it is evaluated against. */
export interface GitCase extends evaluation.EvalCase {
  readonly commit: string;
  readonly parent: string;
}

export interface GitCasesOptions {
  readonly brainDir: string;
  readonly classifier: markdown.RoleClassifier;
  /** How many commits to sample (without replacement). */
  readonly samples: number;
  readonly seed: number;
  /** Skip commits that changed more scored notes than this. Default `DEFAULT_MAX_ANSWERS`. */
  readonly maxAnswers?: number;
  /** Only commits with an author time strictly before this (Unix seconds). */
  readonly before?: number;
}

export interface GitCasesResult {
  readonly cases: GitCase[];
  /** Commits read; commits that qualified before sampling. */
  readonly commits: { readonly read: number; readonly eligible: number };
}

const isFileMode = (mode: string): boolean => mode === '100644' || mode === '100755';

/**
 * Reads the first-parent history once and samples commits that qualify: a
 * message, a parent, and between 1 and `maxAnswers` scored notes that the
 * commit modified or renamed (notes it only added or deleted are not
 * answers). Answers are named as they were in the parent, which is how the
 * event log names them at the commit's time. Deterministic for a seed.
 */
export async function buildGitCases(options: GitCasesOptions): Promise<GitCasesResult> {
  const { classifier } = options;
  const maxAnswers = options.maxAnswers ?? DEFAULT_MAX_ANSWERS;
  const scored = (path: string): boolean => markdown.isScoredRole(classifier.classify(path)?.role);
  const eligible: GitCase[] = [];
  let read = 0;
  const log = streamLog(options.brainDir, ['HEAD']);
  try {
    for await (const commit of log) {
      read++;
      const c = caseOf(commit, scored, maxAnswers);
      if (c && (options.before === undefined || c.time < options.before)) eligible.push(c);
    }
    await log.done();
  } finally {
    log.stop();
  }
  // Seeded sample without replacement (a partial Fisher-Yates shuffle).
  const random = evaluation.seededRandom(options.seed);
  const pool = [...eligible];
  const n = Math.min(Math.max(0, options.samples), pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j] as GitCase, pool[i] as GitCase];
  }
  const cases = pool.slice(0, n).sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1));
  return { cases, commits: { read, eligible: eligible.length } };
}

function caseOf(
  commit: LogCommit,
  scored: (path: string) => boolean,
  maxAnswers: number,
): GitCase | null {
  const parent = commit.parents[0];
  const query = commit.message.trim();
  if (parent === undefined || query === '') return null;
  const answers = new Set<string>();
  for (const c of commit.changes) {
    if (!isFileMode(c.oldMode)) continue;
    const modified = c.status === 'M' && c.oldSha !== c.newSha;
    const renamed = c.status === 'R';
    if ((modified || renamed) && scored(c.oldPath)) answers.add(c.oldPath);
  }
  if (answers.size === 0 || answers.size > maxAnswers) return null;
  return {
    id: `git-${commit.hash.slice(0, 12)}`,
    commit: commit.hash,
    parent,
    time: commit.authorTime,
    query,
    answers: [...answers].sort(),
  };
}

/** What a case is evaluated against: the brain as of one commit. */
export interface Snapshot {
  readonly index: keyword.MemoryKeywordIndex;
  readonly notes: ReadonlyMap<string, ranking.NoteMeta>;
  /** The link graph, built on first use (only settings that spread need it). */
  links(): ranking.LinkGraph;
}

/**
 * Builds snapshots of the brain as of a commit, sharing one `git cat-file
 * --batch` and a cache of blob texts. Close it when done.
 */
export class GitSnapshots {
  private readonly blobs: BlobReader;
  private readonly texts = new Map<string, string | null>();

  constructor(
    private readonly brainDir: string,
    private readonly classifier: markdown.RoleClassifier,
    private readonly analyzer: keyword.AnalyzerOptions,
  ) {
    this.blobs = new BlobReader(brainDir, MAX_FILE_BYTES);
  }

  /** The brain's notes, keyword index and links as of `commit`. */
  async at(commit: string): Promise<Snapshot> {
    const files: { path: string; sha: string; role: storage.NoteRole }[] = [];
    const excluded: string[] = [];
    for (const e of await listTree(this.brainDir, commit)) {
      if (!isFileMode(e.mode) || !markdown.isMarkdownPath(e.path)) continue;
      const role = this.classifier.classify(e.path)?.role;
      if (role === undefined) continue;
      if (role === 'excluded')
        excluded.push(e.path); // the name only: never read
      else files.push({ path: e.path, sha: e.sha, role });
    }
    const wanted = [...new Set(files.map((f) => f.sha).filter((s) => !this.texts.has(s)))];
    if (this.texts.size + wanted.length > TEXT_CACHE_LIMIT) this.texts.clear();
    const results = await this.blobs.read(wanted);
    wanted.forEach((sha, i) => {
      const r = results[i];
      this.texts.set(sha, r?.kind === 'text' ? r.text : null);
    });

    const index = new keyword.MemoryKeywordIndex({ analyzer: this.analyzer });
    const notes = new Map<string, ranking.NoteMeta>();
    const targets = new Map<string, string[]>();
    for (const f of files) {
      const text = this.texts.get(f.sha);
      if (text === null || text === undefined) continue;
      const parsed = markdown.parseNote(f.path, text);
      notes.set(f.path, { path: f.path, title: parsed.title, role: f.role });
      parsed.sections.forEach((s, i) => {
        index.add(storage.sectionId(f.path, i), {
          title: parsed.title,
          heading: s.heading ?? '',
          body: s.body,
        });
      });
      targets.set(f.path, [...new Set(parsed.links.map((l) => l.target))]);
    }

    const classifier = this.classifier;
    let graph: ranking.LinkGraph | null = null;
    return {
      index,
      notes,
      links() {
        if (graph) return graph;
        const resolver = markdown.createLinkResolver(notes.keys());
        const excludedLinks = new indexing.ExcludedLinks(
          (path) => classifier.classify(path)?.role,
          excluded,
        );
        const outgoing = new Map<string, string[]>();
        for (const [source, list] of targets) {
          outgoing.set(
            source,
            indexing.linkItemsOf(list, source, resolver, excludedLinks).map((l) => l.target),
          );
        }
        graph = ranking.linkGraphFromMaps(outgoing);
        return graph;
      },
    };
  }

  close(): void {
    this.blobs.close();
  }
}
