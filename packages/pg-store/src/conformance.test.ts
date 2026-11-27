// Both shared conformance suites (storage and engine) against Postgres, each
// test in a fresh brain. The "beside another brain" runs keep a second brain
// in the same tables, filled with overlapping ids, paths and terms, and check
// after every test that it is unchanged: any query that forgot its brain id
// would change the suite's exact expectations, or the other brain.

import type { storage } from '@somememos/core';
import { describeEngineConformance } from '@somememos/core/testing/engine';
import { describeStorageConformance } from '@somememos/core/testing/storage';
import type pg from 'pg';
import { expect } from 'vitest';
import { createPgContentStore, createPgStores, type PgStores } from './stores.js';
import {
  TEST_DATABASE_URL,
  deleteBrain,
  describePg,
  newBrainId,
  populateNoiseBrain,
  snapshotBrain,
  testPool,
  warnIfSkipped,
} from './test-db.testing.js';

warnIfSkipped();

function storageHarness(withNeighbour: boolean) {
  return async () => {
    const pool = await testPool();
    const brains: string[] = [];
    let neighbour: { id: string; snapshot: string } | undefined;
    if (withNeighbour) {
      const id = newBrainId('neighbour');
      brains.push(id);
      neighbour = { id, snapshot: await populateNoiseBrain(pool, id) };
    }
    return {
      async open(options?: storage.StoresOptions) {
        const brainId = newBrainId();
        brains.push(brainId);
        return createPgStores({ ...options, pool, brainId });
      },
      reopen(stores: storage.Stores, options?: storage.StoresOptions) {
        return createPgStores({ ...options, pool, brainId: (stores as PgStores).brainId });
      },
      async dispose() {
        try {
          if (neighbour) {
            expect(await snapshotBrain(pool, neighbour.id)).toBe(neighbour.snapshot);
          }
        } finally {
          for (const id of brains.splice(0)) await deleteBrain(pool, id);
        }
      },
    };
  };
}

function engineFactory(withNeighbour: boolean) {
  return async ({ now, analyzer }: storage.StoresOptions & { readonly now: () => number }) => {
    const pool: pg.Pool = await testPool();
    const brainId = newBrainId();
    const neighbourId = newBrainId('neighbour');
    const snapshot = withNeighbour ? await populateNoiseBrain(pool, neighbourId) : undefined;
    const stores = await createPgStores({ pool, brainId, now, ...(analyzer ? { analyzer } : {}) });
    return {
      stores,
      content: await createPgContentStore({ pool, brainId, now }),
      async dispose() {
        try {
          if (snapshot !== undefined) expect(await snapshotBrain(pool, neighbourId)).toBe(snapshot);
        } finally {
          await deleteBrain(pool, brainId);
          if (snapshot !== undefined) await deleteBrain(pool, neighbourId);
        }
      },
    };
  };
}

if (TEST_DATABASE_URL) {
  describeStorageConformance('postgres', storageHarness(false));
  describeStorageConformance('postgres, beside another brain', storageHarness(true), {
    numRuns: 10,
  });
  describeEngineConformance('postgres, content table', engineFactory(false));
  describeEngineConformance('postgres, beside another brain', engineFactory(true), {
    seeds: [3],
  });
} else {
  describePg('storage and engine conformance: postgres', () => {});
}
