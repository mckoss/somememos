// Input checks and small helpers shared by every storage implementation, so
// that SQLite, Postgres and memory accept and reject exactly the same input.

import { resolveAnalyzerOptions, type AnalyzerOptions } from '../keyword/analyze.js';
import { InvalidEventError, FutureEventError, assertValidEvent } from '../timescore/events.js';
import type { EventKind } from '../timescore/kinds.js';
import type {
  AnalyzerMismatch,
  ChangeInput,
  EventInput,
  HalfLives,
  RenameInput,
  LogInput,
  NoteRecord,
  ScoreOp,
} from './types.js';

/** The longest id accepted for an event, rename or change record. */
export const MAX_ID_LENGTH = 200;

/** The op names the change log recognizes by default (PLAN.md section 4). */
export const DEFAULT_CHANGE_OPS: readonly string[] = Object.freeze([
  'ingest',
  'update',
  'session',
  'query',
  'lint',
]);

/** A new random id (a UUID) for a live event, rename or change record. */
export function newId(): string {
  return globalThis.crypto.randomUUID();
}

/** The current time in whole Unix seconds. */
export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

/** A live event with a new random id, dated now unless `time` is given. */
export function newEvent(fields: {
  readonly kind: EventKind;
  readonly item: string;
  readonly client: string;
  readonly time?: number;
}): EventInput {
  return {
    id: newId(),
    kind: fields.kind,
    item: fields.item,
    time: fields.time ?? unixNow(),
    client: fields.client,
  };
}

/** A rename record with a new random id, dated now unless `time` is given. */
export function newRename(fields: {
  readonly item: string;
  readonly to: string;
  readonly client: string;
  readonly time?: number;
}): RenameInput {
  return {
    id: newId(),
    kind: 'rename',
    item: fields.item,
    to: fields.to,
    time: fields.time ?? unixNow(),
    client: fields.client,
  };
}

/**
 * The operation tag of a commit message: its first word when that word is
 * one of `ops` (compared case-sensitively), else null.
 */
export function changeOp(
  message: string | null | undefined,
  ops: readonly string[] = DEFAULT_CHANGE_OPS,
): string | null {
  if (!message) return null;
  const first = /^\s*(\S+)/.exec(message)?.[1];
  return first !== undefined && ops.includes(first) ? first : null;
}

function nonEmptyString(value: unknown, what: string): void {
  if (typeof value !== 'string' || value === '') {
    throw new InvalidEventError(`${what} must be a non-empty string, not ${JSON.stringify(value)}`);
  }
}

function checkId(id: unknown): void {
  nonEmptyString(id, 'id');
  if ((id as string).length > MAX_ID_LENGTH) {
    throw new InvalidEventError(`id is longer than ${MAX_ID_LENGTH} characters`);
  }
}

function checkTime(time: unknown, now: number): void {
  if (typeof time !== 'number' || !Number.isSafeInteger(time)) {
    throw new InvalidEventError(`time must be an integer (Unix seconds), not ${String(time)}`);
  }
  if (time > now) throw new FutureEventError(time, now);
}

/**
 * Throws `InvalidEventError` or `FutureEventError` unless `entry` is a valid
 * event or rename record at `now`. Events go through `timescore.assertValidEvent`.
 */
export function assertValidLogInput(entry: LogInput, now: number): void {
  if (entry === null || typeof entry !== 'object') {
    throw new InvalidEventError('a log entry must be an object');
  }
  checkId(entry.id);
  nonEmptyString(entry.item, 'item');
  nonEmptyString(entry.client, 'client');
  if (entry.kind === 'rename') {
    nonEmptyString(entry.to, 'rename target');
    if (entry.to === entry.item) {
      throw new InvalidEventError(`a rename must change the item: ${JSON.stringify(entry.item)}`);
    }
    if (!Number.isFinite(now)) throw new InvalidEventError(`now must be finite, not ${now}`);
  } else {
    // Rejects unknown kinds, non-finite times and future events.
    assertValidEvent({ kind: entry.kind, time: entry.time }, now);
  }
  checkTime(entry.time, now);
}

/** Throws unless `change` is a valid change record at `now`. */
export function assertValidChangeInput(change: ChangeInput, now: number): void {
  if (change === null || typeof change !== 'object') {
    throw new InvalidEventError('a change record must be an object');
  }
  checkId(change.id);
  nonEmptyString(change.client, 'client');
  checkTime(change.time, now);
  if (change.message !== null && typeof change.message !== 'string') {
    throw new InvalidEventError('message must be a string or null');
  }
  if (change.op !== null) nonEmptyString(change.op, 'op');
  if (!Array.isArray(change.paths)) throw new InvalidEventError('paths must be an array');
  for (const path of change.paths) nonEmptyString(path, 'path');
}

/** The paths of a change record as stored: deduplicated and sorted. */
export function normalizeChangePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort(compareStrings);
}

/** Throws a RangeError unless `note` is storable. */
export function assertValidNote(note: NoteRecord): void {
  if (typeof note.path !== 'string' || note.path === '') {
    throw new RangeError('note path must be a non-empty string');
  }
  if (typeof note.title !== 'string') throw new RangeError('note title must be a string');
  if (typeof note.contentHash !== 'string' || note.contentHash === '') {
    throw new RangeError('note contentHash must be a non-empty string');
  }
  if (!Number.isSafeInteger(note.mtime)) {
    throw new RangeError(`note mtime must be an integer (Unix seconds), not ${note.mtime}`);
  }
  if (!['memo', 'dated', 'source'].includes(note.role)) {
    throw new RangeError(`note role must be memo, dated or source, not ${String(note.role)}`);
  }
  if (note.date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(note.date)) {
    throw new RangeError(`note date must be YYYY-MM-DD or null, not ${String(note.date)}`);
  }
}

/** Throws a RangeError unless every half-life has a valid name and is finite and > 0. */
export function assertValidHalfLives(halfLives: HalfLives): void {
  const names = Object.keys(halfLives);
  if (names.length === 0) throw new RangeError('at least one half-life is required');
  for (const name of names) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
      throw new RangeError(`half-life name must be lower-case letters, digits, _ or -: ${name}`);
    }
    const h = halfLives[name];
    if (typeof h !== 'number' || !Number.isFinite(h) || !(h > 0)) {
      throw new RangeError(`half-life ${name} must be a finite number of seconds > 0`);
    }
  }
}

/** Whether two half-life tables have the same names and values. */
export function sameHalfLives(a: HalfLives, b: HalfLives): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/** A canonical JSON form of a half-life table (sorted keys), for storage. */
export function halfLivesToJson(halfLives: HalfLives): string {
  const sorted: Record<string, number> = {};
  for (const k of Object.keys(halfLives).sort()) sorted[k] = halfLives[k] as number;
  return JSON.stringify(sorted);
}

/** Throws a RangeError unless `op` is valid for a batch folded with `halfLives`. */
export function assertValidScoreOp(op: ScoreOp, halfLives: HalfLives): void {
  if (op.type === 'add') {
    if (typeof op.item !== 'string' || op.item === '') {
      throw new RangeError('score item must be a non-empty string');
    }
    if (!['read', 'edit', 'mention'].includes(op.kind as EventKind)) {
      throw new RangeError(`unknown event kind ${String(op.kind)}`);
    }
    if (!Object.hasOwn(halfLives, op.halfLife)) {
      throw new RangeError(`unknown half-life ${String(op.halfLife)}`);
    }
    if (typeof op.logScore !== 'number' || !Number.isFinite(op.logScore)) {
      throw new RangeError(`log score must be finite, not ${String(op.logScore)}`);
    }
  } else if (op.type === 'move') {
    if (
      typeof op.from !== 'string' ||
      op.from === '' ||
      typeof op.to !== 'string' ||
      op.to === ''
    ) {
      throw new RangeError('move items must be non-empty strings');
    }
  } else {
    throw new RangeError(`unknown score op ${String((op as { type: unknown }).type)}`);
  }
}

/** Compares strings by UTF-16 code units, as `Array.prototype.sort` does. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The id of a note's section: `<path>#<index>`. Stable across rebuilds. */
export function sectionId(path: string, index: number): string {
  return `${path}#${index}`;
}

/** Splits a section id into its note path and index, or returns null. */
export function parseSectionId(id: string): { path: string; index: number } | null {
  const at = id.lastIndexOf('#');
  if (at <= 0) return null;
  const index = Number(id.slice(at + 1));
  if (!Number.isSafeInteger(index) || index < 0 || String(index) !== id.slice(at + 1)) return null;
  return { path: id.slice(0, at), index };
}

/** `null` when `requested` resolves to `stored`, else both. */
export function compareAnalyzers(
  stored: AnalyzerOptions,
  requested?: Partial<AnalyzerOptions>,
): AnalyzerMismatch | null {
  const resolved = resolveAnalyzerOptions(requested);
  return resolved.stem === stored.stem ? null : { stored, requested: resolved };
}

/** Parses analyzer options stored as JSON; throws on anything else. */
export function analyzerFromJson(json: string): AnalyzerOptions {
  const parsed: unknown = JSON.parse(json);
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as { stem?: unknown }).stem !== 'boolean'
  ) {
    throw new RangeError(`stored analyzer options are invalid: ${json}`);
  }
  return resolveAnalyzerOptions(parsed as AnalyzerOptions);
}

/** The canonical JSON form of analyzer options, for storage. */
export function analyzerToJson(options: AnalyzerOptions): string {
  return JSON.stringify({ stem: options.stem });
}
