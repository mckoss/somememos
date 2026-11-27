import { VERSION } from '@somememos/core';
import { AGENTS_GUIDE, SETUP_GUIDE } from './commands/agents.js';
import { commands, findCommand } from './commands/index.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, UsageError, processContext } from './context.js';
import type { Context } from './context.js';
import { oneLine } from './brain/output.js';

export { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, UsageError } from './context.js';
export type { Context } from './context.js';
export type { Command } from './commands/index.js';

export function usage(): string {
  const width = Math.max(4, ...commands.map((command) => command.name.length));
  const list = [
    ...commands.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`),
    `  ${'help'.padEnd(width)}  Show help for a command; 'help agents', 'help setup' for the guides`,
  ].join('\n');
  return `somememos ${VERSION}: a second brain of markdown notes with time-aware working memory.

Usage:
  somememos <command> [options]
  somememos help <command>
  somememos help agents    The search, read, edit, commit flow for AI agents
  somememos help setup     Using a brain on a server from a new machine or cloud session

Commands:
${list}

Options:
  -h, --help     Show this help (with a command: that command's help)
  -v, --version  Print the version

Global options (before or after the command):
  --brain <dir>  Use the brain at <dir> (default: $SOMEMEMOS_BRAIN, else the
                 nearest folder at or above the working directory holding
                 .somememos/config.json, else remote mode when
                 SOMEMEMOS_SERVER, SOMEMEMOS_BRAIN_ID and SOMEMEMOS_TOKEN
                 are set)
  --no-index     Skip the automatic index pass that commands run first
  --json         Print one JSON record instead of plain text

Exit codes: 0 success, 1 error, 2 bad usage. Set SOMEMEMOS_DEBUG=1 for stack
traces on errors.
`;
}

function usageError(ctx: Context, message: string): number {
  ctx.stderr(`somememos: ${message}\nRun 'somememos --help' for usage.\n`);
  return EXIT_USAGE;
}

/** Global options that take a value, and global flags, accepted before the command name. */
const GLOBAL_VALUE_OPTIONS = new Set(['--brain']);
const GLOBAL_FLAGS = new Set(['--json', '--no-index']);

/**
 * Splits `argv` into the options before the command, the command name and
 * its arguments. Global options before the command (`--brain`, `--json`,
 * `--no-index`) are forwarded to the command, which parses them with its own
 * options (`parseCommandArgs`), so they work on either side of its name.
 */
function splitArgs(
  argv: string[],
):
  | { help: boolean; version: boolean; forwarded: string[]; name?: string; rest: string[] }
  | { error: string } {
  let help = false;
  let version = false;
  const forwarded: string[] = [];
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('-')) break;
    if (arg === '-h' || arg === '--help') help = true;
    else if (arg === '-v' || arg === '--version') version = true;
    else if (GLOBAL_FLAGS.has(arg)) forwarded.push(arg);
    else if (GLOBAL_VALUE_OPTIONS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) return { error: `option '${arg} <value>' argument missing` };
      forwarded.push(arg, value);
      i++;
    } else if ([...GLOBAL_VALUE_OPTIONS].some((o) => arg.startsWith(`${o}=`))) forwarded.push(arg);
    else return { error: `unknown option '${arg}'` };
  }
  const name = argv[i];
  return name === undefined
    ? { help, version, forwarded, rest: [] }
    : { help, version, forwarded, name, rest: argv.slice(i + 1) };
}

/** Run the CLI with the arguments after `somememos`. Returns the exit code. */
export async function run(argv: string[], ctx: Context = processContext()): Promise<number> {
  const split = splitArgs(argv);
  if ('error' in split) return usageError(ctx, split.error);

  if (split.version) {
    ctx.stdout(`${VERSION}\n`);
    return EXIT_OK;
  }
  if (split.name === undefined) {
    ctx.stdout(usage());
    return EXIT_OK;
  }

  const name = split.name;
  const rest = split.rest;

  if (name === 'help') {
    const topic = rest[0];
    if (topic === undefined) {
      ctx.stdout(usage());
      return EXIT_OK;
    }
    if (topic === 'agents') {
      ctx.stdout(AGENTS_GUIDE);
      return EXIT_OK;
    }
    if (topic === 'setup') {
      ctx.stdout(SETUP_GUIDE);
      return EXIT_OK;
    }
    const command = findCommand(topic);
    if (!command) return usageError(ctx, `unknown command '${topic}'`);
    ctx.stdout(command.usage.endsWith('\n') ? command.usage : `${command.usage}\n`);
    return EXIT_OK;
  }

  const command = findCommand(name);
  if (!command) return usageError(ctx, `unknown command '${name}'`);
  if (split.help) {
    ctx.stdout(command.usage.endsWith('\n') ? command.usage : `${command.usage}\n`);
    return EXIT_OK;
  }

  try {
    return await command.run([...split.forwarded, ...rest], ctx);
  } catch (error) {
    if (error instanceof UsageError || isParseArgsError(error)) {
      return usageError(ctx, `${name}: ${(error as Error).message}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr(`somememos ${name}: ${oneLine(message)}\n`);
    if (ctx.env.SOMEMEMOS_DEBUG && error instanceof Error && error.stack) {
      ctx.stderr(`${error.stack}\n`);
    }
    return EXIT_FAILURE;
  }
}

/** `parseArgs` throws TypeErrors with ERR_PARSE_ARGS_* codes on bad options. */
function isParseArgsError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const code: unknown = (error as TypeError & { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_');
}
