// `somememos config [pull|push]`: the brain's shared config (PLAN.md section
// 4, "Folder roles"): everything in `.somememos/config.json` but the client
// id, which every copy of a brain on a server shares.
//
// - In remote mode it is simply read from the server.
// - In an offline copy (`somememos clone`) it is the local file, which
//   `somememos sync` keeps in step: a local edit is sent, a change made
//   elsewhere is taken. When both changed, sync stops and `config pull` (take
//   the server's) or `config push` (replace the server's) settles it.
// - In a local brain with no server it is just the file.

import { engine, type storage, sync as coreSync } from '@somememos/core';
import {
  CommandError,
  GLOBAL_OPTIONS_HELP,
  brainOptions,
  emit,
  locateBrain,
  parseCommandArgs,
  withBrain,
  withSession,
} from '../brain/index.js';
import type { Context } from '../context.js';
import { EXIT_OK, UsageError } from '../context.js';
import { createRemoteClient } from '../remote/client.js';
import {
  insecureAllowed,
  readCloneRemote,
  resolveToken,
  type CloneRemote,
} from '../remote/config.js';
import { createRemoteEngine, type RemoteEngine } from '../remote/engine.js';
import type { Brain } from '../brain/index.js';
import { cloneConfigSync, configConflictError } from './clone.js';
import type { Command } from './types.js';

const usage = `Usage: somememos config [pull | push]

Show the brain's shared config: its folder roles and the other settings
every copy of a brain shares (half-lives, weights, alpha, burst window,
keyword and analyzer parameters, change-log ops). Only clientId is this
copy's own.

In remote mode (a working folder) it is read from the server. In an offline
copy made with 'somememos clone' it is .somememos/config.json, which
'somememos sync' keeps in step with the server: edit the file, then sync to
send the change; a change made on another device arrives with the next sync.

  pull   Take the server's config here (re-indexes this copy). Use it after
         a sync stopped because the config changed here and elsewhere, to
         drop this copy's change.
  push   Replace the server's config with this copy's. Use it to keep this
         copy's change instead; other devices take it on their next sync.

Notes in a folder that becomes excluded are never deleted: they stay on disk
and on the server, and are no longer indexed, logged or synced.

${GLOBAL_OPTIONS_HELP}

Output: where the config comes from, its revision and whether it is in step,
then the folder roles and settings. With --json: {source: "server"|"copy"|
"local", revision, state, server: {revision} | null, config}. pull and push
print one line; with --json: {status, revision}.

Examples:
  somememos config
  somememos config pull
`;

type State = 'in-step' | 'changed-here' | 'server-changed' | 'both-changed' | 'unknown' | 'local';

interface ConfigRecord {
  source: 'server' | 'copy' | 'local';
  revision: number | null;
  state: State;
  server: { revision: number } | null;
  config: coreSync.SharedConfig;
}

function serverOf(ctx: Context, brain: Brain, remote: CloneRemote): RemoteEngine {
  const token = resolveToken(ctx.env, remote.tokenFile, ctx.cwd);
  return createRemoteEngine(
    createRemoteClient({
      server: remote.server,
      brainId: remote.brainId,
      token,
      clientId: brain.config.clientId,
      allowInsecure: insecureAllowed(ctx.env),
    }),
  );
}

function describe(r: ConfigRecord): string[] {
  const where =
    r.source === 'server'
      ? `the server's shared config, revision ${r.revision}`
      : r.source === 'local'
        ? 'this brain has no server; its config is .somememos/config.json'
        : `this copy's shared config (.somememos/config.json)${r.revision ? `, based on revision ${r.revision}` : ''}`;
  const state: Record<State, string> = {
    'in-step': 'in step with the server',
    'changed-here': 'changed here; somememos sync sends it',
    'server-changed': `the server has a newer one (revision ${r.server?.revision}); somememos sync takes it`,
    'both-changed': `changed here and on the server (revision ${r.server?.revision}): run somememos config pull or push`,
    unknown: 'the server could not be reached to compare',
    local: '',
  };
  const c = r.config;
  const lines = [state[r.state] ? `${where}: ${state[r.state]}` : where, 'folder roles:'];
  const roles = c.roles as Record<string, readonly string[] | undefined>;
  const names = Object.keys(roles).filter((k) => (roles[k] ?? []).length > 0);
  if (names.length === 0) lines.push('  (none: every markdown file is a memo)');
  for (const role of names) lines.push(`  ${role}: ${(roles[role] ?? []).join(', ')}`);
  lines.push(
    `half-lives: ${Object.entries(c.halfLives)
      .map(([k, v]) => `${k} ${v} s`)
      .join(', ')}`,
    `weights: ${Object.entries(c.weights)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}; alpha ${c.alpha}; burst window ${c.burstWindow} s`,
    `change ops: ${c.changeOps.join(', ')}`,
  );
  return lines;
}

async function showCopy(ctx: Context, brain: Brain, json: boolean): Promise<void> {
  const remote = readCloneRemote(brain.root);
  const config = coreSync.sharedConfigOf(brain.config);
  if (!remote) {
    const record: ConfigRecord = {
      source: 'local',
      revision: null,
      state: 'local',
      server: null,
      config,
    };
    emit(ctx, json, record, describe);
    return;
  }
  const state = await coreSync.readSyncState(brain.stores.meta);
  const key = coreSync.sharedConfigKey(brain.config);
  let server: coreSync.ConfigView | null;
  try {
    server = await serverOf(ctx, brain, remote).getConfig();
  } catch {
    server = null;
  }
  const changedHere = state.configKey !== null ? key !== state.configKey : null;
  let s: State;
  if (!server) s = 'unknown';
  else if (coreSync.sharedConfigKey(server.config) === key) s = 'in-step';
  else if (changedHere === false) s = 'server-changed';
  else if (changedHere === true && server.revision === state.configRevision) s = 'changed-here';
  else s = 'both-changed';
  const record: ConfigRecord = {
    source: 'copy',
    revision: state.configRevision || null,
    state: s,
    server: server ? { revision: server.revision } : null,
    config,
  };
  emit(ctx, json, record, describe);
}

export const configCommand: Command = {
  name: 'config',
  summary: "Show the brain's shared config (folder roles); pull or push it in a clone",
  usage,
  async run(args, ctx) {
    const { positionals, globals } = parseCommandArgs(args, {}, { allowPositionals: true });
    if (globals.help) {
      ctx.stdout(usage);
      return EXIT_OK;
    }
    const action = positionals[0];
    if (
      positionals.length > 1 ||
      (action !== undefined && action !== 'pull' && action !== 'push')
    ) {
      throw new UsageError('config takes nothing, pull or push');
    }

    if (action === undefined) {
      const location = locateBrain(ctx, globals.brain);
      if (location.mode === 'remote') {
        return withSession(ctx, brainOptions(globals, { remind: false }), async (session) => {
          const view = await (session.remote as { engine: RemoteEngine }).engine.getConfig();
          const record: ConfigRecord = {
            source: 'server',
            revision: view.revision,
            state: 'in-step',
            server: { revision: view.revision },
            config: view.config,
          };
          emit(ctx, globals.json, record, (r) => {
            const lines = describe(r);
            lines[0] = `the server's shared config, revision ${r.revision}`;
            return lines;
          });
          return EXIT_OK;
        });
      }
      return withBrain(ctx, brainOptions(globals, { remind: false }), async (brain) => {
        await showCopy(ctx, brain, globals.json);
        return EXIT_OK;
      });
    }

    return withBrain(ctx, brainOptions(globals, { remind: false }), async (brain) => {
      const remote = readCloneRemote(brain.root);
      if (!remote) {
        throw new CommandError(
          `config ${action} works in an offline copy made with somememos clone; this brain has no server`,
        );
      }
      const server = serverOf(ctx, brain, remote);
      const shared = cloneConfigSync(brain, server);
      const view = await server.getConfig();
      let step: engine.ConfigStep;
      try {
        step = await engine.resolveConfigConflict(
          shared.io,
          action === 'pull' ? 'theirs' : 'mine',
          view,
        );
      } catch (error) {
        if (error instanceof coreSync.ConfigConflictError) throw configConflictError(error);
        throw error;
      }
      const state = await coreSync.readSyncState(brain.stores.meta);
      const config: storage.BrainConfig = shared.config();
      emit(ctx, globals.json, { status: step, revision: state.configRevision }, (r) =>
        action === 'pull'
          ? `took the server's shared config (revision ${r.revision}) into .somememos/config.json${config === brain.config ? '' : '; re-indexed'}`
          : `the server now has this copy's shared config (revision ${r.revision}); other devices take it on their next sync`,
      );
      return EXIT_OK;
    });
  },
};
