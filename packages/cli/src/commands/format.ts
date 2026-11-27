// Plain-text forms shared by several commands.

import { plural } from '../brain/index.js';
import type { IndexSummary } from '../indexer/index.js';

/** One line describing an index pass. */
export function formatIndexSummary(s: IndexSummary): string {
  const ms = `(${s.ms} ms)`;
  const prefix = s.rebuilt ? 'rebuilt: ' : '';
  if (s.baseline) {
    return `${prefix}baseline: indexed ${plural(s.indexed, 'note')}; the first index of a brain logs no events ${ms}`;
  }
  const work: string[] = [];
  if (s.indexed > 0) work.push(`indexed ${plural(s.indexed, 'note')}`);
  if (s.removed > 0) work.push(`removed ${s.removed}`);
  if (s.renamed > 0) work.push(`renamed ${s.renamed}`);
  if (s.relinked > 0) work.push(`relinked ${s.relinked}`);
  const logged: string[] = [];
  if (s.events.edit > 0) logged.push(plural(s.events.edit, 'edit'));
  if (s.events.mention > 0) logged.push(plural(s.events.mention, 'mention'));
  if (s.events.rename > 0) logged.push(plural(s.events.rename, 'rename'));
  if (work.length === 0 && logged.length === 0) {
    return `${prefix}up to date: ${plural(s.scanned, 'note')} ${ms}`;
  }
  const parts = [`${work.join(', ') || 'no notes changed'} (${s.scanned} scanned)`];
  parts.push(logged.length > 0 ? `logged ${logged.join(', ')}` : 'logged no events');
  return `${prefix}${parts.join('; ')} ${ms}`;
}
