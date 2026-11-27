// `somememos read <path>`: print a note exactly and log a read (PLAN.md
// section 6; IMPLEMENTATION.md task 1.15). In local mode the brain is its own
// working folder, so nothing is copied; the read is the selection step that
// tells somememos what an agent is working with.

import {
  GLOBAL_OPTIONS_HELP,
  brainOptions,
  parseCommandArgs,
  printJson,
  warn,
  withSession,
} from '../brain/index.js';
import { fetchIntoFolder } from '../remote/flow.js';
import { checkNotePath } from '../remote/workfolder.js';
import { EXIT_OK, UsageError } from '../context.js';
import { resolveNotePath } from './shared.js';
import type { Command } from './types.js';

const usage = `Usage: somememos read <path> [--no-record]

Print a note's text exactly as stored (byte for byte; nothing is added), and
log a read event for it, so notes you work with rank higher in 'somememos
hot'. Use it instead of cat. Only scored notes (memos and blog posts) get a
read event; a dated entry or a source is printed and nothing is logged.

<path> is relative to the working directory, or to the brain's root (the
paths 'search' and 'hot' print work either way). An excluded or missing note
is refused with a one-line error (exit 1), and an excluded note's content is
never printed.

Options:
  --no-record  Print the note without logging a read

${GLOBAL_OPTIONS_HELP}

In remote mode (a working folder; see 'somememos help setup') the note is
also placed in the working folder at the same path, for you to edit there
and send back with 'somememos commit'. Reading it again fetches the server's
newer version if you have not edited the file; if you have, it prints your
copy and warns when the server's version moved on.

Output: the note's text. With --json: {path, text, hash, mtime, title, role,
date, published, sections: [{index, heading, startLine, endLine}], links:
[{target, dangling}], backlinks, recorded}; pass hash back when saving
through the web app or the server. In remote mode it adds file (the working
folder copy) and local (true when text is your edited copy).

Examples:
  somememos read memos/compost-tea.md
  somememos read memos/compost-tea.md --no-record
  somememos read diary/2026/11/2026-11-27.md --json
`;

export const readCommand: Command = {
  name: 'read',
  summary: 'Print a note exactly and log a read (use instead of cat)',
  usage,
  async run(args, ctx) {
    const { values, positionals, globals } = parseCommandArgs(
      args,
      { 'no-record': { type: 'boolean' } },
      { allowPositionals: true },
    );
    if (globals.help) {
      ctx.stdout(usage);
      return EXIT_OK;
    }
    if (positionals.length !== 1) throw new UsageError('give exactly one note path');
    const userPath = positionals[0] as string;
    const record = !(values['no-record'] ?? false);
    return withSession(ctx, brainOptions(globals), async (session) => {
      const path = resolveNotePath(session, userPath);
      if (session.remote) {
        checkNotePath(path);
        const result = await fetchIntoFolder(session.remote, path, {
          record,
          display: session.displayPath,
        });
        if (globals.json) {
          printJson(ctx, {
            ...(result.note ?? { path }),
            text: result.text,
            local: !result.wrote && result.note?.text !== result.text,
            file: session.remote.folder.file(path),
          });
        } else {
          ctx.stdout(result.text);
          for (const notice of result.notices) warn(ctx, notice);
        }
        return EXIT_OK;
      }
      const note = await session.engine.readNote(path, { record });
      if (globals.json) printJson(ctx, note);
      else ctx.stdout(note.text);
      return EXIT_OK;
    });
  },
};
