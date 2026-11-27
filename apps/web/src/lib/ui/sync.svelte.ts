// The UI's view of sync: the latest status from the brain's worker (whichever
// tab runs it), and the page's hints to it (back online, visible again).
// Sync itself runs in the worker (#lib/brain/sync-controller.ts).

import type { SyncView } from '#lib/brain/host.ts';
import { host } from './brain.svelte.ts';

export const syncState = $state({
  view: null as SyncView | null,
  /** Bumped on every status change, for things that depend on what has synced. */
  revision: 0,
});

/** A page hidden at least this long tells sync it is visible again. */
const HIDDEN_LONG_MS = 30_000;

let started = false;

/** Starts following the sync status (once per tab). Returns a stop function for the hints. */
export function startSync(): () => void {
  if (started) return () => undefined;
  started = true;
  void (async () => {
    try {
      const h = await host();
      h.subscribe((change) => {
        if (change.sync) {
          syncState.view = change.sync;
          syncState.revision += 1;
        }
      });
      syncState.view = await h.sync.status();
      syncState.revision += 1;
    } catch {
      // The brain didn't open; the layout says so.
    }
  })();

  const hint = (kind: 'online' | 'visible') => {
    if (!syncState.view?.connected) return;
    void host()
      .then((h) => h.sync.hint(kind))
      .catch(() => undefined);
  };
  let hiddenAt: number | null = null;
  const onOnline = () => hint('online');
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
    } else if (hiddenAt !== null) {
      if (Date.now() - hiddenAt >= HIDDEN_LONG_MS) hint('visible');
      hiddenAt = null;
    }
  };
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisibility);
    started = false;
  };
}

/** Re-reads the status (after an action that returns none). */
export async function refreshSync(): Promise<void> {
  try {
    syncState.view = await (await host()).sync.status();
    syncState.revision += 1;
  } catch {
    // Keep the last known status.
  }
}

/** Short words for the indicator. */
export const INDICATOR_LABEL: Record<SyncView['indicator'], string> = {
  off: 'Not syncing',
  synced: 'Synced',
  syncing: 'Syncing…',
  waiting: 'Changes waiting',
  offline: 'Offline',
  attention: 'Needs attention',
};
