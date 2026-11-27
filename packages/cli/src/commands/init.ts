// `somememos init [dir]`: make a directory a brain.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { markdown, storage } from '@somememos/core';
import {
  CommandError,
  GLOBAL_OPTIONS_HELP,
  emit,
  isBrainRoot,
  parseCommandArgs,
  withBrain,
} from '../brain/index.js';
import { EXIT_OK, UsageError } from '../context.js';
import { walkBrain } from '../indexer/index.js';
import { type IndexSummary } from '../indexer/index.js';
import { CONFIG_FILE, SIDECAR_DIR } from '../store/index.js';
import { formatIndexSummary } from './format.js';
import type { Command } from './types.js';

/** The `.gitignore` line that keeps the sidecar databases out of git. */
export const GITIGNORE_LINE = `${SIDECAR_DIR}/*.sqlite*`;

/** Folders a new, empty brain starts with (PLAN.md section 4, "Folder roles"). */
export const DEFAULT_FOLDERS = ['memos', 'diary', 'sources'] as const;

const ROLES_HINT =
  'No folder roles are declared, so every note is a memo. Before the first index, declare roles in ' +
  `${SIDECAR_DIR}/${CONFIG_FILE} if some folders hold diaries, sources or private notes, for example ` +
  '"roles": {"memo": ["memos/"], "dated": ["diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md"], ' +
  '"source": ["sources/"], "excluded": ["private/"]}. Then run \'somememos index\'.';

const usage = `Usage: somememos init [dir]

Make <dir> (default: --brain, else the working directory) a brain: write
${SIDECAR_DIR}/${CONFIG_FILE} with the default settings and a new client id.

- In a directory with no markdown files, also create the folders memos/,
  diary/ and sources/, declare them as the memo, dated and source roles, and
  take the baseline index (so every note written from now on is logged).
- In a directory that already holds markdown files, create no folders and
  declare no roles (every note is a memo), and do not index yet: declare
  roles first, especially "excluded" for private folders, then run
  'somememos index'.
- If the directory is inside a git repository, add '${GITIGNORE_LINE}' to its
  .gitignore (the databases are local; the config can be committed).

Refuses (exit 1) if the directory is already a brain.

${GLOBAL_OPTIONS_HELP}

Examples:
  somememos init
  somememos init ~/brain
  somememos init --json
`;

/** True when `dir` or a folder above it holds `.git`. */
export function insideGitRepository(dir: string): boolean {
  let current = resolve(dir);
  for (;;) {
    if (existsSync(join(current, '.git'))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Ensures `<dir>/.gitignore` has `line`, creating or appending. Returns true
 * when it wrote the line, false when it was already there.
 */
export function ensureGitignoreLine(dir: string, line: string): boolean {
  const path = join(dir, '.gitignore');
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (text.split(/\r?\n/).some((l) => l.trim() === line)) return false;
  const sep = text === '' || text.endsWith('\n') ? '' : '\n';
  writeFileSync(path, `${text}${sep}${line}\n`, 'utf8');
  return true;
}

export interface InitRecord {
  root: string;
  config: string;
  clientId: string;
  roles: markdown.FolderRolesConfig;
  createdFolders: string[];
  gitignore: { path: string; added: boolean } | null;
  index: IndexSummary | null;
  hint: string | null;
}

function formatInit(r: InitRecord): string[] {
  const lines = [`initialized a brain in ${r.root}`, `  config: ${r.config}`];
  if (r.createdFolders.length > 0) {
    lines.push(`  created folders: ${r.createdFolders.map((f) => `${f}/`).join(', ')}`);
  }
  const declared = Object.entries(r.roles);
  lines.push(
    declared.length === 0
      ? '  roles: none declared (every note is a memo)'
      : `  roles: ${declared.map(([role, patterns]) => `${role} ${(patterns ?? []).join(' ')}`).join('; ')}`,
  );
  if (r.gitignore) {
    lines.push(
      r.gitignore.added
        ? `  added '${GITIGNORE_LINE}' to ${r.gitignore.path}`
        : `  ${r.gitignore.path} already ignores '${GITIGNORE_LINE}'`,
    );
  }
  if (r.index) lines.push(`  ${formatIndexSummary(r.index)}`);
  if (r.hint) lines.push(`hint: ${r.hint}`);
  return lines;
}

export const initCommand: Command = {
  name: 'init',
  summary: 'Make a directory a brain (writes .somememos/config.json)',
  usage,
  async run(args, ctx) {
    const { positionals, globals } = parseCommandArgs(args, {}, { allowPositionals: true });
    if (globals.help) {
      ctx.stdout(usage);
      return EXIT_OK;
    }
    if (positionals.length > 1) throw new UsageError('expected at most one directory');
    const root = resolve(ctx.cwd, positionals[0] ?? globals.brain ?? '.');
    if (isBrainRoot(root)) {
      throw new CommandError(
        `${root} is already a brain (${SIDECAR_DIR}/${CONFIG_FILE} exists); nothing changed`,
      );
    }
    mkdirSync(root, { recursive: true });

    const hasMarkdown = walkBrain(root, markdown.createRoleClassifier({})).files.size > 0;
    const clientId = randomUUID();
    const config = hasMarkdown
      ? storage.parseBrainConfig({ clientId })
      : storage.defaultBrainConfig(clientId);

    mkdirSync(join(root, SIDECAR_DIR), { recursive: true });
    const configFile = join(root, SIDECAR_DIR, CONFIG_FILE);
    try {
      writeFileSync(configFile, storage.serializeBrainConfig(config), { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new CommandError(`${root} is already a brain; nothing changed`);
      }
      throw error;
    }

    const createdFolders: string[] = [];
    if (!hasMarkdown) {
      for (const folder of DEFAULT_FOLDERS) {
        if (!existsSync(join(root, folder))) {
          mkdirSync(join(root, folder));
          createdFolders.push(folder);
        }
      }
    }

    let gitignore: InitRecord['gitignore'] = null;
    if (insideGitRepository(root)) {
      gitignore = {
        path: join(root, '.gitignore'),
        added: ensureGitignoreLine(root, GITIGNORE_LINE),
      };
    }

    let index: IndexSummary | null = null;
    if (!hasMarkdown && !globals.noIndex) {
      index = await withBrain(ctx, { brain: root }, (brain) => brain.index);
    }

    const record: InitRecord = {
      root,
      config: configFile,
      clientId,
      roles: config.roles,
      createdFolders,
      gitignore,
      index,
      hint: hasMarkdown ? ROLES_HINT : null,
    };
    emit(ctx, globals.json, record, formatInit);
    return EXIT_OK;
  },
};
