// The parameter settings `somememos eval` compares: named presets (the
// experiments of IMPLEMENTATION.md task 1.23) and `--grid` strings, both
// expanded with `evaluation.expandGrid` over the brain's own config.

import { evaluation, ranking, type storage, timescore } from '@somememos/core';
import { UsageError } from '../../context.js';

export interface Preset {
  readonly description: string;
  /** The settings, over `base` (the brain's config). */
  settings(base: evaluation.GridBase): evaluation.EvalSetting[];
}

/**
 * The presets, one per experiment. Values are the candidates to compare, not
 * choices: the measured winner becomes the default (PLAN.md section 5).
 * Weights are relative: scaling every weight by the same factor changes no
 * ranking, so the weights preset varies `mention` against `edit` = 1.
 */
export const PRESETS: Readonly<Record<string, Preset>> = {
  baseline: {
    description: 'keyword only (mode all) vs keyword plus activation (mode hot)',
    settings: (base) => evaluation.expandGrid({ mode: ['all', 'hot'] }, base),
  },
  weights: {
    description: 'the mention weight (edit = 1) and alpha, in hot mode',
    settings: (base) =>
      evaluation.expandGrid({ 'weights.mention': [0, 0.5, 1, 2], alpha: [0.5, 1, 2] }, base),
  },
  'half-lives': {
    description: 'which half-life drives hot: day, week, month or year',
    settings: (base) =>
      evaluation.expandGrid({ 'halfLives.hot': ['day', 'week', 'month', 'year'] }, base),
  },
  bursts: {
    description: 'counting a burst of edits once: no rule, 10 minutes, 1 hour, 1 day',
    settings: (base) =>
      evaluation.expandGrid({ 'fold.burst.window': [0, 600, 3600, 86_400] }, base),
  },
  keyword: {
    description: 'BM25F k1, the title weight and body length normalization b, keyword only',
    settings: (base) =>
      evaluation.expandGrid(
        {
          'keyword.k1': [0.9, 1.2, 1.5],
          'keyword.weights.title': [1, 3, 5],
          'keyword.b.body': [0.5, 0.75],
        },
        { ...base, mode: 'all' },
      ),
  },
  spreading: {
    description: 'link spreading: off, or outgoing, backlinks or both at three strengths',
    settings: (base) => [
      ...evaluation.expandGrid({ 'spreading.direction': ['off'] }, base),
      ...evaluation.expandGrid(
        {
          'spreading.direction': ['outgoing', 'backlinks', 'both'],
          'spreading.beta': [0.25, 0.5, 1],
        },
        base,
      ),
    ],
  },
};

/** The settings base from a brain's config: its weights, alpha, keyword parameters and half-lives. */
export function configBase(config: storage.BrainConfig): evaluation.GridBase {
  return {
    mode: 'hot',
    ranking: { weights: { ...config.weights }, alpha: config.alpha, keyword: config.keyword },
    fold: { halfLives: { ...config.halfLives } },
  };
}

const RANKING_KEYS = new Set([
  'weights',
  'alpha',
  'halfLives',
  'keyword',
  'matchMode',
  'combination',
  'rerankDepth',
  'floor',
  'spreading',
  'trendingCandidates',
  'neglectedCandidates',
  'neglectedMinLongScore',
]);

function parseValue(raw: string): unknown {
  const v = raw.trim();
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(v)) return Number(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

/**
 * Parses `alpha=0,0.5,1;weights.mention=0.5,1;fold.burst.window=0,600` into a
 * settings grid. Values are numbers, true/false, or words. Keys are checked
 * against the parameters a setting can change, so a typo is an error rather
 * than a setting that changes nothing.
 */
export function parseGrid(text: string): evaluation.SettingsGrid {
  const grid: Record<string, unknown[]> = {};
  for (const part of text.split(';')) {
    if (part.trim() === '') continue;
    const eq = part.indexOf('=');
    if (eq <= 0)
      throw new UsageError(`--grid: expected key=value,value in ${JSON.stringify(part)}`);
    const key = part.slice(0, eq).trim();
    const values = part
      .slice(eq + 1)
      .split(',')
      .filter((v) => v.trim() !== '')
      .map(parseValue);
    if (values.length === 0) throw new UsageError(`--grid: ${key} has no values`);
    const [head, second] = key.split('.');
    const known =
      key === 'mode' ||
      (head === 'fold' && (second === 'halfLives' || second === 'burst')) ||
      (head === 'weights' &&
        key.split('.').length === 2 &&
        (timescore.EVENT_KINDS as readonly string[]).includes(second ?? '')) ||
      (head !== 'weights' && head !== undefined && RANKING_KEYS.has(head));
    if (!known) {
      throw new UsageError(
        `--grid: unknown parameter ${key} (use mode, alpha, weights.<read|edit|mention>, halfLives.<hot|trendingFast|…>, keyword.k1, keyword.b.<field>, keyword.weights.<field>, spreading.direction, spreading.beta, fold.burst.window, …)`,
      );
    }
    if (key in grid) throw new UsageError(`--grid: ${key} is given twice`);
    grid[key] = values;
  }
  if (Object.keys(grid).length === 0) throw new UsageError('--grid is empty');
  return grid;
}

/** Checks every setting's parameters up front, so a bad value is a usage error. */
export function validateSettings(settings: readonly evaluation.EvalSetting[]): void {
  const names = new Set<string>();
  for (const s of settings) {
    if (names.has(s.name)) throw new UsageError(`two settings are both named ${s.name}`);
    names.add(s.name);
    if (s.mode !== undefined && !ranking.isRankMode(s.mode)) {
      throw new UsageError(`setting ${s.name}: mode must be hot, trending, neglected or all`);
    }
    try {
      ranking.resolveRankingParams({
        ...(s.fold?.halfLives ? { halfLifeSeconds: s.fold.halfLives } : {}),
        ...s.ranking,
      });
      const hl = s.fold?.halfLives ?? timescore.HALF_LIVES;
      const named = ranking.resolveRankingParams(s.ranking).halfLives;
      for (const name of Object.values(named)) {
        if (!(name in hl)) throw new RangeError(`no half-life named ${name}`);
      }
      const burst = s.fold?.burst;
      if (burst !== undefined && (!Number.isFinite(burst.window) || burst.window < 0)) {
        throw new RangeError('fold.burst.window must be a number >= 0');
      }
    } catch (error) {
      throw new UsageError(`setting ${s.name}: ${(error as Error).message}`);
    }
  }
}
