// Deterministic ids for imported records, so a second import adds nothing.

import { createHash } from 'node:crypto';

/** Mixed into every imported id, so they can never collide with another scheme's. */
export const IMPORT_ID_NAMESPACE = 'somememos/import-git/v1';

/**
 * A UUID (RFC 9562 version 5 layout: SHA-1, version and variant bits set)
 * derived from the namespace and `parts`. Live ids are random UUIDs
 * (`storage.newId`), so imported ids look the same in the log.
 */
export function importId(parts: readonly string[]): string {
  const hash = createHash('sha1');
  hash.update(IMPORT_ID_NAMESPACE);
  for (const part of parts) {
    hash.update('\0');
    hash.update(part, 'utf8');
  }
  const b = hash.digest().subarray(0, 16);
  b[6] = ((b[6] as number) & 0x0f) | 0x50;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
