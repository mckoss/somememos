// Compact storage for a posting's token positions (PLAN.md section 5,
// "Keyword scoring details": phrases need positions).
//
// The positions of the title, heading and body fields are written one after
// another, each as the gap to the previous position minus one (the first
// measured from -1, so consecutive positions cost 0), in LEB128 varints. The field counts are not stored: they are the posting's term
// frequencies, which the index keeps anyway. A typical posting takes one byte
// per occurrence. Works the same in SQLite (BLOB) and Postgres (bytea).

import { FIELDS, type FieldPositions, type FieldValues } from '../keyword/document.js';

/** Encodes per-field positions (each ascending, non-negative integers). */
export function encodePositions(positions: FieldPositions): Uint8Array {
  const bytes: number[] = [];
  for (const field of FIELDS) {
    let previous = -1;
    for (const p of positions[field]) {
      if (!Number.isSafeInteger(p) || p <= previous) {
        throw new RangeError(`positions must be ascending non-negative integers (${field})`);
      }
      let delta = p - previous - 1;
      previous = p;
      while (delta >= 0x80) {
        bytes.push((delta % 0x80) | 0x80);
        delta = Math.floor(delta / 0x80);
      }
      bytes.push(delta);
    }
  }
  return Uint8Array.from(bytes);
}

/** Decodes what `encodePositions` wrote, given each field's count (its term frequency). */
export function decodePositions(bytes: Uint8Array, counts: FieldValues): FieldPositions {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let scale = 1;
    for (;;) {
      if (at >= bytes.length) throw new RangeError('truncated positions');
      const byte = bytes[at++] as number;
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
      scale *= 0x80;
    }
  };
  const out = { title: [] as number[], heading: [] as number[], body: [] as number[] };
  for (const field of FIELDS) {
    let previous = -1;
    for (let i = 0; i < counts[field]; i++) {
      previous = previous + 1 + readVarint();
      out[field].push(previous);
    }
  }
  if (at !== bytes.length) throw new RangeError('positions do not match the term frequencies');
  return out;
}
