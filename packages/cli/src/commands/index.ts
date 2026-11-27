import { importGitCommand } from '../import-git/index.js';
import { commitCommand } from './commit.js';
import { diaryCommand } from './diary.js';
import { indexCommand } from './index-command.js';
import { initCommand } from './init.js';
import { statusCommand } from './status.js';
import type { Command } from './types.js';

export type { Command } from './types.js';

/**
 * Every subcommand, in the order `--help` lists them. To add a command, write
 * `src/commands/<name>.ts` exporting a `Command`, then add it here. Parse its
 * arguments with `parseCommandArgs` and run it inside `withBrain` (both from
 * `src/brain`), so the global options and the automatic index pass behave
 * the same everywhere.
 */
export const commands: readonly Command[] = [
  initCommand,
  statusCommand,
  commitCommand,
  diaryCommand,
  indexCommand,
  importGitCommand,
];

export function findCommand(name: string): Command | undefined {
  return commands.find((command) => command.name === name);
}
