import { importGitCommand } from '../import-git/index.js';
import { cloneCommand, syncCommand } from './clone.js';
import { commitCommand } from './commit.js';
import { configCommand } from './config.js';
import { connectCommand } from './connect.js';
import { diaryCommand } from './diary.js';
import { evalCommand } from './eval/command.js';
import { mvCommand, rmCommand } from './files.js';
import { historyCommand, restoreCommand } from './history.js';
import { exportCommand, importLogCommand } from './export.js';
import { indexCommand } from './index-command.js';
import { initCommand } from './init.js';
import { hotCommand, neglectedCommand, trendingCommand } from './lists.js';
import { logCommand } from './log.js';
import { readCommand } from './read.js';
import { searchCommand } from './search.js';
import { statusCommand } from './status.js';
import type { Command } from './types.js';

export type { Command } from './types.js';

/**
 * Every subcommand, in the order `--help` lists them. To add a command, write
 * `src/commands/<name>.ts` exporting a `Command`, then add it here. Parse its
 * arguments with `parseCommandArgs` and run it inside `withSession` (works in
 * local and remote mode) or `withBrain` (local mode only), both from
 * `src/brain`, so the global options, the automatic index pass and the
 * reminder behave the same everywhere.
 */
export const commands: readonly Command[] = [
  searchCommand,
  hotCommand,
  trendingCommand,
  neglectedCommand,
  readCommand,
  commitCommand,
  rmCommand,
  mvCommand,
  logCommand,
  historyCommand,
  restoreCommand,
  diaryCommand,
  statusCommand,
  initCommand,
  connectCommand,
  cloneCommand,
  syncCommand,
  configCommand,
  indexCommand,
  importGitCommand,
  exportCommand,
  importLogCommand,
  evalCommand,
];

export function findCommand(name: string): Command | undefined {
  return commands.find((command) => command.name === name);
}
