// The `brains` table: one row per brain, holding its sequence counters.

import { type Queryable, query } from './db.js';

/** Creates the brain's rows if they are missing (its `brains` and `index_state` rows). */
export async function ensureBrain(q: Queryable, brainId: string, now: number): Promise<void> {
  if (typeof brainId !== 'string' || brainId === '') {
    throw new RangeError('brainId must be a non-empty string');
  }
  await query(
    q,
    `INSERT INTO brains (brain_id, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [brainId, now],
  );
  await query(q, `INSERT INTO index_state (brain_id) VALUES ($1) ON CONFLICT DO NOTHING`, [
    brainId,
  ]);
}

/** The brains stored, sorted by id. */
export async function listBrains(q: Queryable): Promise<{ id: string; createdAt: number }[]> {
  const { rows } = await query<{ brain_id: string; created_at: number }>(
    q,
    `SELECT brain_id, created_at FROM brains ORDER BY brain_id`,
  );
  return rows.map((r) => ({ id: r.brain_id, createdAt: r.created_at }));
}

/** The brain's mutation counter (PLAN.md section 7); 0 before the first mutation. */
export async function mutationSeq(q: Queryable, brainId: string): Promise<number> {
  const { rows } = await query<{ mutation_seq: number }>(
    q,
    `SELECT mutation_seq FROM brains WHERE brain_id = $1`,
    [brainId],
  );
  if (!rows[0]) throw new RangeError(`no such brain: ${brainId}`);
  return rows[0].mutation_seq;
}

/**
 * Advances the brain's mutation counter by `n` (default 1) and returns the
 * new value; the numbers `value - n + 1 … value` belong to the caller. Call
 * it inside the transaction that makes the change: the brain row stays
 * locked until that transaction ends, so numbers are handed out in commit
 * order and a reader never sees a number before every smaller one.
 */
export async function advanceMutationSeq(q: Queryable, brainId: string, n = 1): Promise<number> {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError('n must be a positive integer');
  const { rows } = await query<{ seq: number | null }>(
    q,
    `SELECT somememos_advance_mutation_seq($1, $2) AS seq`,
    [brainId, n],
  );
  const seq = rows[0]?.seq;
  if (seq === null || seq === undefined) throw new RangeError(`no such brain: ${brainId}`);
  return seq;
}
