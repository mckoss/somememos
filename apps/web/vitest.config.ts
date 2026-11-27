import { defineProject } from 'vitest/config';
import { define } from './app-version.ts';

// Unit tests run without the SvelteKit plugin, which resolves its files from
// the process working directory and so cannot load from the repo root. Add
// `svelte()` from @sveltejs/vite-plugin-svelte here when component tests arrive.
export default defineProject({
  define,
  // Resolve workspace packages to their TypeScript source (the "source" export
  // condition), so tests run from a clean tree without building them first.
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    name: 'web',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
