// `somememos eval`: run the ranking experiments over the brain's own event log
// (PLAN.md section 5, "Evaluation: experiments decide the scoring";
// IMPLEMENTATION.md tasks 1.21 and 1.22).
//
// Privacy (AGENTS.md, first ground rule). Cases come from private notes. The
// default output is aggregate numbers only (recall@k and MRR per setting, and
// case counts): no query, path, title or message. Per-case detail is written
// only to a file inside the brain's `.somememos/eval/` directory, and never
// inside a somememos source checkout.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { evaluation, markdown, ranking } from '@somememos/core';
import {
  CommandError,
  GLOBAL_OPTIONS_HELP,
  brainOptions,
  emit,
  parseCommandArgs,
  withBrain,
} from '../../brain/index.js';
import type { Brain } from '../../brain/index.js';
import { EXIT_OK, UsageError } from '../../context.js';
import { SIDECAR_DIR } from '../../store/index.js';
import { refuseSourceCheckout } from '../privacy.js';
import type { Command } from '../types.js';
import { GitSnapshots, buildGitCases, type GitCase, type Snapshot } from './git-cases.js';
import { PRESETS, configBase, parseGrid, validateSettings } from './settings.js';

/** Where per-case detail goes, inside the brain. */
export const EVAL_DIR = 'eval';

const DEFAULT_SAMPLES = 100;
const DEFAULT_WINDOW = 7 * 86_400;

const presetHelp = Object.entries(PRESETS)
  .map(([name, p]) => `  ${name.padEnd(11)} ${p.description}`)
  .join('\n');

const usage = `Usage: somememos eval [--preset <name>]… [--grid <spec>] [--samples N]
                      [--window <time>] [--seed N] [--cases <file>] [--from-git]
                      [--no-orientation] [--detail]

Replay the brain's own event log to compare ranking settings, and print
recall@k and MRR (mean reciprocal rank) per setting. Experiments, not
intuition, choose the weights and other parameters (PLAN.md section 5).
Nothing is logged and no score changes.

Cases:
- Orientation cases (always, unless --no-orientation): at --samples seeded
  random past moments, fold only the events before it; the right answers
  are the memos, blog posts and dangling links with events in the next
  --window. Tests the activation lists alone.
- --cases <file>: hand-written search cases, a JSON lines file of
  {"query": "...", "time": <unix seconds or ISO date>?, "answers": ["path", …]}
  (paths brain-relative). Run against the current keyword index, at "time"
  (default now).
- --from-git: search cases from the brain's git history. For --samples
  sampled commits, the query is the commit message and the answers are the
  memos and blog posts it modified or renamed; the keyword index, note titles
  and links are rebuilt in memory as of the commit's parent, so later text
  can't leak the answer. Commits that changed more than 20 notes are skipped.

Settings (default: --preset baseline). Each starts from the brain's config:
${presetHelp}
--grid takes 'key=v1,v2;key=v1,v2', every combination a setting, for example
'alpha=0,0.5,1;weights.mention=0.5,1;fold.burst.window=0,600'. Keys: mode,
alpha, weights.<kind>, halfLives.<hot|trendingFast|trendingSlow|
neglectedLong|neglectedShort>, keyword.k1, keyword.b.<field>,
keyword.weights.<field> (fields: title, heading, body), spreading.direction,
spreading.beta, matchMode, combination.<mode>, rerankDepth,
trendingCandidates, neglectedCandidates, fold.burst.window. Presets and a
grid can be combined; setting names must differ.

Options:
  --preset <name>     A named set of settings (repeatable)
  --grid <spec>       Settings from a grid, as above
  --samples <N>       Orientation times, and commits for --from-git (default ${DEFAULT_SAMPLES})
  --window <time>     Orientation look-ahead: seconds, or with a unit, e.g.
                      1d, 12h, 7d (default 7d)
  --seed <N>          Sampling seed; the same seed gives the same cases (default 1)
  --cases <file>      Hand-written search cases (JSON lines)
  --from-git          Search cases from git history
  --no-orientation    Leave out orientation cases
  --detail            Also write per-case results (PRIVATE: queries, paths and
                      rankings) to ${SIDECAR_DIR}/${EVAL_DIR}/ inside the brain; refused
                      inside a somememos source checkout

${GLOBAL_OPTIONS_HELP}

Output: a line of case counts, then one table per kind of case (orientation,
search) with a row per setting: R@1, R@5, R@10, R@20, MRR, cases, skipped.
Aggregates only, safe to share. With --json: {seed, cases: {orientation,
orientationSkipped: {history, answers}, hand, git, gitCommits: {read,
eligible}}, settings, report: {ks, settings: [{name, all, orientation,
search}]}, detailFile}.

Examples:
  somememos eval
  somememos eval --preset baseline --from-git --samples 50
  somememos eval --grid 'alpha=0,0.5,1;weights.mention=0.5,1' --seed 7
  somememos eval --preset half-lives --window 1d --json
  somememos eval --cases .somememos/eval/cases.jsonl --no-orientation
`;

/** Parses `--window`: seconds, or a number with s, m, h, d or w. */
export function parseWindow(value: string | undefined): number {
  if (value === undefined) return DEFAULT_WINDOW;
  const m = /^(\d+(?:\.\d+)?)([smhdw]?)$/.exec(value.trim());
  const unit = { '': 1, s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 } as const;
  const seconds = m ? Number(m[1]) * unit[m[2] as keyof typeof unit] : NaN;
  if (!(seconds > 0)) throw new UsageError(`--window must be a duration like 7d, 12h or 3600`);
  return Math.round(seconds);
}

function parseCount(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new UsageError(`--${name} must be a whole number`);
  return Number(value);
}

/**
 * Reads hand-written cases: JSON lines of `{query, time?, answers}`. Error
 * messages give line numbers only, never the case's text.
 */
export function readHandCases(file: string, now: number): evaluation.EvalCase[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new CommandError(
      `cannot read the cases file: ${(error as NodeJS.ErrnoException).code ?? 'error'}`,
    );
  }
  const cases: evaluation.EvalCase[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    const where = `cases file line ${i + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new CommandError(`${where} is not JSON`);
    }
    const r = value as { query?: unknown; time?: unknown; answers?: unknown };
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new CommandError(`${where} is not a JSON object`);
    }
    if (typeof r.query !== 'string' || r.query.trim() === '') {
      throw new CommandError(`${where}: "query" must be a non-empty string`);
    }
    if (!Array.isArray(r.answers) || !r.answers.every((a) => typeof a === 'string')) {
      throw new CommandError(`${where}: "answers" must be an array of note paths`);
    }
    let time = now;
    if (typeof r.time === 'number' && Number.isSafeInteger(r.time)) time = r.time;
    else if (typeof r.time === 'string' && !Number.isNaN(Date.parse(r.time))) {
      time = Math.floor(Date.parse(r.time) / 1000);
    } else if (r.time !== undefined) {
      throw new CommandError(`${where}: "time" must be Unix seconds or an ISO date`);
    }
    if (time > now) throw new CommandError(`${where}: "time" is in the future`);
    const answers = (r.answers as string[]).map((a) => markdown.normalizePath(a) ?? a);
    cases.push({ id: `hand-${i + 1}`, time, query: r.query, answers });
  });
  return cases;
}

/** Counts that describe the cases; no case content. */
export interface EvalCounts {
  orientation: number;
  orientationSkipped: { history: number; answers: number };
  hand: number;
  git: number;
  gitCommits: { read: number; eligible: number } | null;
}

export interface EvalRecord {
  seed: number;
  cases: EvalCounts;
  settings: string[];
  report: unknown;
  /** The per-case detail file, when --detail was given. */
  detailFile: string | null;
}

function formatEval(record: EvalRecord, report: evaluation.EvalReport): string[] {
  const c = record.cases;
  const lines = [
    `cases: ${c.orientation} orientation (skipped ${c.orientationSkipped.history} for too little history, ${c.orientationSkipped.answers} with no answers), ${c.hand} hand-written, ${c.git} from git${c.gitCommits ? ` (of ${c.gitCommits.eligible} eligible commits)` : ''}; ${record.settings.length} settings; seed ${record.seed}`,
  ];
  const tables: ['orientation' | 'search', number][] = [
    ['orientation', c.orientation],
    ['search', c.hand + c.git],
  ];
  for (const [subset, n] of tables) {
    if (n === 0) continue;
    lines.push('', `${subset} cases`);
    lines.push(evaluation.formatReportText(report, { subset }).trimEnd());
  }
  if (c.orientation + c.hand + c.git === 0) {
    lines.push('no cases to evaluate: the event log is too short for orientation cases');
  }
  return lines;
}

/** Note metadata for activation ranking: the current notes, plus every scored path the log names. */
async function replayNotes(
  brain: Brain,
  log: readonly evaluation.ReplayEntry[],
): Promise<Map<string, ranking.NoteMeta>> {
  const notes = new Map<string, ranking.NoteMeta>();
  for (const n of await brain.stores.notes.listNotes()) {
    notes.set(n.path, { path: n.path, title: n.title, role: n.role });
  }
  // A note renamed or deleted since was still a note at an earlier case time.
  for (const e of log) {
    for (const item of evaluation.isRename(e) ? [e.item, e.to] : [e.item]) {
      if (notes.has(item) || !markdown.isMarkdownPath(item)) continue;
      const role = brain.classifier.classify(item)?.role;
      if (role === undefined || role === 'excluded') continue;
      notes.set(item, { path: item, title: markdown.baseName(item), role });
    }
  }
  return notes;
}

async function currentLinks(brain: Brain): Promise<ranking.LinkGraph> {
  const outgoing = new Map<string, string[]>();
  for (const n of await brain.stores.notes.listNotes()) {
    outgoing.set(
      n.path,
      (await brain.stores.notes.linksFrom(n.path)).map((l) => l.target),
    );
  }
  return ranking.linkGraphFromMaps(outgoing);
}

export const evalCommand: Command = {
  name: 'eval',
  summary: 'Compare ranking settings by replaying the event log (aggregates only)',
  usage,
  async run(args, ctx) {
    const { values, positionals, globals } = parseCommandArgs(args, {
      preset: { type: 'string', multiple: true },
      grid: { type: 'string' },
      samples: { type: 'string' },
      window: { type: 'string' },
      seed: { type: 'string' },
      cases: { type: 'string' },
      'from-git': { type: 'boolean' },
      'no-orientation': { type: 'boolean' },
      detail: { type: 'boolean' },
    });
    if (globals.help) {
      ctx.stdout(usage);
      return EXIT_OK;
    }
    if (positionals.length > 0) throw new UsageError('eval takes no arguments');
    const samples = parseCount('samples', values.samples, DEFAULT_SAMPLES);
    const seed = parseCount('seed', values.seed, 1);
    const window = parseWindow(values.window);
    const presetNames = values.preset ?? [];
    for (const name of presetNames) {
      if (!(name in PRESETS)) {
        throw new UsageError(`unknown preset ${name} (one of: ${Object.keys(PRESETS).join(', ')})`);
      }
    }
    const grid = values.grid === undefined ? null : parseGrid(values.grid);
    const casesFile = values.cases === undefined ? null : resolve(ctx.cwd, values.cases);

    return withBrain(ctx, brainOptions(globals), async (brain) => {
      const base = configBase(brain.config);
      const settings: evaluation.EvalSetting[] = [];
      for (const name of presetNames.length > 0 || grid ? presetNames : ['baseline']) {
        settings.push(...(PRESETS[name] as (typeof PRESETS)[string]).settings(base));
      }
      if (grid) settings.push(...evaluation.expandGrid(grid, base));
      validateSettings(settings);

      const detailDir = join(brain.root, SIDECAR_DIR, EVAL_DIR);
      if (values.detail) refuseSourceCheckout(detailDir, 'per-case evaluation detail');

      const now = brain.now();
      const log = await brain.stores.events.readAfter(0);
      const classifier = brain.classifier;

      // Orientation cases.
      let orientation: evaluation.OrientationResult = {
        cases: [],
        skipped: { history: 0, answers: 0 },
      };
      if (!values['no-orientation']) {
        orientation = evaluation.buildOrientationCases(log, {
          seed,
          samples,
          window,
          isAnswer: (item) =>
            markdown.isMarkdownPath(item)
              ? markdown.isScoredRole(classifier.classify(item)?.role)
              : true,
        });
      }
      const hand = casesFile ? readHandCases(casesFile, now) : [];
      const git = values['from-git']
        ? await buildGitCases({ brainDir: brain.root, classifier, samples, seed })
        : null;
      const cases: evaluation.EvalCase[] = [...orientation.cases, ...hand, ...(git?.cases ?? [])];

      const notes = await replayNotes(brain, log);
      let links: ranking.LinkGraph | null = null;
      const gitById = new Map<string, GitCase>((git?.cases ?? []).map((c) => [c.id, c]));
      const snapshots = git
        ? new GitSnapshots(brain.root, classifier, brain.config.analyzer)
        : null;
      let current: { id: string; snapshot: Snapshot } | null = null;
      const snapshotFor = async (c: evaluation.EvalCase): Promise<Snapshot | null> => {
        const g = gitById.get(c.id);
        if (!g || !snapshots) return null;
        if (current?.id !== c.id) current = { id: c.id, snapshot: await snapshots.at(g.parent) };
        return current.snapshot;
      };

      let report: evaluation.EvalReport;
      try {
        report = await evaluation.runReplay({
          log,
          cases,
          settings,
          detail: values.detail ?? false,
          notesAt: async (c) => (await snapshotFor(c))?.notes ?? notes,
          indexAt: async (c) => (await snapshotFor(c))?.index ?? brain.stores.terms,
          linksAt: async (c) => {
            const s = await snapshotFor(c);
            if (s) return s.links();
            return (links ??= await currentLinks(brain));
          },
        });
      } finally {
        snapshots?.close();
      }

      let detailFile: string | null = null;
      if (values.detail) {
        mkdirSync(detailDir, { recursive: true });
        detailFile = join(detailDir, `eval-${now}.json`);
        writeFileSync(
          detailFile,
          `${JSON.stringify({ at: now, seed, cases, report: evaluation.reportToJson(report, { includeDetail: true }) }, null, 2)}\n`,
          'utf8',
        );
        ctx.stderr(`somememos: per-case detail (private) written to ${detailFile}\n`);
      }

      const record: EvalRecord = {
        seed,
        cases: {
          orientation: orientation.cases.length,
          orientationSkipped: { ...orientation.skipped },
          hand: hand.length,
          git: git?.cases.length ?? 0,
          gitCommits: git ? { ...git.commits } : null,
        },
        settings: settings.map((s) => s.name),
        report: evaluation.reportToJson(report),
        detailFile,
      };
      emit(ctx, globals.json, record, (r) => formatEval(r, report));
      return EXIT_OK;
    });
  },
};
