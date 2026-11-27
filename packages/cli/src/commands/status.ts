// `somememos status`: what the brain holds, what is uncommitted, and the config in effect.

import type { storage } from '@somememos/core';
import {
  GLOBAL_OPTIONS_HELP,
  brainOptions,
  emit,
  parseCommandArgs,
  plural,
  withBrain,
} from '../brain/index.js';
import { EXIT_OK } from '../context.js';
import type { IndexSummary } from '../indexer/index.js';
import type { Command } from './types.js';

const usage = `Usage: somememos status

Show the brain's state: notes by role, sections, events by kind, change
records, dangling links, notes changed but not yet committed, how far the
event log is folded into scores, and the config in effect (weights,
half-lives, roles). Runs the index pass first, so the counts are current.

${GLOBAL_OPTIONS_HELP}

Output: a few labelled lines. With --json: {root, clientId, notes: {total,
memo, dated, source, blog}, sections, dangling, events: {read, edit, mention,
rename}, changes, uncommitted, fold: {cursor, lastSeq}, firstIndexedAt,
config: {weights, alpha, halfLives, roles, analyzer, changeOps}, index}.

Examples:
  somememos status
  somememos status --json
`;

export interface StatusRecord {
  root: string;
  clientId: string;
  notes: { total: number } & Record<storage.NoteRole, number>;
  sections: number;
  dangling: number;
  events: Record<storage.LogKind, number>;
  changes: number;
  uncommitted: string[];
  fold: { cursor: number; lastSeq: number };
  firstIndexedAt: number | null;
  config: {
    weights: storage.BrainConfig['weights'];
    alpha: number;
    halfLives: storage.HalfLives;
    roles: storage.BrainConfig['roles'];
    analyzer: storage.BrainConfig['analyzer'];
    changeOps: readonly string[];
  };
  index: IndexSummary | null;
}

function duration(seconds: number): string {
  const days = seconds / 86_400;
  if (Number.isInteger(days)) return `${days}d`;
  if (days >= 1) return `${days.toFixed(1)}d`;
  return `${seconds}s`;
}

function formatStatus(r: StatusRecord): string[] {
  const roles = Object.entries(r.config.roles);
  const lines = [
    `brain: ${r.root}`,
    `notes: ${r.notes.total} (memo ${r.notes.memo}, dated ${r.notes.dated}, source ${r.notes.source}, blog ${r.notes.blog}); ${plural(r.sections, 'section')}; ${plural(r.dangling, 'dangling link target')}`,
    `events: ${r.events.edit} edit, ${r.events.mention} mention, ${r.events.read} read, ${r.events.rename} rename; ${plural(r.changes, 'change record')}`,
    `folded: through ${r.fold.cursor} of ${r.fold.lastSeq}`,
  ];
  if (r.uncommitted.length === 0) lines.push('uncommitted: none');
  else {
    lines.push(
      `uncommitted: ${plural(r.uncommitted.length, 'changed note')} (somememos commit -m "<why>")`,
    );
    for (const p of r.uncommitted) lines.push(`  ${p}`);
  }
  const weights = Object.entries(r.config.weights)
    .map(([k, w]) => `${k} ${w}`)
    .join(', ');
  const halfLives = Object.entries(r.config.halfLives)
    .map(([k, s]) => `${k} ${duration(s)}`)
    .join(', ');
  lines.push(`weights: ${weights}; alpha ${r.config.alpha}`);
  lines.push(`half-lives: ${halfLives}`);
  lines.push(
    roles.length === 0
      ? 'roles: none declared (every note is a memo)'
      : `roles: ${roles.map(([role, patterns]) => `${role} ${(patterns ?? []).join(' ')}`).join('; ')}`,
  );
  return lines;
}

export const statusCommand: Command = {
  name: 'status',
  summary: 'Show counts, uncommitted changes and the config in effect',
  usage,
  async run(args, ctx) {
    const { globals } = parseCommandArgs(args, {});
    if (globals.help) {
      ctx.stdout(usage);
      return EXIT_OK;
    }
    return withBrain(ctx, brainOptions(globals, { remind: false }), async (brain) => {
      const status = await brain.engine.status();
      const record: StatusRecord = {
        root: brain.root,
        ...status,
        notes: { ...status.notes },
        events: { ...status.events },
        fold: { ...status.fold },
        config: { ...status.config },
        index: brain.index,
      };
      emit(ctx, globals.json, record, formatStatus);
      return EXIT_OK;
    });
  },
};
