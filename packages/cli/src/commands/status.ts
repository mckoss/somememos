// `somememos status`: what the brain holds, what is uncommitted, and the config in effect.

import type { storage } from '@somememos/core';
import {
  GLOBAL_OPTIONS_HELP,
  brainOptions,
  emit,
  parseCommandArgs,
  plural,
  withSession,
} from '../brain/index.js';
import type { Brain, RemoteSession, Session } from '../brain/index.js';
import { EXIT_OK } from '../context.js';
import type { Context } from '../context.js';
import { readCloneRemote } from '../remote/config.js';
import type { FileState } from '../remote/workfolder.js';
import { formatLocalTime } from './log.js';
import type { IndexSummary } from '../indexer/index.js';
import type { Command } from './types.js';

const usage = `Usage: somememos status

Show the brain's state: notes by role, sections, events by kind, change
records, dangling links, notes changed but not yet committed, how far the
event log is folded into scores, and the config in effect (weights,
half-lives, roles). Runs the index pass first, so the counts are current.

${GLOBAL_OPTIONS_HELP}

In remote mode (a working folder) the counts and config are the server's,
and it adds the working folder's state: files edited and not committed, new
files, files whose server version moved on since you read them ('somememos
read' them again), and files deleted locally (which deletes nothing). In a
clone it adds what the next 'somememos sync' would push.

Output: a few labelled lines. With --json: {root, clientId, notes: {total,
memo, dated, source, blog}, sections, dangling, events: {read, edit, mention,
rename}, changes, uncommitted, fold: {cursor, lastSeq}, firstIndexedAt,
config: {weights, alpha, halfLives, burstWindow, roles, analyzer, changeOps},
index}.
Remote mode replaces root with {mode, server, brainId, workFolder} and adds
workingFolder: {edited, new, behind, missing}; a clone adds sync.

Examples:
  somememos status
  somememos status --json
`;

export interface StatusRecord {
  root: string;
  clientId: string;
  notes: { total: number } & Record<storage.NoteRole, number>;
  sections: number;
  dangling: number;
  events: Record<storage.LogKind, number>;
  changes: number;
  uncommitted: string[];
  fold: { cursor: number; lastSeq: number };
  firstIndexedAt: number | null;
  config: {
    weights: storage.BrainConfig['weights'];
    alpha: number;
    halfLives: storage.HalfLives;
    /** The burst rule's window, seconds. */
    burstWindow?: number;
    roles: storage.BrainConfig['roles'];
    analyzer: storage.BrainConfig['analyzer'];
    changeOps: readonly string[];
  };
  index: IndexSummary | null;
}

function duration(seconds: number): string {
  const days = seconds / 86_400;
  if (Number.isInteger(days)) return `${days}d`;
  if (days >= 1) return `${days.toFixed(1)}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function formatStatus(r: StatusRecord): string[] {
  const roles = Object.entries(r.config.roles);
  const lines = [
    `brain: ${r.root}`,
    `notes: ${r.notes.total} (memo ${r.notes.memo}, dated ${r.notes.dated}, source ${r.notes.source}, blog ${r.notes.blog}); ${plural(r.sections, 'section')}; ${plural(r.dangling, 'dangling link target')}`,
    `events: ${r.events.edit} edit, ${r.events.mention} mention, ${r.events.read} read, ${r.events.rename} rename; ${plural(r.changes, 'change record')}`,
    `folded: through ${r.fold.cursor} of ${r.fold.lastSeq}`,
  ];
  if (r.uncommitted.length === 0) lines.push('uncommitted: none');
  else {
    lines.push(
      `uncommitted: ${plural(r.uncommitted.length, 'changed note')} (somememos commit -m "<why>")`,
    );
    for (const p of r.uncommitted) lines.push(`  ${p}`);
  }
  const weights = Object.entries(r.config.weights)
    .map(([k, w]) => `${k} ${w}`)
    .join(', ');
  const halfLives = Object.entries(r.config.halfLives)
    .map(([k, s]) => `${k} ${duration(s)}`)
    .join(', ');
  lines.push(`weights: ${weights}; alpha ${r.config.alpha}`);
  const burst = r.config.burstWindow;
  const burstText =
    burst === undefined ? '' : `; burst window ${burst === 0 ? 'off' : duration(burst)}`;
  lines.push(`half-lives: ${halfLives}${burstText}`);
  lines.push(
    roles.length === 0
      ? 'roles: none declared (every note is a memo)'
      : `roles: ${roles.map(([role, patterns]) => `${role} ${(patterns ?? []).join(' ')}`).join('; ')}`,
  );
  return lines;
}

export const statusCommand: Command = {
  name: 'status',
  summary: 'Show counts, uncommitted changes and the config in effect',
  usage,
  async run(args, ctx) {
    const { globals } = parseCommandArgs(args, {});
    if (globals.help) {
      ctx.stdout(usage);
      return EXIT_OK;
    }
    return withSession(ctx, brainOptions(globals, { remind: false }), async (session) => {
      if (session.remote) return statusRemote(ctx, session.remote, session, globals.json);
      const brain = session.local as Brain;
      const status = await brain.engine.status();
      const record: StatusRecord = {
        root: brain.root,
        ...status,
        notes: { ...status.notes },
        events: { ...status.events },
        fold: { ...status.fold },
        config: { ...status.config },
        index: brain.index,
      };
      const remote = readCloneRemote(brain.root);
      if (remote) {
        const sync = await brain.engine.syncStatus();
        const full: StatusRecord & { sync: object } = {
          ...record,
          sync: { server: remote.server, brainId: remote.brainId, ...sync },
        };
        emit(ctx, globals.json, full, (r) => [
          ...formatStatus(r),
          `sync: brain ${remote.brainId} on ${remote.server}; ${
            sync.lastSyncAt === null
              ? 'never synced'
              : `last synced ${formatLocalTime(sync.lastSyncAt)}`
          }; to push: ${plural(sync.pending.notes, 'note')}, ${plural(sync.pending.events, 'event')}, ${plural(sync.pending.changes, 'change record')} (somememos sync)`,
        ]);
        return EXIT_OK;
      }
      emit(ctx, globals.json, record, formatStatus);
      return EXIT_OK;
    });
  },
};

function formatLines(
  head: string,
  paths: string[],
  show: (p: string) => string,
  hint = '',
): string[] {
  if (paths.length === 0) return [`${head}: none`];
  return [`${head}: ${plural(paths.length, 'note')}${hint}`, ...paths.map((p) => `  ${show(p)}`)];
}

async function statusRemote(
  ctx: Context,
  remote: RemoteSession,
  session: Session,
  json: boolean,
): Promise<number> {
  const status = await remote.engine.status();
  const states: FileState[] = await remote.folder.scan();
  const pending = new Set((await remote.uncommitted()).map((s) => s.path));
  const edited = states.filter((s) => s.kind === 'edited').map((s) => s.path);
  const created = states.filter((s) => s.kind === 'new' && pending.has(s.path)).map((s) => s.path);
  const missing = states.filter((s) => s.kind === 'missing').map((s) => s.path);
  // Which fetched notes moved on at the server (no read is logged).
  const tracked = states.filter((s) => s.kind === 'untouched' || s.kind === 'edited');
  const behind: string[] = [];
  const queue = [...tracked];
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      try {
        const note = await remote.engine.readNote(s.path, { record: false });
        if (note.hash !== s.base) behind.push(s.path);
      } catch {
        behind.push(s.path); // gone or renamed at the server
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker));
  behind.sort();
  const { uncommitted: _serverUncommitted, ...rest } = status;
  const record = {
    mode: 'remote' as const,
    server: remote.target.server,
    brainId: remote.target.brainId,
    workFolder: remote.folder.root,
    ...rest,
    workingFolder: { edited, new: created, behind, missing },
  };
  const show = session.displayPath;
  emit(ctx, json, record, (r) => {
    const local = formatStatus({
      ...r,
      root: '',
      uncommitted: [],
      index: null,
    } as StatusRecord);
    return [
      `brain: ${r.brainId} on ${r.server} (remote)`,
      `working folder: ${r.workFolder}`,
      ...local.slice(1, 4),
      ...formatLines('edited', edited, show, ' not committed (somememos commit -m "<why>")'),
      ...formatLines('new', created, show, ' not committed (somememos commit -m "<why>")'),
      ...formatLines(
        'behind',
        behind,
        show,
        ' changed on the server since you read them (somememos read <path>)',
      ),
      ...(missing.length > 0
        ? formatLines(
            'missing',
            missing,
            show,
            ' deleted here; nothing is deleted on the server (somememos rm <path> deletes)',
          )
        : []),
      ...local.slice(5),
    ];
  });
  return EXIT_OK;
}
