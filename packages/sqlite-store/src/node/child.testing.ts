// Test-only: the Node flags that let a plain `node` child process run this
// workspace's TypeScript sources, on every Node version the CLI supports.
//
// The sources use only erasable TypeScript syntax (`erasableSyntaxOnly` in
// tsconfig.base.json), so Node's type stripping is enough: no transform mode.
// Type stripping is on by default from Node 22.18 (and on 26); on 22.13–22.17
// it needs `--experimental-strip-types`. Chosen by feature detection, not by
// parsing the version.

/** Flags that turn on type stripping in a child of this `node`, if it is not on by default. */
export function typeStrippingFlags(): string[] {
  if (process.features.typescript) return [];
  if (process.allowedNodeEnvironmentFlags.has('--experimental-strip-types')) {
    return ['--experimental-strip-types'];
  }
  throw new Error(`${process.version} cannot run TypeScript sources (no type stripping)`);
}

// Imports written as `./x.js` resolve to `./x.ts`. `module.registerHooks`
// (Node 22.15+) runs the hook in the loading thread, synchronously.
const HOOKS = `
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && specifier.endsWith('.js')) {
        return next(specifier.slice(0, -3) + '.ts', context);
      }
      throw error;
    }
  },
});
`;

/**
 * Flags for a `node` child that loads workspace TypeScript sources: workspace
 * packages resolve to their sources (the "source" export condition), types are
 * stripped, `.js` imports find their `.ts` files, and experimental warnings
 * (node:sqlite's on Node 22, type stripping's on 22.13–22.17) stay quiet.
 */
export function sourceChildFlags(): string[] {
  return [
    '--conditions=source',
    ...typeStrippingFlags(),
    '--disable-warning=ExperimentalWarning',
    `--import=data:text/javascript,${encodeURIComponent(HOOKS)}`,
  ];
}
