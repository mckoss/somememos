// The wire shapes of the sync protocol and the change-set route as valibot
// schemas (PLAN.md section 7): one definition each, from which the types in
// ./protocol.ts and ./batch.ts are inferred. The server validates every
// request with them; a copy validates the server's sync response with
// `SyncResponseSchema` (`Engine.applySync`). Isomorphic.
//
// Requests are strict: an unknown field is refused, and every limit in
// `SYNC_LIMITS` is checked here. Responses are lenient (fields a newer server
// adds are ignored) and carry no request limits.
//
// Checks that need more than the value itself stay with their callers: a
// path's role in the brain's config, duplicate ids and paths within a
// request, a time ahead of the receiver's clock, base-hash comparison.
//
// Every message is plain and never repeats the input it refuses, apart from
// the name of an unknown field. `parseWith` reports the first problem only
// (validation stops there), as an issue the caller turns into its own error.

import * as v from 'valibot';
import { CLIENT_ID } from '../storage/config.js';
import { MAX_ID_LENGTH } from '../storage/validate.js';
import { EVENT_KINDS } from '../timescore/kinds.js';
import { MAX_BATCH_OPS } from './batch.js';
import { SYNC_LIMITS, syncPathProblem } from './protocol.js';

// ---------------------------------------------------------------------------
// Checks with their own error codes

/**
 * Tags on the issues of the checks a caller may answer differently (the
 * server gives each its own status or error code): `issue.expected` is one
 * of these.
 */
export const CHECKS = Object.freeze({
  /** Not a syncable note path (`syncPathProblem`). */
  notePath: 'a syncable note path',
  /** A note text over `SYNC_LIMITS.maxNoteBytes`. */
  noteSize: 'a note within the size limit',
  /** A list with more entries than its limit. */
  count: 'a list within its limit',
  /** A message over `SYNC_LIMITS.maxMessageLength`. */
  messageLength: 'a message within the length limit',
  /** A log entry that is invalid as a whole (a rename to its own item). */
  entry: 'a valid log entry',
});

type Problem<T> = (value: T) => string | null;

/** A check that reports `problem`'s message (null: fine), tagged `tag`. */
function check<T>(tag: string, problem: Problem<T>) {
  return v.rawCheck<T>(({ dataset, addIssue }) => {
    if (!dataset.typed) return;
    const message = problem(dataset.value);
    if (message !== null) addIssue({ message, expected: tag });
  });
}

/** Whether `text` is at most `max` bytes as UTF-8, encoding it only when its length can't tell. */
export function fitsUtf8(text: string, max: number): boolean {
  if (text.length > max) return false; // every UTF-16 unit is at least one byte
  if (text.length * 3 <= max) return true; // and at most three
  return new TextEncoder().encode(text).length <= max;
}

// ---------------------------------------------------------------------------
// Fields

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * `schema` (an object or a variant of objects) for JSON objects only:
 * valibot's object schemas take an array as an object too.
 */
export function jsonObject<S extends v.GenericSchema>(schema: S) {
  return v.pipe(
    v.custom<Record<string, unknown>>(isJsonObject, 'must be an object'),
    schema as unknown as v.GenericSchema<Record<string, unknown>, v.InferOutput<S>>,
  );
}

const nonNegative = (what = 'an integer >= 0') =>
  v.pipe(
    v.number(`must be ${what}`),
    v.safeInteger(`must be ${what}`),
    v.minValue(0, `must be ${what}`),
  );

const SHA256 = /^[0-9a-f]{64}$/;
const HASH_MESSAGE = 'must be a SHA-256 hex hash';
/** A content hash: SHA-256, lower-case hex. */
export const HashSchema = v.pipe(v.string(HASH_MESSAGE), v.regex(SHA256, HASH_MESSAGE));

/**
 * A syncable note path (`syncPathProblem`; its issue is tagged
 * `CHECKS.notePath`, also when the field is missing or not a string).
 *
 * It starts from `optional` with a default so that an object runs it on a
 * missing field too (as null, which the path rule refuses); its declared
 * type is a required string, which is what it outputs whenever it passes.
 */
export const NotePathSchema = v.pipe(
  v.optional(v.unknown(), null),
  check<unknown>(CHECKS.notePath, syncPathProblem),
  v.transform((value) => value as string),
) as unknown as v.SchemaWithPipe<
  readonly [v.UnknownSchema, v.RawCheckAction<unknown>, v.TransformAction<unknown, string>]
>;

/** A note's text, at most `SYNC_LIMITS.maxNoteBytes` as UTF-8 (`CHECKS.noteSize`). */
export const NoteTextSchema = v.pipe(
  v.string('must be a string'),
  check<string>(CHECKS.noteSize, (text) =>
    fitsUtf8(text, SYNC_LIMITS.maxNoteBytes)
      ? null
      : `the note is larger than ${SYNC_LIMITS.maxNoteBytes} bytes`,
  ),
);

/** A change message, at most `SYNC_LIMITS.maxMessageLength` characters (`CHECKS.messageLength`). */
export const MessageSchema = v.pipe(
  v.string('must be a string'),
  check<string>(CHECKS.messageLength, (text) =>
    text.length > SYNC_LIMITS.maxMessageLength
      ? `is longer than ${SYNC_LIMITS.maxMessageLength} characters`
      : null,
  ),
);

/** A client id, as `BrainConfig.clientId` allows. */
export const ClientIdSchema = v.pipe(
  v.string('must be a client id'),
  v.regex(CLIENT_ID, 'must be a client id (letters, digits, ".", "_", ":" and "-")'),
);

/**
 * A list checked for its count before its entries (`CHECKS.count`), so an
 * over-long one is refused without looking at them.
 */
function limitedList<T extends v.GenericSchema>(item: T, max: number, what: string, min = 0) {
  return v.pipe(
    v.array(v.unknown(), 'must be an array'),
    check<unknown[]>(CHECKS.count, (list) => (list.length > max ? `at most ${max} ${what}` : null)),
    v.check((list) => list.length >= min, 'must not be empty'),
    v.array(item),
    v.readonly<v.InferOutput<T>[]>(),
  );
}

const list = <T extends v.GenericSchema>(item: T) =>
  v.pipe(v.array(item, 'must be an array'), v.readonly<v.InferOutput<T>[]>());

const nonEmpty = v.pipe(
  v.string('must be a non-empty string'),
  v.minLength(1, 'must be a non-empty string'),
);
const ENTRY_ID = `must be a string of 1 to ${MAX_ID_LENGTH} characters`;
const entryId = v.pipe(
  v.string(ENTRY_ID),
  v.minLength(1, ENTRY_ID),
  v.maxLength(MAX_ID_LENGTH, ENTRY_ID),
);
const UNIX_TIME = 'must be an integer (Unix seconds)';
const unixTime = v.pipe(v.number(UNIX_TIME), v.safeInteger(UNIX_TIME));

// ---------------------------------------------------------------------------
// Log entries and change records

const eventEntries = {
  id: entryId,
  kind: v.picklist(EVENT_KINDS, `must be one of ${EVENT_KINDS.join(', ')} or rename`),
  item: nonEmpty,
  time: unixTime,
  client: nonEmpty,
};
const renameEntries = {
  id: entryId,
  kind: v.literal('rename'),
  item: nonEmpty,
  /** The new item. */
  to: nonEmpty,
  time: unixTime,
  client: nonEmpty,
};
/** A rename record must change its item (`CHECKS.entry`). */
const renameChanges = <T extends { readonly item: string; readonly to: string }>() =>
  check<T>(CHECKS.entry, (e) => (e.to === e.item ? 'a rename must change the item' : null));
const KIND = `must be one of ${EVENT_KINDS.join(', ')} or rename`;
const strictRename = v.strictObject(renameEntries);
const looseRename = v.object(renameEntries);

/** An event or rename record as sync sends it (`storage.LogInput` without `seq`). */
export const SyncEventSchema = jsonObject(
  v.variant(
    'kind',
    [
      v.strictObject(eventEntries),
      v.pipe(strictRename, renameChanges<v.InferOutput<typeof strictRename>>()),
    ],
    KIND,
  ),
);
const responseEvent = jsonObject(
  v.variant(
    'kind',
    [
      v.object(eventEntries),
      v.pipe(looseRename, renameChanges<v.InferOutput<typeof looseRename>>()),
    ],
    KIND,
  ),
);

const changeEntries = <M extends v.GenericSchema<unknown, string>>(message: M) => ({
  id: entryId,
  time: unixTime,
  client: nonEmpty,
  message: v.nullish(message, null),
  op: v.nullish(nonEmpty, null),
  paths: v.optional(list(nonEmpty), []),
});

/** A change record as sync sends it (`storage.ChangeInput`); a request's messages are limited. */
export const SyncChangeSchema = jsonObject(v.strictObject(changeEntries(MessageSchema)));
const responseChange = jsonObject(v.object(changeEntries(v.string('must be a string'))));

// ---------------------------------------------------------------------------
// The sync request

const EDIT_ID = `must be a string of 1 to ${SYNC_LIMITS.maxEditIdLength} characters`;
const editId = v.pipe(
  v.string(EDIT_ID),
  v.minLength(1, EDIT_ID),
  v.maxLength(SYNC_LIMITS.maxEditIdLength, EDIT_ID),
);

/**
 * One note change pushed by an offline copy. Applied by the server only when
 * `baseHash` is the note's current hash there (`null`: the note must not
 * exist; a create). For `rename`, `baseHash` is the hash of `path`, and `to`
 * must not exist.
 */
const syncEditShape = v.variant(
  'op',
  [
    v.strictObject({
      /** Unique within the request; results are matched by it. */
      id: editId,
      op: v.literal('write'),
      path: NotePathSchema,
      /** The hash the edit was made against; null means "create". */
      baseHash: v.nullable(HashSchema),
      /** The note's new text. */
      text: NoteTextSchema,
    }),
    v.strictObject({
      id: editId,
      op: v.literal('delete'),
      path: NotePathSchema,
      baseHash: HashSchema,
    }),
    v.pipe(
      v.strictObject({
        id: editId,
        op: v.literal('rename'),
        path: NotePathSchema,
        /** The new path. */
        to: NotePathSchema,
        baseHash: HashSchema,
      }),
      v.check((e) => e.to !== e.path, 'a rename must change the path'),
    ),
  ],
  'must be "write", "delete" or "rename"',
);
export const SyncEditSchema = jsonObject(syncEditShape);

/** `POST /api/brains/{brain}/sync`. */
const syncRequestShape = v.strictObject({
  /** The last server mutation number this copy has applied (0 for none). */
  since: nonNegative(),
  /** The id of the client sending this (`BrainConfig.clientId`): the author of edits no change record names. */
  client: v.optional(ClientIdSchema),
  /**
   * The shared-config revision this copy has (./config.ts). When given and
   * not the server's, the server applies nothing and answers 409
   * `config-changed` with its config and revision, so no copy pushes or
   * applies notes under roles the brain no longer has. Older copies leave it
   * out and sync as before.
   */
  configRevision: v.optional(nonNegative()),
  /** Log entries this copy logged (or received from elsewhere and has not pushed). */
  events: v.optional(limitedList(SyncEventSchema, SYNC_LIMITS.maxEvents, 'events per request'), []),
  changes: v.optional(
    limitedList(SyncChangeSchema, SYNC_LIMITS.maxChanges, 'changes per request'),
    [],
  ),
  edits: v.optional(limitedList(SyncEditSchema, SYNC_LIMITS.maxEdits, 'edits per request'), []),
});
export const SyncRequestSchema = jsonObject(syncRequestShape);

// ---------------------------------------------------------------------------
// The sync response (lenient: see the top of this file)

const nullableHash = v.optional(v.nullable(HashSchema));

/**
 * - `applied`: stored; `hash` is the note's new hash (absent for a delete).
 * - `duplicate`: the server already holds exactly this result (a retried
 *   request, or the same change made twice); `hash` as for applied.
 * - `conflict`: the note changed on the server since `baseHash`; nothing was
 *   stored. `currentHash`/`currentText` are the server's version of `path`
 *   (null when it has none).
 * - `refused`: the edit is not allowed (`code`, e.g. `source-immutable`);
 *   nothing was stored; current version as for a conflict.
 */
const syncEditResultShape = v.object({
  id: v.string('must be a string'),
  status: v.picklist(['applied', 'duplicate', 'conflict', 'refused']),
  hash: nullableHash,
  currentHash: nullableHash,
  currentText: v.optional(v.nullable(v.string('must be a string'))),
  /** `refused` only. */
  code: v.optional(v.string('must be a string')),
});
export const SyncEditResultSchema = jsonObject(syncEditResultShape);

/**
 * A note's state after the response's window. A rename shows as
 * `{ path: from, renamedTo }` plus the new path's full entry; a receiver may
 * treat `renamedTo` exactly like `deleted`. A copy skips a note whose path
 * it cannot sync or has no role for, so a path need only be a string here.
 */
const syncNoteShape = v.union(
  [
    v.object({ path: v.string(), hash: HashSchema, text: v.string() }),
    v.object({ path: v.string(), deleted: v.literal(true) }),
    v.object({ path: v.string(), renamedTo: v.string() }),
  ],
  'must be a note with a path and a hash and text, deleted: true or renamedTo',
);
export const SyncNoteSchema = jsonObject(syncNoteShape);

const syncResponseShape = v.object({
  /**
   * The server's mutation number this response brings the copy up to: store
   * it as the next `since`. Less than the server's counter while `more`.
   */
  mutation: nonNegative(),
  /** True when more changes remain after `mutation`: repeat the request with it. */
  more: v.optional(v.boolean('must be true or false'), false),
  /** One per pushed edit, in request order. */
  results: v.optional(list(SyncEditResultSchema), []),
  /** Notes changed, deleted or renamed after `since` (through `mutation`), in mutation order. */
  notes: v.optional(list(SyncNoteSchema), []),
  /** Log entries and change records after `since` (through `mutation`), from any client. */
  events: v.optional(list(responseEvent), []),
  changes: v.optional(list(responseChange), []),
});
export const SyncResponseSchema = jsonObject(syncResponseShape);

// ---------------------------------------------------------------------------
// The change-set route and the shared config

/** One op of a change set (`POST /api/brains/{brain}/changes`). */
const batchOpShape = v.variant(
  'op',
  [
    v.strictObject({
      op: v.literal('write'),
      path: NotePathSchema,
      text: NoteTextSchema,
      /** The hash the edit was made against; null: a new note (none may exist). */
      baseHash: v.nullable(HashSchema),
    }),
    v.strictObject({ op: v.literal('delete'), path: NotePathSchema, baseHash: HashSchema }),
    v.strictObject({
      op: v.literal('rename'),
      path: NotePathSchema,
      to: NotePathSchema,
      /** The hash of `path`; `to` must not exist. */
      baseHash: HashSchema,
    }),
  ],
  'must be "write", "delete" or "rename"',
);
export const BatchOpSchema = jsonObject(batchOpShape);

const batchRequestShape = v.strictObject({
  /** The change record's message (the reason); optional. */
  message: v.nullish(MessageSchema),
  ops: limitedList(BatchOpSchema, MAX_BATCH_OPS, 'ops per change set', 1),
});
export const BatchRequestSchema = jsonObject(batchRequestShape);

/**
 * `PUT /api/brains/{brain}/config`. The config itself is checked by
 * `parseBrainConfig` (which reports every problem at once).
 */
const configPutRequestShape = v.strictObject({
  baseRevision: nonNegative(),
  config: v.nonNullish(v.unknown(), 'is required'),
});
export const ConfigPutRequestSchema = jsonObject(configPutRequestShape);

// ---------------------------------------------------------------------------
// Running a schema

/** An issue of a failed check (valibot's). */
export type Issue = v.BaseIssue<unknown>;

const NAMED_LISTS: Readonly<Record<string, string>> = {
  edits: 'edit',
  events: 'event',
  changes: 'change',
  ops: 'op',
  results: 'result',
  notes: 'note',
};

const isUnknownKey = (issue: Issue): boolean =>
  (issue.type === 'strict_object' || issue.type === 'object') && issue.expected === 'never';

/** Where an issue is: `edit 2, to`, `since`, or '' for the whole value. */
export function issueLocation(issue: Issue): string {
  const keys = (issue.path ?? []).map((p) => p.key);
  // An unknown field is reported on the object that has it.
  if (isUnknownKey(issue)) keys.pop();
  const parts: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const next = keys[i + 1];
    if (typeof key === 'string' && typeof next === 'number' && NAMED_LISTS[key]) {
      parts.push(`${NAMED_LISTS[key]} ${next + 1}`);
      i++;
    } else if (typeof key === 'number') {
      parts.push(`entry ${key + 1}`);
    } else {
      parts.push(String(key));
    }
  }
  return parts.join(', ');
}

const TYPE_NAMES: Readonly<Record<string, string>> = {
  Object: 'an object',
  Array: 'an array',
  string: 'a string',
  number: 'a number',
  boolean: 'true or false',
};

/** A plain message for an issue its schema gave none, never naming the refused value. */
function fallbackMessage(issue: Issue): string {
  if (isUnknownKey(issue)) {
    const key = issue.path?.at(-1)?.key;
    return `unknown field ${JSON.stringify(String(key).slice(0, 64))}`;
  }
  // JSON has no undefined: a missing field.
  if (issue.kind === 'schema' && issue.received === 'undefined') return 'is required';
  const expected = issue.expected ?? 'valid';
  return `must be ${TYPE_NAMES[expected] ?? expected.replace(/[()]/g, '').replaceAll(' | ', ' or ')}`;
}

/** An issue's message with its location (`edit 2, to: …`). */
export function issueMessage(issue: Issue, whole = 'the request'): string {
  const where = issueLocation(issue) || whole;
  return `${where}: ${issue.message}`;
}

export type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issue: Issue };

/**
 * Runs `schema` on `input`, stopping at the first problem. The value is a
 * new object, sharing the input's strings (nothing large is copied).
 */
export function parseWith<S extends v.GenericSchema>(
  schema: S,
  input: unknown,
): Parsed<v.InferOutput<S>> {
  const result = v.safeParse(schema, input, { abortEarly: true, message: fallbackMessage });
  if (result.success) return { ok: true, value: result.output };
  return { ok: false, issue: result.issues[0] as Issue };
}
