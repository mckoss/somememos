// `somememos connect <server-url> <brain-id> [dir]`: make a folder a remote
// working folder (PLAN.md section 6, "Two modes, one flow"). Writes
// `.somememos/config.json` with the server, the brain and a new client id,
// never the token, after checking that the server answers and accepts the
// token.

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { VERSION } from '@somememos/core';
import { CommandError, GLOBAL_OPTIONS_HELP, emit, parseCommandArgs } from '../brain/index.js';
import type { Context } from '../context.js';
import { EXIT_OK, UsageError } from '../context.js';
import { walkMarkdown } from '../indexer/walk.js';
import { type RemoteClient, createRemoteClient } from '../remote/client.js';
import {
  ENV,
  checkBrainId,
  checkDeviceName,
  checkServerTransport,
  checkTokenFile,
  insecureAllowed,
  normalizeServerUrl,
  resolveToken,
  sidecarKind,
  writeWorkFolderConfig,
} from '../remote/config.js';
import { createRemoteEngine, type RemoteBrainInfo } from '../remote/engine.js';
import { insideGitRepository } from './init.js';
import type { Command } from './types.js';

const usage = `Usage: somememos connect <server-url> <brain-id> [dir] [--token-file <path>]

Make <dir> (default: the working directory) a working folder for the brain
<brain-id> on the server: every command run there is then a request to the
server, and the folder holds only the notes you read ('somememos read'), for
you to edit and send back ('somememos commit').

Writes .somememos/config.json with the server URL, the brain id and a new
client id. The token is never written: it comes from ${ENV.token}, or from
--token-file <path> (a file outside the folder holding only the token, whose
path is recorded). Before writing anything, connect checks that the server
answers and accepts the token. Refuses a folder that is already a brain or a
working folder, or that holds markdown files. Inside a git repository it adds
a .gitignore that keeps the folder's notes out of git.

With no files at all, setting ${ENV.server}, ${ENV.brainId} and ${ENV.token}
does the same (see 'somememos help setup').

Options:
  --token-file <path>  Read the token from this file (outside <dir>)
  --allow-insecure     Allow a plain http:// server on another host (trusted
                       networks only: the token travels unencrypted)
  --name <device-name> This folder's client id, shown in history and as the
                       commit author (1-40 letters, digits, '.', '_' or '-';
                       default: a random id). Give each device its own.

${GLOBAL_OPTIONS_HELP}

Output: what was set up and what to do next. With --json: {root, config,
server, brainId, clientId, serverVersion, tokenFile, gitignore}.

Examples:
  export ${ENV.token}=…
  somememos connect https://brain.example.com garden ~/garden
`;

/** Checks the server's health and that the token opens the brain. */
export async function checkServer(
  client: RemoteClient,
): Promise<{ version: string; brain: RemoteBrainInfo }> {
  const health = await client.request<{ version?: unknown; status?: unknown }>('GET', 'health', {
    anonymous: true,
  });
  const version = typeof health.version === 'string' ? health.version : 'unknown';
  if (health.status !== undefined && health.status !== 'ok') {
    throw new CommandError(`the server is not ready (status ${String(health.status)})`);
  }
  const brain = await createRemoteEngine(client).brainInfo();
  return { version, brain };
}

export interface ConnectRecord {
  root: string;
  config: string;
  server: string;
  brainId: string;
  clientId: string;
  serverVersion: string;
  tokenFile: string | null;
  gitignore: string | null;
}

/** The checks shared by connect and clone: arguments, token, server, brain. */
export async function prepareRemote(
  ctx: Context,
  positionals: string[],
  tokenFileOption: string | undefined,
  defaultDir: (brainId: string) => string,
  options: { readonly allowInsecure?: boolean; readonly name?: string | undefined } = {},
) {
  const allowInsecure = options.allowInsecure ?? false;
  if (positionals.length < 2 || positionals.length > 3) {
    throw new UsageError('give the server URL, the brain id and, optionally, a directory');
  }
  const server = normalizeServerUrl(positionals[0] as string);
  const insecure = insecureAllowed(ctx.env, allowInsecure);
  checkServerTransport(server, insecure);
  const brainId = checkBrainId(positionals[1] as string);
  const root = resolve(ctx.cwd, positionals[2] ?? defaultDir(brainId));
  const tokenFile =
    tokenFileOption === undefined ? null : checkTokenFile(ctx.cwd, tokenFileOption, root);
  const token = resolveToken(ctx.env, tokenFile, ctx.cwd);
  const clientId = options.name === undefined ? randomUUID() : checkDeviceName(options.name, token);
  const client = createRemoteClient({
    server,
    brainId,
    token,
    clientId,
    allowInsecure: insecure,
  });
  const checked = await checkServer(client);
  return { server, brainId, root, tokenFile, clientId, client, ...checked };
}

export const connectCommand: Command = {
  name: 'connect',
  summary: 'Make a folder a working folder for a brain on a server',
  usage,
  async run(args, ctx) {
    const { values, positionals, globals } = parseCommandArgs(
      args,
      {
        'token-file': { type: 'string' },
        'allow-insecure': { type: 'boolean' },
        name: { type: 'string' },
      },
      { allowPositionals: true },
    );
    if (globals.help) {
      ctx.stdout(usage);
      return EXIT_OK;
    }
    if (values.name !== undefined) checkDeviceName(values.name);
    if (positionals[0] !== undefined) {
      checkServerTransport(
        normalizeServerUrl(positionals[0]),
        insecureAllowed(ctx.env, values['allow-insecure'] === true),
      );
    }
    const target = positionals[2] ?? '.';
    const dir = resolve(ctx.cwd, target);
    if (sidecarKind(dir).kind !== 'none') {
      throw new CommandError(`${dir} is already a brain or a working folder; nothing changed`);
    }
    if (walkMarkdown(dir).length > 0) {
      throw new CommandError(
        `${dir} holds markdown files, which commit would send as new notes; connect an empty folder`,
      );
    }
    const prepared = await prepareRemote(ctx, positionals, values['token-file'], () => '.', {
      allowInsecure: values['allow-insecure'] === true,
      name: values.name,
    });
    mkdirSync(prepared.root, { recursive: true });
    const config = writeWorkFolderConfig(prepared.root, {
      mode: 'remote',
      server: prepared.server,
      brainId: prepared.brainId,
      clientId: prepared.clientId,
      tokenFile: prepared.tokenFile,
    });
    let gitignore: string | null = null;
    if (insideGitRepository(prepared.root)) {
      const path = join(prepared.root, '.gitignore');
      try {
        writeFileSync(
          path,
          '# A somememos working folder: the notes are private; keep them out of git.\n*\n',
          { flag: 'wx' },
        );
        gitignore = path;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const record: ConnectRecord = {
      root: prepared.root,
      config,
      server: prepared.server,
      brainId: prepared.brainId,
      clientId: prepared.clientId,
      serverVersion: prepared.version,
      tokenFile: prepared.tokenFile,
      gitignore,
    };
    emit(ctx, globals.json, record, (r) => [
      `connected ${r.root} to brain ${r.brainId} on ${r.server} (server ${r.serverVersion}${r.serverVersion !== VERSION ? `, this CLI ${VERSION}` : ''})`,
      `  config: ${r.config} (no token stored; it comes from ${r.tokenFile ?? `$${ENV.token}`})`,
      ...(r.gitignore ? [`  added ${r.gitignore} so git ignores the notes here`] : []),
      `next: cd ${r.root}; somememos hot; somememos search <words>; somememos read <path>; edit; somememos commit -m "<why>"`,
    ]);
    return EXIT_OK;
  },
};
