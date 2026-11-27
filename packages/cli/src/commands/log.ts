// `somememos log [path]`: the change log, newest first (PLAN.md section 4,
// "The change log"; IMPLEMENTATION.md task 1.16b).

import type { storage } from '@somememos/core';
import {
  GLOBAL_OPTIONS_HELP,
  brainOptions,
  emit,
  parseCommandArgs,
  withSession,
} from '../brain/index.js';
import type { Session } from '../brain/index.js';
import { EXIT_OK, UsageError } from '../context.js';
import { oneLineText, parseLimit, parseTimeOption, resolveNotePath } from './shared.js';
import type { Command } from './types.js';

/** Paths listed in full under a change; more are summarized. */
export const LOG_PATHS_SHOWN = 5;

const usage = `Usage: somememos log [path] [--op <op>] [--query <words>] [--since <time>]
                     [--until <time>] [--limit N] [--all]

Show the change log, newest first: one record per 'somememos commit' (and per
imported git commit), with its time, operation tag, message and the notes it
changed. Changes the index pass found without a commit have no message.

By default it hides changes that touch only dated entries (diary upkeep), so
changes to memos stand out; --all shows them too.

Options:
  [path]             Only changes that touched this note (relative to the
                     working directory or the brain's root)
  --op <op>          Only changes with this operation tag (the message's
                     first word, e.g. ingest, update, session, query, lint)
  -q, --query <words>  Only changes whose message has every word (matched
                     like search: stemmed; "quoted words" as a phrase)
  --since <time>     Only changes at or after this time: a local date
                     (2026-01-31), a date-time (2026-01-31T09:30) or @<unix seconds>
  --until <time>     Only changes up to this time (a date includes the whole day)
  -n, --limit <N>    At most N records (default 20; 0 for all)
  --all              Include changes that touch only dated entries

${GLOBAL_OPTIONS_HELP}

Output: per change, one line, then its notes indented:
  <YYYY-MM-DD HH:MM>  <op or ->  <message subject, or (no message)>
    <path>
With more than ${LOG_PATHS_SHOWN} notes, the first ${LOG_PATHS_SHOWN - 1} are listed and the rest counted. Times
are local. No changes prints nothing. With --json: {changes: [{id, seq, time,
client, message, op, paths}]}, newest first.

Examples:
  somememos log
  somememos log memos/compost-tea.md
  somememos log --op ingest --since 2026-11-01 --limit 5
  somememos log --query "watering schedule"
  somememos log --all --json
`;

/** `YYYY-MM-DD HH:MM` in local time. */
export function formatLocalTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The message's first line, without the op tag that starts it. */
export function messageSubject(change: storage.ChangeRecord): string {
  const first = (change.message ?? '').split('\n')[0]?.trim() ?? '';
  if (first === '') return '(no message)';
  if (change.op && first.split(/\s+/)[0] === change.op) {
    const rest = first.slice(change.op.length).trim();
    return rest === '' ? '(no message)' : oneLineText(rest, 100);
  }
  return oneLineText(first, 100);
}

export function formatChange(brain: Session, change: storage.ChangeRecord): string[] {
  const lines = [`${formatLocalTime(change.time)}  ${change.op ?? '-'}  ${messageSubject(change)}`];
  const paths = change.paths;
  const shown = paths.length > LOG_PATHS_SHOWN ? paths.slice(0, LOG_PATHS_SHOWN - 1) : paths;
  for (const p of shown) lines.push(`  ${brain.displayPath(p)}`);
  if (shown.length < paths.length) lines.push(`  … and ${paths.length - shown.length} more`);
  return lines;
}

export const logCommand: Command = {
  name: 'log',
  summary: 'Show the change log, newest first',
  usage,
  async run(args, ctx) {
    const { values, positionals, globals } = parseCommandArgs(
      args,
      {
        op: { type: 'string' },
        query: { type: 'string', short: 'q' },
        since: { type: 'string' },
        until: { type: 'string' },
        limit: { type: 'string', short: 'n' },
        all: { type: 'boolean' },
      },
      { allowPositionals: true },
    );
    if (globals.help) {
      ctx.stdout(usage);
      return EXIT_OK;
    }
    if (positionals.length > 1) throw new UsageError('give at most one note path');
    const since = parseTimeOption('since', values.since);
    const until = parseTimeOption('until', values.until);
    const limit = parseLimit(values.limit, 20) as number;
    return withSession(ctx, brainOptions(globals), async (brain) => {
      const path =
        positionals[0] === undefined ? undefined : resolveNotePath(brain, positionals[0]);
      const changes = await brain.engine.log({
        ...(path === undefined ? {} : { path }),
        ...(values.op === undefined ? {} : { op: values.op }),
        ...(values.query === undefined ? {} : { query: values.query }),
        ...(since === undefined ? {} : { since }),
        ...(until === undefined ? {} : { until }),
        ...(limit === 0 ? {} : { limit }),
        ...(values.all ? { all: true } : {}),
      });
      emit(ctx, globals.json, { changes }, (r) => r.changes.flatMap((c) => formatChange(brain, c)));
      return EXIT_OK;
    });
  },
};
