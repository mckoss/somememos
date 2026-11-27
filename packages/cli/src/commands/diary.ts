// `somememos diary [--date YYYY-MM-DD]`: the path of a day's dated entry, created if missing.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { markdown } from '@somememos/core';
import {
  CommandError,
  GLOBAL_OPTIONS_HELP,
  brainOptions,
  emit,
  parseCommandArgs,
  withBrain,
} from '../brain/index.js';
import { EXIT_OK, UsageError } from '../context.js';
import { SIDECAR_DIR } from '../store/index.js';
import type { Command } from './types.js';

const usage = `Usage: somememos diary [--date YYYY-MM-DD]

Print the path of today's dated entry (the local date), creating the file
with a '# <date>' heading if it does not exist yet. The path comes from the
first "dated" pattern in the brain's roles, e.g.
diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md. Write to that file with your usual
tools; the next command's index pass picks it up.

Options:
  --date <YYYY-MM-DD>  Another day's entry instead of today's

${GLOBAL_OPTIONS_HELP}

Output: the path (relative to the working directory when inside the brain).
With --json: {path, file, date, created}, where path is brain-relative and
file absolute.

Examples:
  somememos diary
  somememos diary --date 2026-01-31
  echo "- watered the seedlings" >> "$(somememos diary)"
`;

/** The local calendar date of a Unix time, `YYYY-MM-DD`. */
export function localDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface DiaryRecord {
  path: string;
  file: string;
  date: string;
  created: boolean;
}

export const diaryCommand: Command = {
  name: 'diary',
  summary: "Print the path of today's dated entry, creating it if needed",
  usage,
  async run(args, ctx) {
    const { values, globals } = parseCommandArgs(args, { date: { type: 'string' } });
    if (globals.help) {
      ctx.stdout(usage);
      return EXIT_OK;
    }
    if (values.date !== undefined && !markdown.parseCalendarDate(values.date)) {
      throw new UsageError(`--date must be a calendar date like 2026-01-31, not '${values.date}'`);
    }
    return withBrain(ctx, brainOptions(globals), async (brain) => {
      const pattern = brain.classifier.datedPatterns[0];
      if (pattern === undefined) {
        throw new CommandError(
          `this brain declares no dated pattern; add one to "roles" in ${SIDECAR_DIR}/config.json, e.g. "dated": ["diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md"]`,
        );
      }
      const date = values.date ?? localDate(brain.now());
      let path: string;
      try {
        path = markdown.renderDatedPath(pattern, date);
      } catch (error) {
        throw new CommandError(
          `the first dated pattern '${pattern}' cannot name an entry: ${(error as Error).message}`,
        );
      }
      if (brain.classifier.classify(path)?.role !== 'dated') {
        throw new CommandError(
          `the first dated pattern '${pattern}' names a path whose role is not dated; check the roles in ${SIDECAR_DIR}/config.json`,
        );
      }
      const file = join(brain.root, path);
      let created = false;
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `# ${date}\n`, { flag: 'wx' });
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const record: DiaryRecord = { path, file, date, created };
      emit(ctx, globals.json, record, (r) => brain.displayPath(r.path));
      return EXIT_OK;
    });
  },
};
