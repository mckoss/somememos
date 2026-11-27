// Settings grids: expand `{ alpha: [0, 0.5, 1], 'weights.mention': [0.5, 1] }`
// into one named setting per combination.
//
// Keys are dotted paths. `mode` sets the ranking mode; keys starting with
// `fold.` set fold options (`fold.halfLives`, `fold.burst.window`,
// `fold.burst.kinds`); every other key is a path into `RankingParamsInput`
// (`alpha`, `weights.edit`, `halfLives.hot`, `spreading.beta`, `keyword.k1`,
// `keyword.weights.title`, …). The settings come out in odometer order (the
// last key varies fastest), each named `key=value,key=value` in key order.

import type { RankMode, RankingParamsInput } from '../ranking/params.js';
import type { EvalSetting, FoldSettings } from './replay.js';

export type SettingsGrid = Readonly<Record<string, readonly unknown[]>>;

function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let node = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i] as string;
    const next = node[key];
    if (next === undefined) node[key] = {};
    else if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      throw new RangeError(`grid path ${path.join('.')} goes through a non-object`);
    }
    node = node[key] as Record<string, unknown>;
  }
  node[path[path.length - 1] as string] = value;
}

function deepCopy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export interface GridBase {
  /** Prepended to every name, with a space. */
  readonly namePrefix?: string;
  readonly mode?: RankMode;
  readonly ranking?: RankingParamsInput;
  readonly fold?: FoldSettings;
}

/** One setting per combination of the grid's values, over `base`. An empty grid gives one setting. */
export function expandGrid(grid: SettingsGrid, base: GridBase = {}): EvalSetting[] {
  const keys = Object.keys(grid);
  for (const key of keys) {
    const values = grid[key] as readonly unknown[];
    if (!Array.isArray(values) || values.length === 0) {
      throw new RangeError(`grid key ${key} needs at least one value`);
    }
    if (key === '' || key.split('.').some((part) => part === '')) {
      throw new RangeError(`grid key ${JSON.stringify(key)} is not a dotted path`);
    }
  }
  const out: EvalSetting[] = [];
  const counters = keys.map(() => 0);
  for (;;) {
    let mode = base.mode;
    const ranking = (deepCopy(base.ranking) ?? {}) as Record<string, unknown>;
    const fold = (deepCopy(base.fold) ?? {}) as Record<string, unknown>;
    const parts: string[] = [];
    keys.forEach((key, i) => {
      const value = (grid[key] as readonly unknown[])[counters[i] as number];
      parts.push(`${key}=${formatValue(value)}`);
      const path = key.split('.');
      if (key === 'mode') mode = value as RankMode;
      else if (path[0] === 'fold') setPath(fold, path.slice(1), value);
      else setPath(ranking, path, value);
    });
    const label = parts.join(',') || 'base';
    out.push({
      name: base.namePrefix ? `${base.namePrefix} ${label}` : label,
      ...(mode !== undefined ? { mode } : {}),
      ranking: ranking as RankingParamsInput,
      fold: fold as FoldSettings,
    });
    // Odometer step.
    let i = keys.length - 1;
    while (i >= 0) {
      counters[i] = (counters[i] as number) + 1;
      if ((counters[i] as number) < (grid[keys[i] as string] as readonly unknown[]).length) break;
      counters[i] = 0;
      i--;
    }
    if (i < 0) break;
  }
  return out;
}
