// `somememos search <words…>`: keyword search ranked by relevance and
// activation (PLAN.md section 5; IMPLEMENTATION.md task 1.13). Searching
// logs nothing: search results are not events.

import { type engine, ranking } from '@somememos/core';
import {
  GLOBAL_OPTIONS_HELP,
  brainOptions,
  emit,
  parseCommandArgs,
  withSession,
} from '../brain/index.js';
import type { Session } from '../brain/index.js';
import { EXIT_OK, UsageError } from '../context.js';
import { oneLineText, parseDateOption, parseLimit, resultLabel } from './shared.js';
import type { Command } from './types.js';

const usage = `Usage: somememos search <words…> [--mode hot|trending|neglected|all] [--limit N]
                        [--since YYYY-MM-DD] [--until YYYY-MM-DD]

Keyword search over every indexed note (memos, dated entries, sources and blog
posts; never excluded folders). Each note appears once, with its best-matching
section. Results are ranked by the mode:

  hot        relevance combined with recent activity (default)
  trending   relevance combined with activity that is heating up
  neglected  relevance combined with notes that were important and went quiet
  all        keyword relevance only

Words match any of them (more matches rank higher); "quoted words" match as a
phrase. Searching logs nothing and never changes a score. With no words it is
the activation list for the mode (see 'somememos hot').

Options:
  --mode <mode>          hot, trending, neglected or all (default hot)
  -n, --limit <N>        At most N results (default 20)
  --since <YYYY-MM-DD>   Only notes dated on or after this day (dated entries
                         and dated blog posts; the date comes from the path)
  --until <YYYY-MM-DD>   Only notes dated on or before this day

${GLOBAL_OPTIONS_HELP}

Output: one line per result, best first:
  <path>  ## <heading>  <snippet>
The heading is left out for a note's opening section. No results prints
nothing (exit 0). With --json: {mode, query, at, results: [{item, path,
dangling, title, role, date, published, sectionId, heading, snippet: {text,
highlights}, rankKey, components, now}]}, where components and now explain
the rank (relevance, log scores per half-life and kind, the signal).

Examples:
  somememos search compost tea
  somememos search "grafting knife" --mode all --limit 5
  somememos search frost --since 2026-01-01 --until 2026-01-31
  somememos search kiln --json
`;

/** One result as a line: path, heading (if any), and a one-line snippet. */
export function formatSearchLine(brain: Session, r: engine.ResultView): string {
  const parts = [resultLabel(brain, r)];
  if (r.heading) parts.push(`## ${oneLineText(r.heading, 60)}`);
  const snippet = r.snippet ? oneLineText(r.snippet.text) : '';
  if (snippet !== '') parts.push(snippet);
  return parts.join('  ');
}

export const searchCommand: Command = {
  name: 'search',
  summary: 'Keyword search ranked by relevance and activity (logs nothing)',
  usage,
  async run(args, ctx) {
    const { values, positionals, globals } = parseCommandArgs(
      args,
      {
        mode: { type: 'string' },
        limit: { type: 'string', short: 'n' },
        since: { type: 'string' },
        until: { type: 'string' },
      },
      { allowPositionals: true },
    );
    if (globals.help) {
      ctx.stdout(usage);
      return EXIT_OK;
    }
    const query = positionals.join(' ').trim();
    if (query === '') throw new UsageError('give the words to search for');
    const mode = values.mode ?? 'hot';
    if (!ranking.isRankMode(mode)) {
      throw new UsageError(`--mode must be hot, trending, neglected or all, not ${mode}`);
    }
    const limit = parseLimit(values.limit);
    const since = parseDateOption('since', values.since);
    const until = parseDateOption('until', values.until);
    return withSession(ctx, brainOptions(globals), async (brain) => {
      const response = await brain.engine.search(query, {
        mode,
        ...(limit === undefined ? {} : { limit }),
        ...(since === undefined ? {} : { since }),
        ...(until === undefined ? {} : { until }),
      });
      emit(ctx, globals.json, response, (r) => r.results.map((x) => formatSearchLine(brain, x)));
      return EXIT_OK;
    });
  },
};
