// Printing: plain text by default, one JSON record with `--json`, warnings and
// errors on stderr. Commands never write to process.stdout directly.

import type { Context } from '../context.js';

/**
 * A runtime failure the user can act on. `run` prints its message as one line
 * on stderr and exits 1, with no stack trace.
 */
export class CommandError extends Error {
  override name = 'CommandError';
}

/** Writes lines of plain text to stdout, each ending in a newline. */
export function printLines(ctx: Context, lines: string | readonly string[]): void {
  const list = typeof lines === 'string' ? [lines] : lines;
  if (list.length > 0) ctx.stdout(`${list.join('\n')}\n`);
}

/** Writes one JSON record to stdout (two-space indent, trailing newline). */
export function printJson(ctx: Context, value: unknown): void {
  ctx.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Prints `record` as JSON when `json` is set, else the plain text `text`
 * returns. The usual last step of a command:
 *
 * ```ts
 * emit(ctx, globals.json, record, () => [`${record.count} notes`]);
 * ```
 */
export function emit<T>(
  ctx: Context,
  json: boolean,
  record: T,
  text: (record: T) => string | readonly string[],
): void {
  if (json) printJson(ctx, record);
  else printLines(ctx, text(record));
}

/** Writes `somememos: warning: <message>` to stderr. */
export function warn(ctx: Context, message: string): void {
  ctx.stderr(`somememos: warning: ${oneLine(message)}\n`);
}

/** Collapses a message to one line (multi-line errors such as ConfigError). */
export function oneLine(message: string): string {
  return message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ');
}

/** `1 note`, `2 notes`. */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}
