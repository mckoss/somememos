// Where an event lands after rename records (PLAN.md section 4, "Storage as
// built": renames apply by time). Shared by the fold (./fold.ts) and the
// evaluation harness's burst rule, so both resolve an event to the same item.

/** A rename record as the resolver needs it. `storage.StoredRename` fits. */
export interface RenameLike {
  readonly item: string;
  readonly to: string;
  readonly time: number;
  /** Arrival order, the tie-break between renames at the same second. */
  readonly seq: number;
}

/** Renames known so far, indexed by old item, each list sorted by (time, seq). */
export class RenameIndex {
  private readonly byFrom = new Map<string, RenameLike[]>();

  add(rename: RenameLike): void {
    let list = this.byFrom.get(rename.item);
    if (!list) this.byFrom.set(rename.item, (list = []));
    let i = list.length;
    while (
      i > 0 &&
      ((list[i - 1] as RenameLike).time > rename.time ||
        ((list[i - 1] as RenameLike).time === rename.time &&
          (list[i - 1] as RenameLike).seq > rename.seq))
    ) {
      i--;
    }
    list.splice(i, 0, rename);
  }

  /**
   * Where an event for `item` at `time` lands: follow the first rename of
   * `item` at or after `time`, then the first rename of the new name after
   * that one, and so on. Each step moves strictly forward in (time, seq), so
   * this always ends.
   */
  resolve(item: string, time: number): string {
    let current = item;
    let atTime = time;
    let atSeq = -Infinity;
    for (;;) {
      const list = this.byFrom.get(current);
      const next = list?.find((r) => r.time > atTime || (r.time === atTime && r.seq > atSeq));
      if (!next) return current;
      current = next.to;
      atTime = next.time;
      atSeq = next.seq;
    }
  }
}
