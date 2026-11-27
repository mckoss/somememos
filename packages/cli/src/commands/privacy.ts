// Where private brain data may be written (AGENTS.md, first ground rule;
// PLAN.md section 5, "Privacy"). The somememos repository is public, so an
// event log export, evaluation cases and per-case results must never land in
// a checkout of it.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CommandError } from '../brain/index.js';

/** The `name` in the root `package.json` of a somememos source checkout. */
export const SOURCE_PACKAGE_NAME = 'somememos';

/**
 * The root of the somememos source checkout that holds `path` (a file or
 * directory, existing or not): the nearest folder at or above it with a
 * `package.json` whose name is `somememos`. Null when there is none.
 */
export function findSourceCheckout(path: string): string | null {
  let dir = resolve(path);
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: unknown;
      };
      if (pkg.name === SOURCE_PACKAGE_NAME) return dir;
    } catch {
      // No package.json here, or not JSON: keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Throws a `CommandError` (exit 1) when `path` is inside a somememos source
 * checkout. `what` names the data, for the message ("per-case detail").
 */
export function refuseSourceCheckout(path: string, what: string): void {
  const checkout = findSourceCheckout(path);
  if (checkout !== null) {
    throw new CommandError(
      `refusing to write ${what} inside the somememos source checkout at ${checkout}: brain data is private and that repository is public. Run somememos in the brain's own directory.`,
    );
  }
}
