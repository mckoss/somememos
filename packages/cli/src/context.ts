import process from 'node:process';

/** Exit codes used by every command (PLAN.md section 6). */
export const EXIT_OK = 0;
/** The command failed at runtime. */
export const EXIT_FAILURE = 1;
/** Bad usage: unknown command, unknown option or a missing argument. */
export const EXIT_USAGE = 2;

/**
 * What a command may touch from the outside world. Tests pass a fake one, so
 * commands never write to `process.stdout` directly.
 */
export interface Context {
  /** Write to standard output. Include the trailing newline. */
  stdout(text: string): void;
  /** Write to standard error. Include the trailing newline. */
  stderr(text: string): void;
  /** The directory the command runs in. */
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  /**
   * The clock, in whole Unix seconds. Optional so tests can omit it; use
   * `clockOf(ctx)` to read it (defaults to the system clock).
   */
  now?: () => number;
}

export function processContext(): Context {
  return {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    cwd: process.cwd(),
    env: process.env,
  };
}

/** The context's clock, or the system clock: whole Unix seconds. */
export function clockOf(ctx: Context): () => number {
  return ctx.now ?? (() => Math.floor(Date.now() / 1000));
}

/** Raised by a command to report bad usage; `run` prints it and exits 2. */
export class UsageError extends Error {
  override name = 'UsageError';
}
