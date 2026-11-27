// `somememos hot | trending | neglected`: the activation lists, ranked by
// activity alone (PLAN.md section 5; IMPLEMENTATION.md task 1.14). They show
// scored notes (memos and blog posts) and dangling links, the "what's on my
// mind" view an agent reads at the start of a session. Listing logs nothing.

import type { engine } from '@somememos/core';
import {
  GLOBAL_OPTIONS_HELP,
  brainOptions,
  emit,
  parseCommandArgs,
  withSession,
} from '../brain/index.js';
import type { Session } from '../brain/index.js';
import { EXIT_OK, UsageError } from '../context.js';
import { activityIndicator, oneLineText, parseLimit, resultLabel } from './shared.js';
import type { Command } from './types.js';

type ListMode = 'hot' | 'trending' | 'neglected';

const DESCRIPTIONS: Record<ListMode, { summary: string; ranks: string; indicator: string }> = {
  hot: {
    summary: 'List what is active now (memos, blog posts, links not written yet)',
    ranks: `by recent activity: edits, reads and mentions, each worth less as it
ages (the week half-life by default)`,
    indicator: `week <score>: the activity now, each event counting 1 when it
happened and half as much a week later`,
  },
  trending: {
    summary: 'List what is heating up',
    ranks: `by how fast activity is rising: the week score against the month
score, among the items with the most recent activity`,
    indicator: `pace <ratio>x: 1.0 is an item's usual pace for steady daily
activity; above it, heating up`,
  },
  neglected: {
    summary: 'List what was important and has gone quiet',
    ranks: `by long-term importance without recent activity: the year score
against the month score, among the items with the most activity over a year`,
    indicator: `year <score> month <score>: the long and short scores now`,
  },
};

function usageFor(mode: ListMode): string {
  const d = DESCRIPTIONS[mode];
  return `Usage: somememos ${mode} [--limit N]

List notes ranked ${d.ranks}. Shows scored notes (memos and blog posts) and
dangling links (links to notes that don't exist yet), never dated entries,
sources or excluded folders. Listing logs nothing and never changes a score.
For a keyword search ranked the same way: somememos search <words> --mode ${mode}.

Options:
  -n, --limit <N>  At most N items (default 20)

${GLOBAL_OPTIONS_HELP}

Output: one line per item, first ranked first:
  <path>  <title>  <activity>
  (not written yet) <link text>  <activity>
where <activity> is ${d.indicator}. An empty brain prints nothing. With
--json: {mode, query: null, at, results: [{item, path, dangling, title, role,
date, published, rankKey, components, now}]}.

Examples:
  somememos ${mode}
  somememos ${mode} --limit 5
  somememos ${mode} --json
`;
}

/** One activation list line. */
export function formatListLine(brain: Session, r: engine.ResultView, mode: ListMode): string {
  const parts = [resultLabel(brain, r)];
  if (!r.dangling && r.title !== '') parts.push(oneLineText(r.title, 60));
  parts.push(activityIndicator(r, mode));
  return parts.join('  ');
}

function listCommand(mode: ListMode): Command {
  const usage = usageFor(mode);
  return {
    name: mode,
    summary: DESCRIPTIONS[mode].summary,
    usage,
    async run(args, ctx) {
      const { values, positionals, globals } = parseCommandArgs(
        args,
        { limit: { type: 'string', short: 'n' } },
        { allowPositionals: true },
      );
      if (globals.help) {
        ctx.stdout(usage);
        return EXIT_OK;
      }
      if (positionals.length > 0) {
        throw new UsageError(
          `${mode} takes no words; to search, run: somememos search ${positionals.join(' ')} --mode ${mode}`,
        );
      }
      const limit = parseLimit(values.limit);
      return withSession(ctx, brainOptions(globals), async (brain) => {
        const response = await brain.engine.list(mode, limit === undefined ? {} : { limit });
        emit(ctx, globals.json, response, (r) =>
          r.results.map((x) => formatListLine(brain, x, mode)),
        );
        return EXIT_OK;
      });
    },
  };
}

export const hotCommand = listCommand('hot');
export const trendingCommand = listCommand('trending');
export const neglectedCommand = listCommand('neglected');
