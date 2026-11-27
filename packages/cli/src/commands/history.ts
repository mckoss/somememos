// `somememos history <path>` and `somememos restore <path> <commit>`: a
// note's versions on the server, and putting an earlier one back as a new
// version (PLAN.md section 7, "Version history"; IMPLEMENTATION.md task 3.6).
// Only the server keeps versions, so these need remote mode.

import {
  CommandError,
  GLOBAL_OPTIONS_HELP,
  brainOptions,
  emit,
  parseCommandArgs,
  warn,
  withSession,
} from '../brain/index.js';
import type { RemoteSession, Session } from '../brain/index.js';
import { EXIT_OK, UsageError } from '../context.js';
import type { RemoteNoteVersion } from '../remote/engine.js';
import { refreshFromServer } from '../remote/flow.js';
import { checkNotePath } from '../remote/workfolder.js';
import { formatLocalTime } from './log.js';
import { oneLineText, parseLimit, resolveNotePath } from './shared.js';
import type { Command } from './types.js';

const historyUsage = `Usage: somememos history <path> [--limit N]

List a note's versions on the server, newest first, following renames back
to its earlier paths: when, which commit, which client, and the change's
message. Needs remote mode (a working folder; see 'somememos help setup'):
only the server keeps versions.

Options:
  -n, --limit <N>  At most N versions (default 50)

${GLOBAL_OPTIONS_HELP}

Output: one line per version:
  <YYYY-MM-DD HH:MM>  <commit>  <client>  <message>
with "(deleted)" or "(renamed to <path>)" on the version that did that, and
"[<path>]" when the version is from an earlier path. Times are local. With
--json: {path, versions: [{path, mutation, commit, hash, renamedTo, time,
client, message}]}.

Examples:
  somememos history memos/compost-tea.md
  somememos restore memos/compost-tea.md 1a2b3c4d5e6f
`;

const restoreUsage = `Usage: somememos restore <path> <commit> [-m <message>]

Make an earlier version of a note (a commit from 'somememos history') its
current version. Nothing is rewritten: the restore is a new version, with
your message or "restore <path> to its version of <commit>". The working
folder's copy is updated unless you have edited it. Needs remote mode.

Options:
  -m, --message <text>  The reason, for the change log

${GLOBAL_OPTIONS_HELP}

Output: "restored <path> to <commit>". With --json: the save result {status,
path, hash, created, change}.

Examples:
  somememos history memos/compost-tea.md
  somememos restore memos/compost-tea.md 1a2b3c4d5e6f -m "update undo the rewrite"
`;

function needsServer(session: Session, what: string): RemoteSession {
  if (session.remote) return session.remote;
  throw new CommandError(
    `${what} needs a server: only the server keeps a note's versions, and this is a local brain; run it in a working folder (somememos connect, or SOMEMEMOS_SERVER; see somememos help setup)`,
  );
}

export function formatVersion(session: Session, path: string, v: RemoteNoteVersion): string {
  const parts = [formatLocalTime(v.time), v.commit.slice(0, 12), v.client];
  let message = oneLineText(v.message.split('\n')[0] ?? '', 100) || '(no message)';
  if (v.renamedTo) message += ` (renamed to ${session.displayPath(v.renamedTo)})`;
  else if (v.hash === null) message += ' (deleted)';
  if (v.path !== path) message += ` [${session.displayPath(v.path)}]`;
  parts.push(message);
  return parts.join('  ');
}

export const historyCommand: Command = {
  name: 'history',
  summary: "List a note's versions on the server (remote mode)",
  usage: historyUsage,
  async run(args, ctx) {
    const { values, positionals, globals } = parseCommandArgs(
      args,
      { limit: { type: 'string', short: 'n' } },
      { allowPositionals: true },
    );
    if (globals.help) {
      ctx.stdout(historyUsage);
      return EXIT_OK;
    }
    if (positionals.length !== 1) throw new UsageError('give exactly one note path');
    const limit = parseLimit(values.limit, 50) as number;
    if (limit < 1 || limit > 1000) throw new UsageError('--limit must be 1 to 1000');
    return withSession(ctx, brainOptions(globals), async (session) => {
      const remote = needsServer(session, 'history');
      const path = checkNotePath(resolveNotePath(session, positionals[0] as string));
      const history = await remote.engine.history(path, limit);
      emit(ctx, globals.json, history, (h) =>
        h.versions.map((v) => formatVersion(session, path, v)),
      );
      return EXIT_OK;
    });
  },
};

export const restoreCommand: Command = {
  name: 'restore',
  summary: 'Make an earlier version of a note current (remote mode)',
  usage: restoreUsage,
  async run(args, ctx) {
    const { values, positionals, globals } = parseCommandArgs(
      args,
      { message: { type: 'string', short: 'm', multiple: true } },
      { allowPositionals: true },
    );
    if (globals.help) {
      ctx.stdout(restoreUsage);
      return EXIT_OK;
    }
    if (positionals.length !== 2) throw new UsageError('give the note path and the commit');
    const commit = positionals[1] as string;
    if (!/^[0-9a-f]{4,64}$/.test(commit)) {
      throw new UsageError(`${JSON.stringify(commit)} is not a commit id (see somememos history)`);
    }
    const message = (values.message ?? []).join('\n\n').trim() || null;
    return withSession(ctx, brainOptions(globals), async (session) => {
      const remote = needsServer(session, 'restore');
      const path = checkNotePath(resolveNotePath(session, positionals[0] as string));
      const full = await resolveCommit(remote, path, commit);
      const result = await remote.engine.restore(path, full, message ? { message } : {});
      if (result.status === 'conflict') {
        throw new CommandError(`the server refused the restore of ${session.displayPath(path)}`);
      }
      const notice = await refreshFromServer(remote, path, session.displayPath);
      const record =
        result.status === 'saved' ? (({ index: _index, ...rest }) => rest)(result) : result;
      emit(ctx, globals.json, record, () =>
        result.status === 'unchanged'
          ? `${session.displayPath(path)} already is its version of ${full.slice(0, 12)}`
          : `restored ${session.displayPath(path)} to ${full.slice(0, 12)}`,
      );
      if (notice) warn(ctx, notice);
      return EXIT_OK;
    });
  },
};

/** A full commit id from a prefix, using the note's history. */
async function resolveCommit(remote: RemoteSession, path: string, prefix: string): Promise<string> {
  if (prefix.length === 40 || prefix.length === 64) return prefix;
  const { versions } = await remote.engine.history(path, 1000);
  const matches = [...new Set(versions.map((v) => v.commit).filter((c) => c.startsWith(prefix)))];
  if (matches.length === 1) return matches[0] as string;
  throw new CommandError(
    matches.length === 0
      ? `no version of that note has a commit starting ${prefix} (see somememos history)`
      : `${prefix} matches ${matches.length} commits; give more of it`,
  );
}
