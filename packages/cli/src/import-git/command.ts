// `somememos import-git`: the command around `importGitHistory`.

import { existsSync } from 'node:fs';
import { storage } from '@somememos/core';
import {
  GLOBAL_OPTIONS_HELP,
  brainOptions,
  findBrainRoot,
  parseCommandArgs,
  printJson,
  withBrain,
} from '../brain/index.js';
import type { Command } from '../commands/types.js';
import { EXIT_OK, UsageError, type Context } from '../context.js';
import { brainPaths, loadBrainConfig, openBrainStores, type BrainStores } from '../store/index.js';
import { importGitHistory, type ImportGitResult } from './import.js';

const USAGE = `Usage: somememos import-git [options]

Reads the git history of the repository holding the brain, once, and records
it in the event log: an edit event for each commit that changed a memo, a
mention event for each [[link]] a commit added, rename records for renamed
notes, and a change record (with the commit message) for each commit that
touched a note. Events are dated at each commit's author time. Imported ids
come from the commits, so running it again adds nothing. Excluded folders are
never read. Only the first-parent history is walked; changes made on a merged
branch count once, at the merge.

The import stops where live indexing began (the time the brain was first
indexed, when recorded), so no change is counted twice. Scores are folded
afterwards.

Like other commands, it first runs the index pass (unless --no-index or
--dry-run); on a brain never indexed, that pass is the baseline, and the
import stops just before it.

Options:
  --ignore-commit <commit> Skip this commit's events and change record, but still
                           follow its renames. For mass rewrites, such as a folder
                           rename that rewrote links in every note. Repeatable.
  --until <date|commit>    Stop at this point: a date (YYYY-MM-DD, the whole day
                           in UTC, or an ISO date-time), @<unix seconds>, or a commit
  --dry-run                Count what would be imported; write nothing (and
                           skip the index pass)

${GLOBAL_OPTIONS_HELP}

Output lists counts only, never note paths.

Example:
  somememos import-git --brain ~/vault --ignore-commit 3f2a9c1 --dry-run
`;

/** Imports into open stores, then folds: what the command does after its index pass. */
async function importAndFold(options: {
  readonly brainDir: string;
  readonly config: storage.BrainConfig;
  readonly stores: BrainStores | null;
  readonly dryRun: boolean;
  readonly ignoreCommits?: readonly string[];
  readonly until?: string;
  readonly now?: number;
}): Promise<ImportGitCommandResult> {
  const { stores, dryRun } = options;
  const result = await importGitHistory({
    brainDir: options.brainDir,
    config: options.config,
    stores,
    dryRun,
    ...(options.ignoreCommits ? { ignoreCommits: options.ignoreCommits } : {}),
    ...(options.until !== undefined ? { until: options.until } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  let folded: ImportGitCommandResult['folded'] = null;
  if (!dryRun && stores) {
    const f = await storage.foldPending(stores.events, stores.scores, {
      halfLives: options.config.halfLives,
    });
    folded = { events: f.events, renames: f.renames };
  }
  return { ...result, folded };
}

export interface ImportGitCommandResult extends ImportGitResult {
  /** Events and renames folded into scores afterwards; null for a dry run. */
  readonly folded: { readonly events: number; readonly renames: number } | null;
}

interface OpenedBrain {
  readonly config: storage.BrainConfig;
  /** Null for a dry run on a brain whose stores don't exist yet (nothing is created). */
  readonly stores: BrainStores | null;
  close(): Promise<void>;
}

/**
 * Opens the brain for the import. Kept small and separate so the shared
 * brain-context helper can replace it.
 */
function openBrain(brainDir: string, dryRun: boolean): OpenedBrain {
  const config = loadBrainConfig(brainDir);
  const { eventsPath, indexPath } = brainPaths(brainDir);
  const canOpen = !dryRun || (existsSync(eventsPath) && existsSync(indexPath));
  const stores = canOpen ? openBrainStores(brainDir) : null;
  return {
    config,
    stores,
    close: async () => {
      await stores?.close();
    },
  };
}

/**
 * Runs the import and the fold on the brain at `brainDir` (no index pass),
 * and returns the summary. A dry run opens the stores only if they exist.
 */
export async function runImportGit(options: {
  readonly brainDir: string;
  readonly ignoreCommits?: readonly string[];
  readonly until?: string;
  readonly dryRun?: boolean;
  readonly now?: number;
}): Promise<ImportGitCommandResult> {
  const dryRun = options.dryRun ?? false;
  const brain = openBrain(options.brainDir, dryRun);
  try {
    return await importAndFold({ ...options, config: brain.config, stores: brain.stores, dryRun });
  } finally {
    await brain.close();
  }
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function iso(time: number): string {
  return new Date(time * 1000).toISOString().replace('.000Z', 'Z');
}

/** The human summary: counts only. */
export function formatSummary(r: ImportGitCommandResult): string {
  const lines: string[] = [];
  const c = r.commits;
  lines.push(
    `${r.dryRun ? 'Dry run: would import' : 'Imported'} ${plural(c.read - c.afterCutoff, 'commit')}: ` +
      `${c.imported} with notes, ${c.ignored} ignored, ${c.withoutNotes} without notes.`,
  );
  if (r.ignoreNotFound > 0) {
    lines.push(`${plural(r.ignoreNotFound, '--ignore-commit')} not found in the history read.`);
  }
  lines.push(`Events: ${r.events.edit} edit, ${r.events.mention} mention.`);
  lines.push(
    `Renames: ${r.renames.git} from git, ${r.renames.dangling} dangling link${r.renames.dangling === 1 ? '' : 's'} later created.`,
  );
  lines.push(`Change records: ${r.changeRecords}.`);
  if (r.appended && r.duplicates) {
    lines.push(
      `Stored ${r.appended.log} log entries and ${r.appended.changes} change records; ` +
        `skipped ${r.duplicates.log + r.duplicates.changes} already stored.`,
    );
  }
  if (r.folded) lines.push(`Folded ${r.folded.events} events and ${r.folded.renames} renames.`);
  const cutoff =
    r.cutoff.source === 'first-indexed'
      ? `the first index (${iso(r.cutoff.time + 1)})`
      : r.cutoff.source === 'until-date'
        ? `--until (${iso(r.cutoff.time)})`
        : r.cutoff.source === 'until-commit'
          ? '--until commit'
          : 'now';
  lines.push(`History read up to ${cutoff}${c.afterCutoff > 0 ? ', where it stopped' : ''}.`);
  if (r.blobs.skipped > 0) {
    lines.push(`${plural(r.blobs.skipped, 'note version')} too large or binary to read for links.`);
  }
  lines.push(`Took ${(r.elapsedMs / 1000).toFixed(1)} s.`);
  return `${lines.join('\n')}\n`;
}

export const importGitCommand: Command = {
  name: 'import-git',
  summary: 'Import the brain’s git history into the event log, once',
  usage: USAGE,
  async run(args: string[], ctx: Context): Promise<number> {
    const { values, positionals, globals } = parseCommandArgs(
      args,
      {
        'ignore-commit': { type: 'string', multiple: true },
        until: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
      { allowPositionals: true },
    );
    if (globals.help) {
      ctx.stdout(USAGE);
      return EXIT_OK;
    }
    if (positionals.length > 0) throw new UsageError(`unexpected argument '${positionals[0]}'`);
    if (values.until === '') throw new UsageError('--until needs a date or a commit');
    const dryRun = values['dry-run'] ?? false;
    const common = {
      ignoreCommits: values['ignore-commit'] ?? [],
      dryRun,
      ...(values.until !== undefined ? { until: values.until } : {}),
    };
    const print = (result: ImportGitCommandResult): number => {
      if (globals.json) printJson(ctx, result);
      else ctx.stdout(formatSummary(result));
      return EXIT_OK;
    };

    if (dryRun) {
      // Writes nothing: no index pass, and stores are opened only if they exist.
      const brainDir = findBrainRoot(ctx, globals.brain);
      return print(await runImportGit({ brainDir, ...common }));
    }
    return withBrain(ctx, brainOptions(globals), async (brain) =>
      print(
        await importAndFold({
          brainDir: brain.root,
          config: brain.config,
          stores: brain.stores,
          ...common,
        }),
      ),
    );
  },
};
