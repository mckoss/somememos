// `somememos clone <server-url> <brain-id> [dir]` and `somememos sync`: an
// offline copy of a brain on a server (PLAN.md section 7, "Offline copies"
// and "Sync protocol"). The copy is an ordinary local-mode brain; its server
// is remembered in `.somememos/remote.json` (core's config.json rejects
// unknown keys, so it stays core's shape), and `sync` runs core's `runSync`
// against `POST …/sync`: it pushes local events, change records and edits,
// and pulls what changed. Conflicts keep both versions.

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { engine, storage } from '@somememos/core';
import {
  type Brain,
  CommandError,
  GLOBAL_OPTIONS_HELP,
  brainOptions,
  emit,
  parseCommandArgs,
  plural,
  warn,
  withBrain,
} from '../brain/index.js';
import type { Context } from '../context.js';
import { EXIT_OK, UsageError } from '../context.js';
import { createRemoteClient } from '../remote/client.js';
import {
  type CloneRemote,
  ENV,
  checkBrainId,
  checkTokenFile,
  normalizeServerUrl,
  readCloneRemote,
  resolveToken,
  writeCloneRemote,
} from '../remote/config.js';
import { createRemoteEngine } from '../remote/engine.js';
import { CONFIG_FILE, SIDECAR_DIR } from '../store/index.js';
import { prepareRemote } from './connect.js';
import { GITIGNORE_LINE, ensureGitignoreLine, insideGitRepository } from './init.js';
import type { Command } from './types.js';

const cloneUsage = `Usage: somememos clone <server-url> <brain-id> [dir] [--token-file <path>]

Make a full offline copy of a brain on a server, in <dir> (default: a new
folder named after the brain): a local-mode brain whose notes are ordinary
files, with the event log, change records, index and scores. Every local
command then works offline. Run 'somememos sync' to send what you changed
(edits, reads, change records) and get what changed on the server.

The token comes from ${ENV.token}, or --token-file <path> (a file outside
<dir>; its path is recorded, never the token). The server's config supplies
the folder roles. <dir> must be empty or not exist yet.

Options:
  --token-file <path>  Read the token from this file (outside <dir>)

${GLOBAL_OPTIONS_HELP}

Output: what was copied. With --json: {root, server, brainId, clientId,
rounds, mutation, received: {notes, events, changes}}.

Examples:
  somememos clone https://brain.example.com garden ~/garden
`;

const syncUsage = `Usage: somememos sync [--server <url> --brain-id <id>] [--token-file <path>]

Sync this offline copy with its server: push the notes edited, created,
deleted or renamed here (each with the version it was based on), the events
and the change records logged here, and pull everything that changed on the
server since the last sync. Scores are never sent: each copy computes them
from the event log.

A note changed both here and on the server is a conflict: the server's
version takes its path, and this copy's is kept beside it as
<name>.conflict-<client>-<date>.md (nothing is lost). Merge it by hand and
delete the conflict file.

A brain made with 'somememos clone' knows its server. For a brain that began
on this machine, give --server and --brain-id once: the server's brain must
exist and declare the same folder roles; this brain's notes and history are
then pushed to it.

Options:
  --server <url>       The server, for a brain with none recorded
  --brain-id <id>      The brain on that server
  --token-file <path>  Read the token from this file (recorded)

${GLOBAL_OPTIONS_HELP}

Output: one summary line, then one line per conflict. With --json: {server,
brainId, rounds, mutation, pushed: {edits, applied, duplicates, events,
changes}, received: {notes, events, changes}, conflicts: [{path, status, code,
conflictPath}], waiting}.

Examples:
  somememos sync
  somememos sync --server https://brain.example.com --brain-id garden
`;

export interface SyncRecord {
  server: string;
  brainId: string;
  rounds: number;
  mutation: number;
  pushed: { edits: number; applied: number; duplicates: number; events: number; changes: number };
  received: { notes: number; events: number; changes: number };
  conflicts: engine.SyncConflict[];
  waiting: string[];
}

/** Runs core's sync loop against the server and adds up the rounds. */
export async function syncWithServer(
  ctx: Context,
  brain: Brain,
  remote: CloneRemote,
): Promise<SyncRecord> {
  const token = resolveToken(ctx.env, remote.tokenFile, ctx.cwd);
  const client = createRemoteClient({
    server: remote.server,
    brainId: remote.brainId,
    token,
    clientId: brain.config.clientId,
  });
  const server = createRemoteEngine(client);
  const result = await engine.runSync(brain.engine, (request) => server.sync(request));
  const sum = (pick: (o: engine.SyncOutcome) => number) =>
    result.outcomes.reduce((n, o) => n + pick(o), 0);
  return {
    server: remote.server,
    brainId: remote.brainId,
    rounds: result.rounds,
    mutation: result.mutation,
    pushed: {
      edits: sum((o) => o.pushed.edits),
      applied: sum((o) => o.pushed.applied),
      duplicates: sum((o) => o.pushed.duplicates),
      events: sum((o) => o.pushed.events),
      changes: sum((o) => o.pushed.changes),
    },
    received: {
      notes: sum((o) => o.received.notes),
      events: sum((o) => o.received.events),
      changes: sum((o) => o.received.changes),
    },
    conflicts: result.conflicts,
    waiting: result.waiting,
  };
}

function conflictLine(brain: Brain, c: engine.SyncConflict): string {
  const what = c.status === 'refused' ? `refused (${c.code ?? 'refused'})` : 'conflict';
  const kept = c.conflictPath
    ? `this copy's version is kept as ${brain.displayPath(c.conflictPath)}`
    : 'this copy had no version to keep';
  return `${what}: ${brain.displayPath(c.path)} now has the server's version; ${kept}; merge by hand, then delete the conflict file and sync again`;
}

function formatSync(r: SyncRecord): string {
  return `synced with brain ${r.brainId} on ${r.server}: pushed ${plural(r.pushed.edits, 'edit')} (${r.pushed.applied} applied), ${plural(r.pushed.events, 'event')}, ${plural(r.pushed.changes, 'change record')}; received ${plural(r.received.notes, 'note')}, ${plural(r.received.events, 'event')}, ${plural(r.received.changes, 'change record')}${r.conflicts.length > 0 ? `; ${plural(r.conflicts.length, 'conflict')}` : ''}`;
}

export const cloneCommand: Command = {
  name: 'clone',
  summary: 'Make an offline copy of a brain on a server (then: sync)',
  usage: cloneUsage,
  async run(args, ctx) {
    const { values, positionals, globals } = parseCommandArgs(
      args,
      { 'token-file': { type: 'string' } },
      { allowPositionals: true },
    );
    if (globals.help) {
      ctx.stdout(cloneUsage);
      return EXIT_OK;
    }
    const prepared = await prepareRemote(ctx, positionals, values['token-file'], (id) => id);
    const root = prepared.root;
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (entries.length > 0) {
      throw new CommandError(`${root} is not empty; clone into a new or empty folder`);
    }
    const config = storage.parseBrainConfig(
      { ...prepared.brain.config, clientId: prepared.clientId },
      `the server's config for brain ${prepared.brainId}`,
    );
    mkdirSync(join(root, SIDECAR_DIR), { recursive: true });
    writeFileSync(join(root, SIDECAR_DIR, CONFIG_FILE), storage.serializeBrainConfig(config), {
      flag: 'wx',
    });
    const remote: CloneRemote = {
      server: prepared.server,
      brainId: prepared.brainId,
      tokenFile: prepared.tokenFile,
    };
    writeCloneRemote(root, remote);
    if (insideGitRepository(root)) ensureGitignoreLine(root, GITIGNORE_LINE);

    return withBrain(ctx, { brain: root, remind: false }, async (brain) => {
      const synced = await syncWithServer(ctx, brain, remote);
      const status = await brain.engine.status();
      const record = {
        root,
        server: remote.server,
        brainId: remote.brainId,
        clientId: config.clientId,
        rounds: synced.rounds,
        mutation: synced.mutation,
        received: synced.received,
      };
      emit(ctx, globals.json, record, (r) => [
        `cloned brain ${r.brainId} from ${r.server} into ${r.root}`,
        `  ${plural(status.notes.total, 'note')}, ${plural(r.received.events, 'event')}, ${plural(r.received.changes, 'change record')}`,
        `next: cd ${r.root}; work offline with the local commands; somememos sync to send and get changes`,
      ]);
      return EXIT_OK;
    });
  },
};

export const syncCommand: Command = {
  name: 'sync',
  summary: 'Sync an offline copy with its server (push and pull changes)',
  usage: syncUsage,
  async run(args, ctx) {
    const { values, positionals, globals } = parseCommandArgs(args, {
      server: { type: 'string' },
      'brain-id': { type: 'string' },
      'token-file': { type: 'string' },
    });
    if (globals.help) {
      ctx.stdout(syncUsage);
      return EXIT_OK;
    }
    if (positionals.length > 0) throw new UsageError('sync takes no arguments');
    if ((values.server === undefined) !== (values['brain-id'] === undefined)) {
      throw new UsageError('give --server and --brain-id together');
    }
    return withBrain(ctx, brainOptions(globals, { remind: false }), async (brain) => {
      let remote = readCloneRemote(brain.root);
      if (values.server !== undefined) {
        const given: CloneRemote = {
          server: normalizeServerUrl(values.server),
          brainId: checkBrainId(values['brain-id'] as string),
          tokenFile:
            values['token-file'] === undefined
              ? (remote?.tokenFile ?? null)
              : checkTokenFile(ctx.cwd, values['token-file'], brain.root),
        };
        if (remote && (remote.server !== given.server || remote.brainId !== given.brainId)) {
          throw new CommandError(
            `this brain already syncs with brain ${remote.brainId} on ${remote.server}; edit or delete ${SIDECAR_DIR}/remote.json to change that`,
          );
        }
        if (!remote) {
          await checkSameRoles(ctx, brain, given);
          writeCloneRemote(brain.root, given);
        }
        remote = given;
      } else if (values['token-file'] !== undefined && remote) {
        remote = {
          ...remote,
          tokenFile: checkTokenFile(ctx.cwd, values['token-file'], brain.root),
        };
        writeCloneRemote(brain.root, remote);
      }
      if (!remote) {
        throw new CommandError(
          `this brain has no server to sync with: make an offline copy with 'somememos clone <server-url> <brain-id>', or give this brain a server once with 'somememos sync --server <url> --brain-id <id>'`,
        );
      }
      const record = await syncWithServer(ctx, brain, remote);
      emit(ctx, globals.json, record, formatSync);
      if (!globals.json) {
        for (const c of record.conflicts) warn(ctx, conflictLine(brain, c));
        if (record.waiting.length > 0) {
          warn(
            ctx,
            `${plural(record.waiting.length, 'note')} changed on both sides is still waiting; run somememos sync again`,
          );
        }
      }
      return EXIT_OK;
    });
  },
};

/** A brain that began here may join a server brain only with the same folder roles. */
async function checkSameRoles(ctx: Context, brain: Brain, remote: CloneRemote): Promise<void> {
  const token = resolveToken(ctx.env, remote.tokenFile, ctx.cwd);
  const client = createRemoteClient({
    server: remote.server,
    brainId: remote.brainId,
    token,
    clientId: brain.config.clientId,
  });
  const info = await createRemoteEngine(client).brainInfo();
  const canonical = (roles: object) => JSON.stringify(sortDeep(roles));
  if (canonical(info.config.roles) !== canonical(brain.config.roles)) {
    throw new CommandError(
      `brain ${remote.brainId} on the server declares other folder roles than this brain; they must match before the first sync`,
    );
  }
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortDeep((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
