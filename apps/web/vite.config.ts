import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { define } from './app-version.ts';

export default defineConfig({
  // SvelteKit 3 takes its configuration here; there is no svelte.config.js.
  plugins: [sveltekit({ adapter: adapter() })],
  define,
});
