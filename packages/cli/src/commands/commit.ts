// `somememos commit [-m message] [paths…]`: record why the brain changed.
//
// Local mode (PLAN.md section 6): run the index pass, which logs the edits it
// finds, then write one change record covering every changed path that no
// change record covers yet. The index pass keeps that list (durable meta,
// `indexer.uncommitted`), so a change already picked up by an earlier
// command's automatic pass still gets its message here.

import { storage } from '@somememos/core';
import {
  GLOBAL_OPTIONS_HELP,
  brainOptions,
  emit,
  parseCommandArgs,
  plural,
  withBrain,
} from '../brain/index.js';
import { EXIT_OK, UsageError } from '../context.js';
import { type IndexSummary, readUncommitted, writeUncommitted } from '../indexer/index.js';
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

/** Whether `path` is `filter` or lies inside the folder `filter` ('' is the whole brain). */
function covers(filter: string, path: string): boolean {
  return filter === '' || path === filter || path.startsWith(`${filter.replace(/\/+$/, '')}/`);
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

    return withBrain(ctx, brainOptions(globals, { noIndex: false }), async (brain) => {
      const filters = positionals.map((p) => {
        const path = brain.brainPath(p);
        if (path === null) throw new UsageError(`${p} is outside the brain`);
        return path;
      });
      const { stores, config } = brain;
      const record = await stores.indexTransaction(async (): Promise<CommitRecord> => {
        const pending = await readUncommitted(stores.meta);
        const selected =
          filters.length === 0 ? pending : pending.filter((p) => filters.some((f) => covers(f, p)));
        const remaining = pending.filter((p) => !selected.includes(p));
        if (selected.length === 0) {
          return { committed: false, change: null, remaining, index: brain.index };
        }
        const change: storage.ChangeInput = {
          id: storage.newId(),
          time: brain.now(),
          client: config.clientId,
          message,
          op: storage.changeOp(message, config.changeOps),
          paths: storage.normalizeChangePaths(selected),
        };
        await stores.events.appendChanges([change]);
        await writeUncommitted(stores.meta, remaining);
        return { committed: true, change, remaining, index: brain.index };
      });
      emit(ctx, globals.json, record, formatCommit);
      return EXIT_OK;
    });
  },
};
