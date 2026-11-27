import { defineProject } from 'vitest/config';

export default defineProject({
  // Resolve workspace packages to their TypeScript source (the "source" export
  // condition), so tests run without building them first.
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    name: 'sqlite-store',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
