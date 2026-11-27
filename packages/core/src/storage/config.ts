// A brain's config (`<brain>/.somememos/config.json`; IMPLEMENTATION.md task
// 1.1): the pure types and validation. Reading and writing the file is the
// client's job (packages/cli/src/store/config.ts).
//
// Every key is optional except `clientId`; missing keys take the defaults
// below. Unknown keys are errors, so a typo never silently does nothing.
//
// The defaults are not restated here: they come from where each one lives
// (`ranking.DEFAULT_RANKING_PARAMS` for `alpha`, `keyword.DEFAULT_BM25F_PARAMS`
// for the keyword parameters, `storage.DEFAULT_BURST_WINDOW`), so they can't
// drift apart. `alpha` 0.5, the one-hour burst window, title weight 5 and
// body `b` 0.5 were measured with `somememos eval` on 2026-11-27 (PLAN.md
// section 5, "First experiment results"); so were the mention weight 1 and
// `hot` on the week half-life. The read weight (1) is an unmeasured
// placeholder: imported history has no reads.

import {
  type AnalyzerOptions,
  DEFAULT_ANALYZER_OPTIONS,
  resolveAnalyzerOptions,
} from '../keyword/analyze.js';
import { type Bm25fParamsOverride, resolveBm25fParams } from '../keyword/bm25f.js';
import { FIELDS } from '../keyword/document.js';
import {
  DEFAULT_FOLDER_ROLES,
  ROLE_PRECEDENCE,
  createRoleClassifier,
  type FolderRole,
  type FolderRolesConfig,
} from '../markdown/roles.js';
import { DEFAULT_RANKING_PARAMS } from '../ranking/params.js';
import { HALF_LIVES } from '../timescore/halfLives.js';
import { EVENT_KINDS } from '../timescore/kinds.js';
import { UNIT_WEIGHTS, type Weights } from '../timescore/weights.js';
import type { HalfLives } from './types.js';
import { DEFAULT_BURST_WINDOW, assertValidBurstWindow } from './burst.js';
import { DEFAULT_CHANGE_OPS, assertValidHalfLives } from './validate.js';

/** The config format version this code reads and writes. */
export const CONFIG_VERSION = 1;

/** A brain's config with every default filled in. */
export interface BrainConfig {
  /** Always `CONFIG_VERSION`. */
  readonly version: number;
  /** This client's id, recorded on every event and change record it writes. */
  readonly clientId: string;
  /**
   * Folder roles as path patterns (`markdown.compilePathPattern`). Default `{}`:
   * every markdown file is a memo. `init` writes `markdown.DEFAULT_FOLDER_ROLES`.
   */
  readonly roles: FolderRolesConfig;
  /** Half-lives in seconds, by name. Default `timescore.HALF_LIVES`. Given, it replaces the table. */
  readonly halfLives: HalfLives;
  /**
   * The burst rule's window in seconds (`storage.DEFAULT_BURST_WINDOW`, one
   * hour, measured 2026-11-27): of one note's events of one kind, an event
   * counts only if it is at least this long after the last counted one. 0
   * turns the rule off. Applied when the log is folded; changing it rebuilds
   * the scores from the log. Pass `foldOptions(config)` to the fold.
   */
  readonly burstWindow: number;
  /**
   * Per-kind weights, applied at read time. Default 1 each; given kinds
   * override. Mention 1 was measured on 2026-11-27; read 1 is an unmeasured
   * placeholder.
   */
  readonly weights: Weights;
  /**
   * The weight of activation in the combined rank key `ln r + α · L`.
   * Default `ranking.DEFAULT_RANKING_PARAMS.alpha` (0.5, measured 2026-11-27).
   */
  readonly alpha: number;
  /** BM25F overrides (`keyword.resolveBm25fParams`). Default `{}`. */
  readonly keyword: Bm25fParamsOverride;
  /** How text becomes index terms. Default `keyword.DEFAULT_ANALYZER_OPTIONS`. */
  readonly analyzer: AnalyzerOptions;
  /** Commit-message first words recognized as change ops. Default ingest, update, session, query, lint. */
  readonly changeOps: readonly string[];
}

/** The config is invalid. `problems` lists every problem found, one per line of the message. */
export class ConfigError extends Error {
  override name = 'ConfigError';
  readonly problems: readonly string[];
  constructor(problems: readonly string[], source = 'config') {
    super(`${source} is invalid:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.problems = problems;
  }
}

const TOP_KEYS = [
  '$schema',
  'version',
  'clientId',
  'roles',
  'halfLives',
  'burstWindow',
  'weights',
  'alpha',
  'keyword',
  'analyzer',
  'changeOps',
] as const;

const CLIENT_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const OP_NAME = /^[a-z][a-z0-9_-]*$/;

/**
 * The config `init` writes for a new brain: the default folder layout
 * (`memos/`, `diary/`, `sources/`, `blog/`) and every other default. A brain
 * whose config has no `blog` key simply has no blog role.
 */
export function defaultBrainConfig(clientId: string): BrainConfig {
  return parseBrainConfig({ clientId, roles: DEFAULT_FOLDER_ROLES });
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validates a parsed `config.json` and fills in defaults. Throws `ConfigError`
 * listing every problem. `source` names the file in the message.
 */
export function parseBrainConfig(value: unknown, source = 'config'): BrainConfig {
  const problems: string[] = [];
  if (!isObject(value)) throw new ConfigError(['the config must be a JSON object'], source);

  const unknownKeys = (obj: Json, allowed: readonly string[], where: string): void => {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) {
        problems.push(`${where}: unknown key "${key}" (expected one of: ${allowed.join(', ')})`);
      }
    }
  };
  unknownKeys(value, TOP_KEYS, 'config');

  // version
  if (value.version !== undefined && value.version !== CONFIG_VERSION) {
    problems.push(`version: must be ${CONFIG_VERSION}, not ${JSON.stringify(value.version)}`);
  }

  // clientId
  const clientId = value.clientId;
  if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) {
    problems.push(
      `clientId: required, 1-100 letters, digits, '.', '_', ':' or '-' (got ${JSON.stringify(clientId)})`,
    );
  }

  // roles
  let roles: FolderRolesConfig = {};
  if (value.roles !== undefined) {
    if (!isObject(value.roles)) problems.push('roles: must be an object of role → patterns');
    else {
      unknownKeys(value.roles, ROLE_PRECEDENCE, 'roles');
      const out: Partial<Record<FolderRole, string[]>> = {};
      for (const role of ROLE_PRECEDENCE) {
        const patterns = value.roles[role];
        if (patterns === undefined) continue;
        if (!Array.isArray(patterns) || !patterns.every((p) => typeof p === 'string')) {
          problems.push(`roles.${role}: must be an array of path patterns (strings)`);
          continue;
        }
        out[role] = [...(patterns as string[])];
      }
      roles = out;
      try {
        createRoleClassifier(roles);
      } catch (error) {
        problems.push(`roles: ${(error as Error).message}`);
      }
    }
  }

  // halfLives
  let halfLives: HalfLives = { ...HALF_LIVES };
  if (value.halfLives !== undefined) {
    if (!isObject(value.halfLives)) problems.push('halfLives: must be an object of name → seconds');
    else {
      try {
        assertValidHalfLives(value.halfLives as HalfLives);
        halfLives = { ...(value.halfLives as Record<string, number>) };
      } catch (error) {
        problems.push(`halfLives: ${(error as Error).message}`);
      }
    }
  }

  // burstWindow
  let burstWindow = DEFAULT_BURST_WINDOW;
  if (value.burstWindow !== undefined) {
    try {
      assertValidBurstWindow(value.burstWindow as number);
      burstWindow = value.burstWindow as number;
    } catch {
      problems.push('burstWindow: must be a number of seconds >= 0 (0 turns the rule off)');
    }
  }

  // weights
  const weights: Record<string, number> = { ...UNIT_WEIGHTS };
  if (value.weights !== undefined) {
    if (!isObject(value.weights))
      problems.push('weights: must be an object of event kind → weight');
    else {
      unknownKeys(value.weights, EVENT_KINDS, 'weights');
      for (const kind of EVENT_KINDS) {
        const w = value.weights[kind];
        if (w === undefined) continue;
        if (!isFiniteNumber(w) || w < 0) problems.push(`weights.${kind}: must be a number >= 0`);
        else weights[kind] = w;
      }
    }
  }

  // alpha
  let alpha = DEFAULT_RANKING_PARAMS.alpha;
  if (value.alpha !== undefined) {
    if (!isFiniteNumber(value.alpha) || value.alpha < 0)
      problems.push('alpha: must be a number >= 0');
    else alpha = value.alpha;
  }

  // keyword
  let keyword: Bm25fParamsOverride = {};
  if (value.keyword !== undefined) {
    const k = value.keyword;
    if (!isObject(k)) problems.push('keyword: must be an object with k1, b and weights');
    else {
      const before = problems.length;
      unknownKeys(k, ['k1', 'b', 'weights'], 'keyword');
      if (k.k1 !== undefined && !isFiniteNumber(k.k1))
        problems.push('keyword.k1: must be a number');
      for (const group of ['b', 'weights'] as const) {
        const g = k[group];
        if (g === undefined) continue;
        if (!isObject(g)) problems.push(`keyword.${group}: must be an object of field → number`);
        else {
          unknownKeys(g, FIELDS, `keyword.${group}`);
          for (const f of FIELDS) {
            if (g[f] !== undefined && !isFiniteNumber(g[f])) {
              problems.push(`keyword.${group}.${f}: must be a number`);
            }
          }
        }
      }
      if (problems.length === before) {
        try {
          resolveBm25fParams(k as Bm25fParamsOverride);
          keyword = JSON.parse(JSON.stringify(k)) as Bm25fParamsOverride;
        } catch (error) {
          problems.push(`keyword: ${(error as Error).message}`);
        }
      }
    }
  }

  // analyzer
  let analyzer: AnalyzerOptions = { ...DEFAULT_ANALYZER_OPTIONS };
  if (value.analyzer !== undefined) {
    if (!isObject(value.analyzer)) problems.push('analyzer: must be an object like {"stem": true}');
    else {
      unknownKeys(value.analyzer, ['stem'], 'analyzer');
      const stem = value.analyzer.stem;
      if (stem !== undefined && typeof stem !== 'boolean') {
        problems.push('analyzer.stem: must be true or false');
      } else analyzer = resolveAnalyzerOptions({ ...(stem === undefined ? {} : { stem }) });
    }
  }

  // changeOps
  let changeOps: string[] = [...DEFAULT_CHANGE_OPS];
  if (value.changeOps !== undefined) {
    const ops = value.changeOps;
    if (!Array.isArray(ops) || !ops.every((op) => typeof op === 'string' && OP_NAME.test(op))) {
      problems.push('changeOps: must be an array of lower-case words');
    } else changeOps = [...new Set(ops as string[])];
  }

  if (problems.length > 0) throw new ConfigError(problems, source);
  return {
    version: CONFIG_VERSION,
    clientId: clientId as string,
    roles,
    halfLives,
    burstWindow,
    weights: weights as unknown as Weights,
    alpha,
    keyword,
    analyzer,
    changeOps,
  };
}

/** The JSON text of a config, as `init` writes it (two-space indent, trailing newline). */
export function serializeBrainConfig(config: BrainConfig): string {
  const out = {
    version: config.version,
    clientId: config.clientId,
    roles: config.roles,
    halfLives: config.halfLives,
    burstWindow: config.burstWindow,
    weights: config.weights,
    alpha: config.alpha,
    keyword: config.keyword,
    analyzer: config.analyzer,
    changeOps: config.changeOps,
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * The fold options a brain's config sets: its half-lives and burst window.
 * Every fold of the brain (`foldPending`, `rebuildScores`) should pass these,
 * so the scores are always folded one way.
 */
export function foldOptions(config: Pick<BrainConfig, 'halfLives' | 'burstWindow'>): {
  readonly halfLives: HalfLives;
  readonly burstWindow: number;
} {
  return { halfLives: config.halfLives, burstWindow: config.burstWindow };
}
