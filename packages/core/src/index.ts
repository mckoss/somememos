// Public entry point of @somememos/core. This package is isomorphic: it runs in
// Node and in the browser, so it must never import a Node-only module.
export { VERSION } from './version.js';

// Each area is exported as a namespace, because their type names overlap
// (for example, both `markdown` and `keyword` have a `Section`).
export * as timescore from './timescore/index.js';
export * as keyword from './keyword/index.js';
export * as markdown from './markdown/index.js';
export * as storage from './storage/index.js';
export * as ranking from './ranking/index.js';
export * as evaluation from './evaluation/index.js';
export * as indexing from './indexing/index.js';
export * as engine from './engine/index.js';
