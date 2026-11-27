// `somememos index [--rebuild]`: run the index pass and print its summary.

import {
  GLOBAL_OPTIONS_HELP,
  brainOptions,
  emit,
  parseCommandArgs,
  withBrain,
} from '../brain/index.js';
import { EXIT_OK } from '../context.js';
import { formatIndexSummary } from './format.js';
import type { Command } from './types.js';

const usage = `Usage: somememos index [--rebuild]

Bring the derived index and scores up to date with the brain's files (local
mode). Every other command already does this first, so you rarely need it.

Finds new, changed, moved and deleted markdown files, updates the keyword
index and the link graph, and logs what changed in memos: an edit for each
changed memo (at the file's modification time), a mention for each link a
change added, and a rename record for each moved memo. The first index of a
brain logs nothing. Then folds new events into scores.

Options:
  --rebuild      Delete all derived data (index and scores) and rebuild it
                 from the files and the event log

${GLOBAL_OPTIONS_HELP}

Output: one summary line. With --json: {scanned, indexed, removed, renamed,
relinked, events: {edit, mention, rename}, warnings, changed, baseline,
rebuilt, folded: {events, renames}, ms}.

Examples:
  somememos index
  somememos index --rebuild
  somememos index --json
`;

export const indexCommand: Command = {
  name: 'index',
  summary: 'Update the keyword index and scores from the files',
  usage,
  async run(args, ctx) {
    const { values, globals } = parseCommandArgs(args, { rebuild: { type: 'boolean' } });
    if (globals.help) {
      ctx.stdout(usage);
      return EXIT_OK;
    }
    return withBrain(ctx, brainOptions(globals, { autoIndex: false }), async (brain) => {
      const summary = await brain.reindex({ rebuild: values.rebuild === true });
      emit(ctx, globals.json, summary, formatIndexSummary);
      return EXIT_OK;
    });
  },
};
