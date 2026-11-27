// Argument parsing shared by every command: the global options, merged into
// each command's own options so they work before or after the command name.

import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

/** Options every command accepts. `run` forwards them when they come before the command. */
export const GLOBAL_OPTIONS = {
  brain: { type: 'string' },
  'no-index': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies ParseArgsOptionsConfig;

/** The usage lines for the global options, for each command's help text. */
export const GLOBAL_OPTIONS_HELP = `Global options:
  --brain <dir>  Use the brain at <dir> (default: $SOMEMEMOS_BRAIN, else the
                 nearest folder at or above the working directory that holds
                 .somememos/config.json)
  --no-index     Skip the automatic index pass before the command
  --json         Print one JSON record instead of plain text
  -h, --help     Show this help`;

export interface GlobalOptions {
  /** `--brain`, if given. */
  readonly brain?: string;
  /** `--no-index`. */
  readonly noIndex: boolean;
  /** `--json`. */
  readonly json: boolean;
  /** `--help`. */
  readonly help: boolean;
}

/**
 * Parses a command's arguments with `node:util` `parseArgs` (strict), adding
 * the global options. Throws parseArgs's own errors on bad usage, which `run`
 * reports with exit code 2.
 *
 * ```ts
 * const { values, positionals, globals } = parseCommandArgs(args, {
 *   limit: { type: 'string', short: 'n' },
 * }, { allowPositionals: true });
 * if (globals.help) { ctx.stdout(usage); return EXIT_OK; }
 * ```
 */
export function parseCommandArgs<const O extends ParseArgsOptionsConfig>(
  args: readonly string[],
  options: O,
  config: { readonly allowPositionals?: boolean } = {},
) {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { ...GLOBAL_OPTIONS, ...options },
    strict: true,
    allowPositionals: config.allowPositionals ?? false,
  });
  const v = values as {
    brain?: string;
    'no-index'?: boolean;
    json?: boolean;
    help?: boolean;
  };
  const globals: GlobalOptions = {
    ...(v.brain === undefined ? {} : { brain: v.brain }),
    noIndex: v['no-index'] ?? false,
    json: v.json ?? false,
    help: v.help ?? false,
  };
  return { values, positionals, globals };
}
