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
}

export function processContext(): Context {
  return {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    cwd: process.cwd(),
    env: process.env,
  };
}

/** Raised by a command to report bad usage; `run` prints it and exits 2. */
export class UsageError extends Error {
  override name = 'UsageError';
}
