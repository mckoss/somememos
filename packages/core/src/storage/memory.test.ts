import { describeStorageConformance } from './conformance.testing.js';
import { createMemoryStores, type MemoryStores } from './memory.js';

describeStorageConformance('memory', () => ({
  open: (options) => createMemoryStores(options),
  reopen: (stores, options) =>
    createMemoryStores({ ...options, data: (stores as MemoryStores).data }),
}));
