import { readFileSync } from 'node:fs';

// The root package.json is the single source of truth for the app version.
// Both vite.config.ts and vitest.config.ts inject it as __APP_VERSION__.
const rootPkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as {
  version: string;
};

export const define = {
  __APP_VERSION__: JSON.stringify(rootPkg.version),
};
