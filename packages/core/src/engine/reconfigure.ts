// Changing a brain's config on one copy (PLAN.md section 4, "Folder roles"):
// re-index under the new roles without taking the change for activity.
// Every host calls this one implementation: the web app when the person
// edits the roles or a synced config arrives, the CLI when `config.json`
// changed or `sync` pulls a new one, the server when its config is replaced.
//
// What it does:
// 1. An index pass under the old config, so edits made before the change are
//    logged as the edits they are.
// 2. A rebuild of every derived table under the new config that logs
//    nothing: a note that becomes `excluded` (or loses its role) leaves the
//    index, the search results and the activation lists; one that stops being
//    excluded comes back without counting as a new edit; half-life, burst
//    and analyzer changes take effect.
// 3. Uncommitted paths that are no longer indexed are dropped, so no change
//    record ever names an excluded path.
//
// Nothing is deleted: the note text of a newly excluded folder stays where
// it is (files on disk, the browser's content table, the server's git
// repository). It is only no longer indexed, logged, shown or synced, and it
// returns if the folder stops being excluded.
//
// The config last applied is kept in durable meta (`META_APPLIED_CONFIG`), so
// a host whose config can change behind its back (the CLI's `config.json`)
// can notice and reconcile (`reconcileConfig`).

import { runIndexPass, type IndexSummary } from '../indexing/pass.js';
import { readUncommitted, writeUncommitted } from '../indexing/state.js';
import * as markdown from '../markdown/index.js';
import { parseBrainConfig, serializeBrainConfig, type BrainConfig } from '../storage/config.js';
import type { ContentStore } from '../storage/content.js';
import type { Stores } from '../storage/types.js';
import { sharedConfigKey } from '../sync/config.js';

/** Durable meta: the config the index was last built for (`serializeBrainConfig`). */
export const META_APPLIED_CONFIG = 'config.applied';

export interface ConfigChangeOptions {
  readonly stores: Stores;
  readonly content: ContentStore;
  /** The config the brain was indexed with. */
  readonly from: BrainConfig;
  /** The config to use from now on. */
  readonly to: BrainConfig;
  readonly now?: () => number;
}

/** Re-indexes a brain for a new config (see the top of this file). Returns the rebuild's summary. */
export async function applyConfigChange(options: ConfigChangeOptions): Promise<IndexSummary> {
  const { stores, content, from, to } = options;
  const now = options.now ? { now: options.now } : {};
  await runIndexPass({ stores, content, config: from, ...now });
  const summary = await runIndexPass({
    stores,
    content,
    config: to,
    ...now,
    rebuild: true,
    record: false,
  });
  const classifier = markdown.createRoleClassifier(to.roles);
  const pending = await readUncommitted(stores.meta);
  const kept = pending.filter((p) => {
    const role = classifier.classify(p)?.role;
    return role !== undefined && role !== 'excluded';
  });
  if (kept.length !== pending.length) await writeUncommitted(stores.meta, kept);
  await stores.meta.set(META_APPLIED_CONFIG, serializeBrainConfig(to));
  return summary;
}

/**
 * Brings the index in step with `config` when it was last built for another
 * shared config (`META_APPLIED_CONFIG`), with `applyConfigChange`. The first
 * call on a brain only records `config`. Returns the rebuild's summary, or
 * null when nothing had changed.
 */
export async function reconcileConfig(options: {
  readonly stores: Stores;
  readonly content: ContentStore;
  readonly config: BrainConfig;
  readonly now?: () => number;
}): Promise<IndexSummary | null> {
  const { stores, config } = options;
  const saved = await stores.meta.get(META_APPLIED_CONFIG);
  let from: BrainConfig | null = null;
  if (saved !== undefined) {
    try {
      from = parseBrainConfig(
        { ...(JSON.parse(saved) as object), clientId: config.clientId },
        'the config last applied',
      );
    } catch {
      from = null;
    }
  }
  if (from === null) {
    await stores.meta.set(META_APPLIED_CONFIG, serializeBrainConfig(config));
    return null;
  }
  if (sharedConfigKey(from) === sharedConfigKey(config)) return null;
  return applyConfigChange({ ...options, from, to: config });
}
