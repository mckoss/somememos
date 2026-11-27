import type { Context } from '../context.js';

/**
 * One subcommand of `somememos`. Each lives in its own module under
 * `src/commands/` and is registered in `src/commands/index.ts`.
 */
export interface Command {
  /** The word typed after `somememos`, e.g. `search`. */
  name: string;
  /** One line for the command list in `somememos --help`. */
  summary: string;
  /** Full help text for `somememos <name> --help` and `somememos help <name>`. */
  usage: string;
  /**
   * Run the command with the arguments after its name. Parse them with
   * `node:util` `parseArgs`. Return an exit code (0, 1 or 2), or throw a
   * `UsageError` for bad usage.
   */
  run(args: string[], ctx: Context): Promise<number> | number;
}
