import { parseArgs } from 'node:util';
import { VERSION } from '@somememos/core';
import { commands, findCommand } from './commands/index.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, UsageError, processContext } from './context.js';
import type { Context } from './context.js';

export { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, UsageError } from './context.js';
export type { Context } from './context.js';
export type { Command } from './commands/index.js';

export function usage(): string {
  const width = Math.max(4, ...commands.map((command) => command.name.length));
  const list = [
    ...commands.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`),
    `  ${'help'.padEnd(width)}  Show help for a command`,
  ].join('\n');
  return `somememos ${VERSION}: a second brain of markdown notes with time-aware working memory.

Usage:
  somememos <command> [options]
  somememos help <command>

Commands:
${list}

Options:
  -h, --help     Show this help
  -v, --version  Print the version
`;
}

function usageError(ctx: Context, message: string): number {
  ctx.stderr(`somememos: ${message}\nRun 'somememos --help' for usage.\n`);
  return EXIT_USAGE;
}

/** Run the CLI with the arguments after `somememos`. Returns the exit code. */
export async function run(argv: string[], ctx: Context = processContext()): Promise<number> {
  // Global options come before the command; everything after the command
  // name belongs to that command.
  const commandIndex = argv.findIndex((arg) => !arg.startsWith('-'));
  const globalArgs = commandIndex === -1 ? argv : argv.slice(0, commandIndex);

  let values: { help?: boolean; version?: boolean };
  try {
    ({ values } = parseArgs({
      args: globalArgs,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return usageError(ctx, error instanceof Error ? error.message : String(error));
  }

  if (values.version) {
    ctx.stdout(`${VERSION}\n`);
    return EXIT_OK;
  }
  if (values.help || commandIndex === -1) {
    ctx.stdout(usage());
    return EXIT_OK;
  }

  const name = argv[commandIndex] as string;
  const rest = argv.slice(commandIndex + 1);

  if (name === 'help') {
    const topic = rest[0];
    if (topic === undefined) {
      ctx.stdout(usage());
      return EXIT_OK;
    }
    const command = findCommand(topic);
    if (!command) return usageError(ctx, `unknown command '${topic}'`);
    ctx.stdout(command.usage.endsWith('\n') ? command.usage : `${command.usage}\n`);
    return EXIT_OK;
  }

  const command = findCommand(name);
  if (!command) return usageError(ctx, `unknown command '${name}'`);

  try {
    return await command.run(rest, ctx);
  } catch (error) {
    if (error instanceof UsageError || isParseArgsError(error)) {
      return usageError(ctx, `${name}: ${(error as Error).message}`);
    }
    ctx.stderr(`somememos ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_FAILURE;
  }
}

/** `parseArgs` throws TypeErrors with ERR_PARSE_ARGS_* codes on bad options. */
function isParseArgsError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const code: unknown = (error as TypeError & { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_');
}
