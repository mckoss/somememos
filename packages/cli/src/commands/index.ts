import type { Command } from './types.js';

export type { Command } from './types.js';

/**
 * Every subcommand, in the order `--help` lists them. To add a command, write
 * `src/commands/<name>.ts` exporting a `Command`, then add it here.
 */
export const commands: readonly Command[] = [];

export function findCommand(name: string): Command | undefined {
  return commands.find((command) => command.name === name);
}
