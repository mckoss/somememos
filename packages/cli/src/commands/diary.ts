// `somememos diary [--date YYYY-MM-DD]`: the path of a day's dated entry, created if missing.

import { join } from 'node:path';
import { engine, markdown } from '@somememos/core';
import {
  CommandError,
  GLOBAL_OPTIONS_HELP,
  brainOptions,
  emit,
  parseCommandArgs,
  warn,
  withSession,
} from '../brain/index.js';
import { fetchIntoFolder } from '../remote/flow.js';
import { EXIT_OK, UsageError } from '../context.js';
import { SIDECAR_DIR } from '../store/index.js';
import type { Command } from './types.js';

const usage = `Usage: somememos diary [--date YYYY-MM-DD]

Print the path of today's dated entry (the local date), creating the file
with a '# <date>' heading if it does not exist yet. The path comes from the
first "dated" pattern in the brain's roles, e.g.
diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md. Write to that file with your usual
tools; the next command's index pass picks it up. A new entry holding only
its heading is not a change to commit (no reminder names it) until you
write in it. In remote mode the entry is
created on the server and placed in the working folder; send what you write
with 'somememos commit'.

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
export const localDate = engine.localDate;

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
    return withSession(ctx, brainOptions(globals), async (brain) => {
      let entry: engine.DiaryEntry;
      try {
        entry = await brain.engine.ensureDiary(values.date);
      } catch (error) {
        if (engine.isEngineError(error) && error.code === 'no-dated-pattern') {
          throw new CommandError(
            error.message.replace('in its config', `in ${SIDECAR_DIR}/config.json`),
          );
        }
        throw error;
      }
      if (brain.remote) {
        // Place the entry in the working folder, to write to and commit.
        const fetched = await fetchIntoFolder(brain.remote, entry.path, {
          record: false,
          display: brain.displayPath,
        });
        for (const notice of fetched.notices) warn(ctx, notice);
      }
      const record: DiaryRecord = {
        path: entry.path,
        file: join(brain.root, entry.path),
        date: entry.date,
        created: entry.created,
      };
      // The file to write: with a working folder set only by the environment
      // (other paths are shown brain-relative there), its full path.
      const bare = brain.remote !== null && !brain.remote.connected;
      emit(ctx, globals.json, record, (r) => (bare ? r.file : brain.displayPath(r.path)));
      return EXIT_OK;
    });
  },
};
