// Test-only helpers shared by every package and by browser tests: the seeded
// synthetic brain generator (invented data only) and its PRNG. Pure and
// isomorphic. Exported as `@somememos/core/testing/brain` under the `source`
// condition only; not part of the built `dist`. Writing a brain to disk or to
// a git repository is Node-side (packages/cli/src/testing/materialize.ts).

export * from './brain.js';
export { createRng, type Rng } from './prng.js';
