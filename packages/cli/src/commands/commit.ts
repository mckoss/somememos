// `somememos commit [-m message] [paths…]`: record why the brain changed.
//
// Local mode (PLAN.md section 6): `engine.commit` runs the index pass, which
// logs the edits it finds, then writes one change record covering every
// changed path that no change record covers yet. The index pass keeps that
// list (durable meta, `indexer.uncommitted`), so a change already picked up
// by an earlier command's automatic pass still gets its message here.

import type { engine, storage } from '@somememos/core';
import {
  GLOBAL_OPTIONS_HELP,
  brainOptions,
  emit,
  parseCommandArgs,
  plural,
  warn,
  withBrain,
} from '../brain/index.js';
import { EXIT_OK, UsageError } from '../context.js';
import type { IndexSummary } from '../indexer/index.js';
import type { Command } from './types.js';

const usage = `Usage: somememos commit [-m <message>] [paths…]

Record a change: run the index pass (logging the edits and links it finds),
then write one change record with the time, this client, the changed notes and
your message. The message says why; its first word may be an operation tag
(ingest, update, session, query, lint by default), e.g. "update fix dates".

Covers every note changed since the last change record, including changes an
earlier command's automatic index pass already found. Give paths (files or
folders, relative to the working directory) to commit only those; the rest
stay uncommitted. With nothing to commit it says so and exits 0.

Options:
  -m, --message <text>  The reason for the change (repeat for more paragraphs)

${GLOBAL_OPTIONS_HELP}
  (commit always runs the index pass; --no-index is ignored)

Output: the change and its notes, one per line. With --json: {committed,
change: {id, time, client, message, op, paths} | null, remaining, index}.

Examples:
  somememos commit -m "update clarify the watering schedule"
  somememos commit -m "ingest notes from the workshop" memos/workshop.md
  somememos commit --json
`;

export interface CommitRecord {
  committed: boolean;
  change: storage.ChangeInput | null;
  /** Uncommitted paths left after this commit. */
  remaining: string[];
  index: IndexSummary | null;
}

function formatCommit(r: CommitRecord): string[] {
  if (!r.change) {
    return r.remaining.length > 0
      ? [
          `nothing to commit among the given paths; ${plural(r.remaining.length, 'other changed note')} not committed`,
        ]
      : ['nothing to commit: no changes since the last commit'];
  }
  const head = `committed ${plural(r.change.paths.length, 'note')}${r.change.op ? ` (${r.change.op})` : ''}${
    r.change.message ? `: ${r.change.message.split('\n')[0]}` : ' (no message)'
  }`;
  const lines = [head, ...r.change.paths.map((p) => `  ${p}`)];
  if (r.remaining.length > 0) {
    lines.push(`${plural(r.remaining.length, 'other changed note')} not committed`);
  }
  return lines;
}

export const commitCommand: Command = {
  name: 'commit',
  summary: 'Record a change with a message (runs the index pass)',
  usage,
  async run(args, ctx) {
    const { values, positionals, globals } = parseCommandArgs(
      args,
      { message: { type: 'string', short: 'm', multiple: true } },
      { allowPositionals: true },
    );
    if (globals.help) {
      ctx.stdout(usage);
      return EXIT_OK;
    }
    const message = (values.message ?? []).join('\n\n').trim() || null;

    // The engine's commit runs the index pass itself, under the same lock.
    const options = brainOptions(globals, { noIndex: false, autoIndex: false, remind: false });
    return withBrain(ctx, options, async (brain) => {
      const filters = positionals.map((p) => {
        const path = brain.brainPath(p);
        if (path === null) throw new UsageError(`${p} is outside the brain`);
        return path;
      });
      const result: engine.CommitResult = await brain.engine.commit({ message, paths: filters });
      for (const w of result.index.warnings) warn(ctx, w);
      // The record as before the engine: the change without its local seq.
      const change = result.change ? (({ seq: _seq, ...input }) => input)(result.change) : null;
      const record: CommitRecord = { ...result, change };
      emit(ctx, globals.json, record, formatCommit);
      return EXIT_OK;
    });
  },
};
