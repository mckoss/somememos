import { defineConfig } from 'vitest/config';

// `npm test` at the root runs every workspace's tests. Each workspace is a
// Vitest project with its own config (vitest.config.ts, or vite.config.ts for
// apps/web); tests live next to the code as `src/**/*.test.ts`.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    passWithNoTests: true,
  },
});
