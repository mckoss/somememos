// Deciding what connecting a device to a server brain does (pure; the
// worker gathers the facts, see ../brain/sync-controller.ts), plus small
// helpers the sync code shares: comparing configs, brain ids from names, and
// reading conflict copy names.
//
// The starting points (PLAN.md section 7):
// - the device has notes, the server has no such brain: create it with the
//   device's folder roles, then upload;
// - the server has the brain, the device is empty: download, taking the
//   server's folder roles;
// - both have notes: combine them (a note that differs is kept twice, the
//   device's copy as a conflict file), only after the person agrees;
// - the device synced with a different brain before: never merge silently.

import type { ConnectKind, ConnectPlan } from './types.ts';

export interface ConnectFacts {
  readonly brainId: string;
  /** The person asked to create the brain. */
  readonly create: boolean;
  /** The server already has a brain with this id (and, then, its mutation counter and config). */
  readonly exists: boolean;
  readonly serverMutation: number;
  /** The server brain's config (everything but the client id), when it exists. */
  readonly serverConfig: Record<string, unknown> | null;
  /** This device's config, without its client id. */
  readonly localConfig: Record<string, unknown>;
  readonly localNotes: number;
  /** True when this device has a sync record (it synced with some brain before). */
  readonly hasSyncState: boolean;
  /** The brain (and origin) this device last connected to, if it remembers one. */
  readonly previous: { readonly brainId: string; readonly origin: string } | null;
  /** The origin the app runs on (the server). */
  readonly origin: string;
}

export class ConnectPlanError extends Error {
  override name = 'ConnectPlanError';
}

/** What connecting would do. Throws `ConnectPlanError` for a request that can't work. */
export function planConnect(facts: ConnectFacts): ConnectPlan {
  if (facts.create && facts.exists) {
    throw new ConnectPlanError(
      `The server already has a brain called “${facts.brainId}”. Pick it from the list instead.`,
    );
  }
  if (!facts.create && !facts.exists) {
    throw new ConnectPlanError(`The server has no brain called “${facts.brainId}”.`);
  }
  const samePlace =
    facts.previous !== null &&
    facts.previous.brainId === facts.brainId &&
    facts.previous.origin === facts.origin;
  // A sync record from another brain (or one this device can't place) must not
  // be carried over silently: its bases would turn into deletes and edits there.
  const differentBrain = facts.hasSyncState && !(samePlace && !facts.create);
  const serverMutation = facts.exists ? facts.serverMutation : 0;
  const local = facts.localNotes;

  let rolesDiffer = false;
  let settingsDiffer = false;
  if (facts.exists && facts.serverConfig) {
    rolesDiffer =
      canonicalJson(facts.serverConfig.roles ?? {}) !==
      canonicalJson(facts.localConfig.roles ?? {});
    const { roles: _a, ...serverRest } = facts.serverConfig;
    const { roles: _b, ...localRest } = facts.localConfig;
    settingsDiffer = canonicalJson(serverRest) !== canonicalJson(localRest);
  }

  let kind: ConnectKind;
  if (facts.create) kind = local > 0 ? 'create-upload' : 'create-empty';
  else if (samePlace && facts.hasSyncState) kind = 'resume';
  else if (serverMutation === 0) kind = local > 0 ? 'upload' : 'empty';
  else kind = local > 0 ? 'merge' : 'download';

  // The server's folder roles replace the device's: worth asking whenever
  // the device has notes they would re-sort.
  const needsConfirmation =
    kind === 'merge' || differentBrain || (rolesDiffer && local > 0 && kind !== 'download');

  return {
    kind,
    brainId: facts.brainId,
    create: facts.create,
    localNotes: local,
    serverMutation,
    rolesDiffer,
    settingsDiffer,
    differentBrain,
    previousBrainId: facts.previous?.brainId ?? null,
    needsConfirmation,
  };
}

/** JSON with object keys sorted at every level, for comparing configs. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** The server's brain id rule (`packages/server`: lower-case letters, digits and dashes). */
export const BRAIN_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A brain id from a name a person typed: "My Notes" → "my-notes". Empty when nothing usable is left. */
export function brainIdFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 63)
    .replace(/-+$/, '');
}

const CONFLICT = /^(.*)\.conflict-([A-Za-z0-9._-]+)-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.md$/i;

/** For a conflict copy's path (`core`'s `sync.conflictPath`), the note it belongs to; else null. */
export function parseConflictPath(
  path: string,
): { original: string; client: string; date: string } | null {
  const m = CONFLICT.exec(path);
  if (!m) return null;
  const stem = m[1] as string;
  if (stem === '' || stem.endsWith('/')) return null;
  return { original: `${stem}.md`, client: m[2] as string, date: m[3] as string };
}

/**
 * Two versions of a note for side-by-side display, from the first line where
 * they differ (with a line of context): `same` lines at the top are left out
 * when there are more than three of them.
 */
export function compareVersions(
  mine: string,
  theirs: string | null,
): { same: number; mine: string; theirs: string | null } {
  if (theirs === null) return { same: 0, mine, theirs };
  const a = mine.split('\n');
  const b = theirs.split('\n');
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  const skip = Math.max(0, common - 1);
  if (skip <= 3) return { same: 0, mine, theirs };
  return { same: skip, mine: a.slice(skip).join('\n'), theirs: b.slice(skip).join('\n') };
}

/** The last four characters of a token, masked: "••••••••cdef". */
export function maskToken(hint: string | null): string {
  return hint ? `••••••••${hint}` : '';
}

/** The person-facing summary of a plan, as short sentences. */
export function describePlan(plan: ConnectPlan): { title: string; details: string[] } {
  const n = plan.localNotes;
  const notes = `${n} ${n === 1 ? 'note' : 'notes'}`;
  const details: string[] = [];
  let title: string;
  switch (plan.kind) {
    case 'create-upload':
      title = `Create “${plan.brainId}” on the server and upload this device’s ${notes}.`;
      details.push('The new brain uses this device’s folder roles.');
      break;
    case 'create-empty':
      title = `Create an empty brain “${plan.brainId}” on the server.`;
      details.push('Notes you write here will sync to it.');
      break;
    case 'upload':
      title = `Upload this device’s ${notes} to “${plan.brainId}”, which is empty.`;
      break;
    case 'download':
      title = `Download “${plan.brainId}” from the server to this device.`;
      details.push('This device takes the brain’s folder roles from the server.');
      break;
    case 'merge':
      title = `Combine this device’s ${notes} with the notes in “${plan.brainId}”.`;
      details.push(
        'Both sets of notes are kept. A note that exists on both sides with different text is kept twice: the server’s version under its own name, and this device’s as a conflict copy (name.conflict-….md) for you to review.',
      );
      details.push(
        'Activity (reads, edits, mentions) from both sides is combined, never counted twice.',
      );
      break;
    case 'empty':
      title = `Connect to “${plan.brainId}”. Neither side has notes yet.`;
      break;
    case 'resume':
      title = `Reconnect to “${plan.brainId}” and carry on where this device left off.`;
      break;
  }
  if (plan.rolesDiffer && !plan.create) {
    details.push(
      'The server’s folder roles are different from this device’s. The server’s replace them, and this device’s notes are re-indexed.',
    );
  } else if (plan.settingsDiffer && !plan.create) {
    details.push(
      'This device takes the brain’s other settings (half-lives, weights) from the server.',
    );
  }
  if (plan.differentBrain) {
    details.push(
      plan.previousBrainId && plan.previousBrainId !== plan.brainId
        ? `This device last synced with “${plan.previousBrainId}”, a different brain. Its notes will be added to “${plan.brainId}”. To keep the two apart, delete everything on this device first (More → Start over), then connect.`
        : 'This device has synced with a server before. That record is cleared, and its notes are compared with this brain afresh.',
    );
  }
  return { title, details };
}
