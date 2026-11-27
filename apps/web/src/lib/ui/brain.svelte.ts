// The UI's view of the brain: one place that opens the host, keeps a
// revision counter that pages watch to refresh after a change, and caches the
// note titles that link rendering and autocomplete need.
//
// Only ever used in the browser: the brain lives on the device.

import { getBrainHost, type BrainHost, type StorageInfo } from '#lib/brain/host.ts';
import type { engine } from '@somememos/core';
import type { RolePatterns } from './paths.ts';

export const brain = $state({
  /** True once the host is open. */
  ready: false,
  /** Set when the brain could not be opened. */
  error: null as string | null,
  /** True when it failed because another tab or window holds the data. */
  busy: false,
  /** Bumped after every change, so lists and views refresh. */
  revision: 0,
  storage: null as StorageInfo | null,
  /** The brain's folder roles (read loosely: `blog` may be newer than core's types). */
  roles: {} as RolePatterns,
  /** Every note's path, title and role, refreshed with `revision`. */
  titles: [] as engine.NoteTitle[],
  /** Half-life lengths in seconds, by name, from the brain's config. */
  halfLives: {} as Readonly<Record<string, number>>,
});

/**
 * Paths whose next open in the note view should not log a read, because the
 * person is coming straight back from editing or creating it.
 */
// Not reactive on purpose: nothing renders from it.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
export const skipNextRead = new Set<string>();

let started: Promise<BrainHost> | null = null;

/** The brain host, opened on first use. */
export function host(): Promise<BrainHost> {
  started ??= open();
  return started;
}

async function open(): Promise<BrainHost> {
  try {
    const h = await getBrainHost();
    brain.ready = true;
    // A handle for the browser console and the end-to-end tests: the brain is
    // the person's own, on their own device.
    (globalThis as { somememos?: unknown }).somememos = { host: h };
    await refreshMeta(h);
    void h.storageInfo().then((s) => (brain.storage = s));
    // Changes made in another tab refresh what this one shows. (This tab's
    // own changes call `changed()` where they happen.)
    h.subscribe((change) => {
      if (change.source === 'other-tab' || change.operation === 'reopen') void changed();
    });
    return h;
  } catch (error) {
    brain.error = error instanceof Error ? error.message : String(error);
    // The data is held by another tab (or window) of the app that can't hand
    // it over: worth retrying once that one is closed.
    brain.busy = error instanceof Error && error.name === 'StorageBusyError';
    // Let `retry()` (or the next `host()` call) open it again.
    started = null;
    throw error;
  }
}

/** Tries to open the brain again after it failed. */
export async function retry(): Promise<void> {
  brain.error = null;
  brain.busy = false;
  try {
    await host();
    await changed();
  } catch {
    // `brain.error` says why.
  }
}

async function refreshMeta(h: BrainHost): Promise<void> {
  brain.roles = { ...(h.engine.config.roles as RolePatterns) };
  brain.halfLives = { ...h.engine.config.halfLives };
  brain.titles = await h.engine.noteTitles();
}

/** Call after anything that changes the brain. */
export async function changed(): Promise<void> {
  const h = await host();
  await refreshMeta(h);
  brain.storage = await h.storageInfo();
  brain.revision += 1;
}
