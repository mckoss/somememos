// What every route accepts, as valibot schemas, and how a refused input
// becomes an HTTP error. The sync protocol's shapes (sync, change sets, the
// shared config) are core's (`sync.SyncRequestSchema` and others, shared
// with every client); the rest are the server's own and live here, beside
// the blog settings' schema in ./blog-settings.ts (with the rules it uses).
//
// Errors keep the codes the API has always used:
//
// - a body that is not a JSON object, or has a field it does not know:
//   400 `invalid-request`;
// - a field with a bad value: 400 `invalid-argument` (`invalid-request` on
//   the sync and change-set routes, `invalid-event` for a log entry or
//   change record in a sync request, `invalid-slug` for a blog slug);
// - a bad note path: 400 `invalid-path`; a note over the size limit: 413
//   `too-large`; too many entries in a list: `too-large` (400 on sync, 413
//   on a change set).
//
// What needs the brain (roles and exclusions, duplicate ids and paths,
// clocks, base hashes, name clashes) is checked by each route's handler,
// after its input has passed its schema.

import { type engine as coreEngine, sync } from '@somememos/core';
import * as v from 'valibot';
import { HttpError } from './errors.js';
import { isCommitId } from './git.js';

type Issue = sync.Issue;
/** An error's status and code. */
export type ErrorCode = readonly [status: number, code: string];

/**
 * `schema`'s value for `input`, or an `HttpError` for its first problem,
 * with the status and code `codeOf` gives it and a message that names the
 * field (`edit 2, to: …`) but never repeats the refused value.
 */
export function parseRequest<S extends v.GenericSchema>(
  schema: S,
  input: unknown,
  codeOf: (issue: Issue) => ErrorCode,
  whole = 'the request',
): v.InferOutput<S> {
  const parsed = sync.parseWith(schema, input);
  if (parsed.ok) return parsed.value;
  const [status, code] = codeOf(parsed.issue);
  throw new HttpError(status, code, sync.issueMessage(parsed.issue, whole));
}

/** The issue is about the body as a whole: not an object, or a field it does not know. */
export const aboutTheBody = (issue: Issue): boolean =>
  !issue.path?.length || (issue.expected === 'never' && issue.path.length === 1);

/** The codes of a body or query string whose bad fields are `field`. */
export const fieldCodes =
  (field = 'invalid-argument') =>
  (issue: Issue): ErrorCode => {
    if (issue.expected === sync.CHECKS.notePath) return [400, 'invalid-path'];
    if (issue.expected === sync.CHECKS.noteSize) return [413, 'too-large'];
    if (aboutTheBody(issue)) return [400, 'invalid-request'];
    return [400, field];
  };

/** `POST …/sync` (`sync.SyncRequestSchema`). */
export function syncCodes(issue: Issue): ErrorCode {
  if (issue.expected === sync.CHECKS.notePath) return [400, 'invalid-path'];
  if (issue.expected === sync.CHECKS.noteSize) return [413, 'too-large'];
  if (issue.expected === sync.CHECKS.count) return [400, 'too-large'];
  const keys = (issue.path ?? []).map((p) => p.key);
  const entry = keys[0] === 'events' || keys[0] === 'changes';
  // A log entry or change record whose fields are wrong (not one that is
  // not an object, has an unknown field or an over-long message).
  if (entry && issue.expected === sync.CHECKS.entry) return [400, 'invalid-event'];
  if (
    entry &&
    keys.length >= 3 &&
    issue.expected !== 'never' &&
    issue.expected !== sync.CHECKS.messageLength
  ) {
    return [400, 'invalid-event'];
  }
  return [400, 'invalid-request'];
}

/** `POST …/changes` (`sync.BatchRequestSchema`). */
export function batchCodes(issue: Issue): ErrorCode {
  if (issue.expected === sync.CHECKS.count) return [413, 'too-large'];
  return fieldCodes('invalid-request')(issue);
}

// ---------------------------------------------------------------------------
// Bodies

const optionalMessage = v.nullish(sync.MessageSchema);
const COMMIT = 'must be a commit id';
/** A full git commit id (path parameter or field). */
export const CommitIdSchema = v.pipe(
  v.string(COMMIT),
  v.check((s: string) => isCommitId(s), COMMIT),
);

/** `POST /api/brains`: the id and config are checked by the brain service (`BRAIN_ID`, `parseStoredConfig`). */
export const CreateBrainBody = sync.jsonObject(
  v.strictObject({ id: v.optional(v.unknown()), config: v.optional(v.unknown()) }),
);

/** `PUT …/notes/{path}`. An absent `baseHash` saves whatever is there; null creates. */
export const SaveNoteBody = sync.jsonObject(
  v.strictObject({
    text: sync.NoteTextSchema,
    baseHash: v.optional(v.nullable(sync.HashSchema)),
    message: optionalMessage,
  }),
);

/** `POST …/notes/{path}/restore`. */
export const RestoreBody = sync.jsonObject(
  v.strictObject({
    commit: CommitIdSchema,
    baseHash: v.optional(v.nullable(sync.HashSchema)),
    message: optionalMessage,
  }),
);

/** `POST …/rename`. */
export const RenameBody = sync.jsonObject(
  v.strictObject({
    from: sync.NotePathSchema,
    to: sync.NotePathSchema,
    message: optionalMessage,
  }),
);

/** `POST …/diary`; the date (default today) is checked by the engine. */
export const DiaryBody = sync.jsonObject(v.strictObject({ date: v.nullish(sync.MessageSchema) }));

// `PUT …/config` is core's `sync.ConfigPutRequestSchema`; `PUT …/blog` is
// `BlogSettingsBody` (./blog-settings.ts).

// ---------------------------------------------------------------------------
// Query strings (a parameter given empty counts as not given, except for text)

/**
 * A query string as an object: the first value of each parameter, on an
 * object with no prototype (so no parameter name can mean anything else).
 */
export function queryOf(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [key, value] of params) if (!(key in out)) out[key] = value;
  return out;
}

const blank = (value: string | undefined) => (value === '' ? undefined : value);
const INTEGER = /^-?[0-9]+$/;
const integer = (what = 'an integer') =>
  v.pipe(
    v.optional(v.string()),
    v.transform(blank),
    v.check((s) => s === undefined || INTEGER.test(s), `must be ${what}`),
    v.transform((s) => (s === undefined ? undefined : Number(s))),
    v.check((n) => n === undefined || Number.isSafeInteger(n), `must be ${what}`),
  );
const FLAGS: readonly (string | undefined)[] = [undefined, 'true', '1', 'false', '0'];
const flag = v.pipe(
  v.optional(v.string()),
  v.transform(blank),
  v.check((s) => FLAGS.includes(s), 'must be true or false'),
  v.transform((s) => (s === undefined ? undefined : s === 'true' || s === '1')),
);
const MODES: readonly (string | undefined)[] = [undefined, 'hot', 'trending', 'neglected', 'all'];
const mode = v.pipe(
  v.optional(v.string()),
  v.transform(blank),
  v.check((s) => MODES.includes(s), 'must be hot, trending, neglected or all'),
  v.transform((s) => s as coreEngine.RankMode | undefined),
);
const text = v.optional(v.string());

export const SearchQuery = v.object({
  q: v.optional(v.string(), ''),
  mode,
  limit: integer(),
  since: text,
  until: text,
});
export const ListQuery = v.object({ mode, limit: integer() });
export const LogQuery = v.object({
  path: v.optional(sync.NotePathSchema),
  op: text,
  q: text,
  since: integer(),
  until: integer(),
  limit: integer(),
  all: flag,
});
export const ReadQuery = v.object({ record: flag });
export const DeleteQuery = v.object({ message: v.optional(sync.MessageSchema) });
export const HistoryQuery = v.object({
  limit: v.pipe(
    integer('1 to 1000'),
    v.transform((n) => n ?? 200),
    v.minValue(1, 'must be 1 to 1000'),
    v.maxValue(1000, 'must be 1 to 1000'),
  ),
});
export const VersionQuery = v.object({ hash: sync.HashSchema });
export const DiaryQuery = v.object({ date: text });
export const SlugQuery = v.object({ slug: v.optional(v.string(), '') });
export const AddressQuery = v.object({ path: sync.NotePathSchema });

/** A query string's value (`invalid-argument`, or `invalid-path` for a note path). */
export function parseQuery<S extends v.GenericSchema>(
  schema: S,
  params: URLSearchParams,
): v.InferOutput<S> {
  return parseRequest(schema, queryOf(params), fieldCodes(), 'the query');
}
