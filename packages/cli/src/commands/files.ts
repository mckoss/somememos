// `somememos rm <path>` and `somememos mv <from> <to>`: explicit deletes and
// renames (PLAN.md section 7, "Edits and conflicts": a rename is not a delete
// plus a new note). In local mode they go through the engine on the brain's
// files; in remote mode the server does them, and the working folder follows
// when its copy is untouched.

import { isAbsolute } from 'node:path';
import { markdown } from '@somememos/core';
import {
  CommandError,
  GLOBAL_OPTIONS_HELP,
  brainOptions,
  emit,
  parseCommandArgs,
  withSession,
} from '../brain/index.js';
import type { RemoteSession, Session } from '../brain/index.js';
import { EXIT_OK, UsageError } from '../context.js';
import { checkNotePath } from '../remote/workfolder.js';
import { resolveNotePath } from './shared.js';
import type { Command } from './types.js';

const rmUsage = `Usage: somememos rm <path> [-m <message>]

Delete a note, recording a change with your message. In local mode the file
is deleted from the brain. In remote mode the server deletes it (it stays in
the server's version history: see 'somememos history'), and the working
folder's copy is removed too. A working-folder copy with uncommitted edits is
refused: commit or discard the edits first.

Deleting a file with ordinary tools deletes nothing on the server in remote
mode; use this command.

Options:
  -m, --message <text>  The reason, for the change log

${GLOBAL_OPTIONS_HELP}

Output: "deleted <path>". With --json: {status, path, change}.

Examples:
  somememos rm memos/old-draft.md -m "lint remove a duplicate"
`;

const mvUsage = `Usage: somememos mv <from> <to> [-m <message>]

Rename a note, recording one change with your message. Links to it are
resolved again; its scores move with it. In remote mode the server renames
it, and the working folder's copy moves too. A copy with uncommitted edits is
refused: commit them first.

Options:
  -m, --message <text>  The reason, for the change log

${GLOBAL_OPTIONS_HELP}

Output: "renamed <from> -> <to>". With --json: {status, from, to, change}.

Examples:
  somememos mv memos/tea.md memos/compost-tea.md -m "update clearer name"
`;

function messageOf(values: { message?: string[] }): string | null {
  return (values.message ?? []).join('\n\n').trim() || null;
}

/** Refuses when the working folder holds uncommitted edits to `path`. */
async function refuseEdited(remote: RemoteSession, session: Session, path: string, what: string) {
  const state = await remote.folder.stateOf(path);
  if (state?.kind === 'edited') {
    throw new CommandError(
      `${session.displayPath(path)} has uncommitted edits; commit them (or restore the file) before you ${what} it`,
    );
  }
  return state;
}

export const rmCommand: Command = {
  name: 'rm',
  summary: 'Delete a note, with a message (remote mode: on the server)',
  usage: rmUsage,
  async run(args, ctx) {
    const { values, positionals, globals } = parseCommandArgs(
      args,
      { message: { type: 'string', short: 'm', multiple: true } },
      { allowPositionals: true },
    );
    if (globals.help) {
      ctx.stdout(rmUsage);
      return EXIT_OK;
    }
    if (positionals.length !== 1) throw new UsageError('give exactly one note path');
    const message = messageOf(values);
    return withSession(ctx, brainOptions(globals), async (session) => {
      const path = resolveNotePath(session, positionals[0] as string);
      const remote = session.remote;
      if (remote) {
        checkNotePath(path);
        await refuseEdited(remote, session, path, 'delete');
      }
      const result = await session.engine.deleteNote(path, message ? { message } : {});
      if (remote) {
        remote.folder.remove(path);
        remote.folder.update((notes) => {
          delete notes[path];
        });
      }
      const { index: _index, ...record } = result;
      emit(ctx, globals.json, record, (r) => `deleted ${session.displayPath(r.path)}`);
      return EXIT_OK;
    });
  },
};

export const mvCommand: Command = {
  name: 'mv',
  summary: 'Rename a note, with a message (remote mode: on the server)',
  usage: mvUsage,
  async run(args, ctx) {
    const { values, positionals, globals } = parseCommandArgs(
      args,
      { message: { type: 'string', short: 'm', multiple: true } },
      { allowPositionals: true },
    );
    if (globals.help) {
      ctx.stdout(mvUsage);
      return EXIT_OK;
    }
    if (positionals.length !== 2) throw new UsageError('give the note path and its new path');
    const message = messageOf(values);
    return withSession(ctx, brainOptions(globals), async (session) => {
      const from = resolveNotePath(session, positionals[0] as string);
      const given = positionals[1] as string;
      // Relative to the working directory, or brain-relative when the working
      // directory is outside the brain (remote mode set by the environment).
      let to = session.brainPath(given);
      if (to === null && !isAbsolute(given)) to = markdown.normalizePath(given);
      if (to === null || to === '') throw new UsageError(`${given} is outside the brain`);
      const remote = session.remote;
      let fromState = null;
      if (remote) {
        checkNotePath(from);
        checkNotePath(to);
        fromState = await refuseEdited(remote, session, from, 'rename');
        const there = await remote.folder.stateOf(to);
        if (there) {
          throw new CommandError(
            `${session.displayPath(to)} already exists in the working folder; move or delete it first`,
          );
        }
      }
      const result = await session.engine.renameNote(from, to, message ? { message } : {});
      if (remote) {
        const text = fromState ? remote.folder.readText(from) : undefined;
        if (text !== undefined && fromState?.kind === 'untouched') {
          const fp = remote.folder.writeText(to, text);
          remote.folder.remove(from);
          remote.folder.update((notes) => {
            delete notes[from];
            notes[to] = { base: fromState.base, fingerprint: fp };
          });
        } else {
          remote.folder.update((notes) => {
            delete notes[from];
          });
        }
      }
      const { index: _index, ...record } = result;
      emit(
        ctx,
        globals.json,
        record,
        (r) => `renamed ${session.displayPath(r.from)} -> ${session.displayPath(r.to)}`,
      );
      return EXIT_OK;
    });
  },
};
