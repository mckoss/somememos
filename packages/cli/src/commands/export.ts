// `somememos export` and `somememos import-log`: the event log and change
// records as JSON lines (PLAN.md section 4, "Export format"; IMPLEMENTATION.md
// task 1.17). The markdown plus this file rebuilds the whole sidecar.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { engine } from '@somememos/core';
import {
  CommandError,
  GLOBAL_OPTIONS_HELP,
  brainOptions,
  emit,
  parseCommandArgs,
  plural,
  withBrain,
} from '../brain/index.js';
import { EXIT_OK, UsageError } from '../context.js';
import { refuseSourceCheckout } from './privacy.js';
import type { Command } from './types.js';

const exportUsage = `Usage: somememos export [--output <file>]

Write the event log (read, edit and mention events and rename records) and
the change records as JSON lines, one record per line in time order: the
brain's original data, from which scores and the index can always be
rebuilt. Load it into another brain with 'somememos import-log'.

The export is private: it lists note paths and change messages. It is
written to standard output unless --output is given, and export refuses to
write a file inside a somememos source checkout.

Options:
  -o, --output <file>  Write to this file (relative to the working directory)
                       instead of standard output

${GLOBAL_OPTIONS_HELP}

Output: the JSON lines, each {"type":"log","id","kind","item","to"?,"time",
"client"} or {"type":"change","id","time","client","message","op","paths"}.
With --output, one line saying what was written; with --output and --json,
{output, records, log, changes}. (--json without --output changes nothing:
the export is JSON already.)

Examples:
  somememos export > ~/backup/events.jsonl
  somememos export --output ~/backup/events.jsonl
`;

const importUsage = `Usage: somememos import-log <file>

Load an export (from 'somememos export') into this brain's event log: each
event, rename record and change record whose id the log already has is
skipped, so importing the same file twice adds nothing. Then fold the new
events into scores. Nothing here is a new event: the records keep their
original ids, times and clients.

${GLOBAL_OPTIONS_HELP}

Output: one line of counts. With --json: {log: {appended, duplicates},
changes: {appended, duplicates}, folded: {events, renames}}.

Examples:
  somememos import-log ~/backup/events.jsonl
  somememos import-log events.jsonl --brain ~/new-brain --json
`;

export interface ExportRecordSummary {
  output: string;
  records: number;
  log: number;
  changes: number;
}

export const exportCommand: Command = {
  name: 'export',
  summary: 'Write the event log and change records as JSON lines',
  usage: exportUsage,
  async run(args, ctx) {
    const { values, globals } = parseCommandArgs(args, {
      output: { type: 'string', short: 'o' },
    });
    if (globals.help) {
      ctx.stdout(exportUsage);
      return EXIT_OK;
    }
    const output = values.output === undefined ? undefined : resolve(ctx.cwd, values.output);
    if (output !== undefined) refuseSourceCheckout(output, 'an event log export');
    return withBrain(ctx, brainOptions(globals, { remind: false }), async (brain) => {
      const text = await brain.engine.exportLog();
      if (output === undefined) {
        ctx.stdout(text);
        return EXIT_OK;
      }
      writeFileSync(output, text, 'utf8');
      const lines = text === '' ? [] : text.trimEnd().split('\n');
      const changes = lines.filter((l) => l.startsWith('{"type":"change"')).length;
      const summary: ExportRecordSummary = {
        output,
        records: lines.length,
        log: lines.length - changes,
        changes,
      };
      emit(ctx, globals.json, summary, (s) => [
        `wrote ${plural(s.records, 'record')} (${plural(s.log, 'log entry', 'log entries')}, ${plural(s.changes, 'change record')}) to ${s.output}`,
      ]);
      return EXIT_OK;
    });
  },
};

export const importLogCommand: Command = {
  name: 'import-log',
  summary: 'Load an export into the event log (skips ids already present)',
  usage: importUsage,
  async run(args, ctx) {
    const { positionals, globals } = parseCommandArgs(args, {}, { allowPositionals: true });
    if (globals.help) {
      ctx.stdout(importUsage);
      return EXIT_OK;
    }
    if (positionals.length !== 1) throw new UsageError('give exactly one export file');
    const file = resolve(ctx.cwd, positionals[0] as string);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      throw new CommandError(
        `cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`,
      );
    }
    return withBrain(ctx, brainOptions(globals), async (brain) => {
      const result: engine.ImportResult = await brain.engine.importLog(text);
      emit(ctx, globals.json, result, (r) => [
        `imported ${plural(r.log.appended, 'log entry', 'log entries')} and ${plural(r.changes.appended, 'change record')}; skipped ${r.log.duplicates + r.changes.duplicates} already present; folded ${plural(r.folded.events, 'event')}, ${plural(r.folded.renames, 'rename')}`,
      ]);
      return EXIT_OK;
    });
  },
};
