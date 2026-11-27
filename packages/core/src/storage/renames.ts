// Where an event lands after rename records (PLAN.md section 4, "Storage as
// built": renames apply by time). Shared by the fold (./fold.ts), the
// evaluation harness's burst rule and its replay, so all of them resolve an
// event to the same item.
//
// The rule is a pure function of the set of rename records, never of the
// order they arrived in (each copy's `seq` differs, so it is never used):
//
// - An event for item `a` at time `t` follows the first rename of `a` dated at
//   or after `t` (an event at exactly a rename's second counts toward the new
//   name). If `a` has several renames at that second, the one with the
//   smallest id (`compareStrings`) applies.
// - From the new name it follows the first rename dated strictly after the
//   one it just followed, the same way, and so on. Renames at the same second
//   are simultaneous: they never chain into each other. So `a→b` and `b→c`
//   in one second send `a`'s history to `b` and `b`'s to `c` (two notes
//   moved at once), and `a→b` with `b→a` in one second swaps the two.
//   Renames at later seconds chain as usual.
//
// Every step moves strictly forward in time, so resolution always ends.

import { compareStrings } from './validate.js';

/** A rename record as the resolver needs it. `storage.StoredRename` fits. */
export interface RenameLike {
  readonly item: string;
  readonly to: string;
  readonly time: number;
  /** The record's globally unique id: the tie-break between renames of one item at one second. */
  readonly id: string;
}

/** Orders renames by (time, id): the order the rule considers them in. */
export function compareRenames(a: RenameLike, b: RenameLike): number {
  return a.time - b.time || compareStrings(a.id, b.id);
}

/** Renames known so far, indexed by old item, each list sorted by (time, id). */
export class RenameIndex {
  private readonly byFrom = new Map<string, RenameLike[]>();

  add(rename: RenameLike): void {
    let list = this.byFrom.get(rename.item);
    if (!list) this.byFrom.set(rename.item, (list = []));
    let i = list.length;
    while (i > 0 && compareRenames(list[i - 1] as RenameLike, rename) > 0) i--;
    list.splice(i, 0, rename);
  }

  /**
   * The rename an event for `item` dated `time` follows first: the first
   * rename of `item` at or after `time`, smallest id among ties. Undefined
   * when there is none.
   */
  first(item: string, time: number): RenameLike | undefined {
    return this.byFrom.get(item)?.find((r) => r.time >= time);
  }

  /** Where an event for `item` at `time` lands (see the top of this file). */
  resolve(item: string, time: number): string {
    let current = item;
    let next = this.first(item, time);
    while (next) {
      const at = next.time;
      current = next.to;
      next = this.byFrom.get(current)?.find((r) => r.time > at);
    }
    return current;
  }
}
