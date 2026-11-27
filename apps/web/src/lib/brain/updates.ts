// App updates, for an "update available" prompt.
//
// The service worker (src/service-worker/) installs a new version in the
// background and leaves it waiting. This module notices it and lets the UI
// apply it:
//
//   import { updateAvailable, applyUpdate } from '#lib/brain/updates.ts';
//   $updateAvailable            // a Svelte-compatible store: true when ready
//   await applyUpdate();        // switch to the new version and reload
//
// Browser only; on the server `updateAvailable` stays false and the
// functions do nothing.

type Listener = (available: boolean) => void;

let available = false;
const listeners = new Set<Listener>();
let started = false;
let reloading = false;

function set(value: boolean): void {
  if (available === value) return;
  available = value;
  for (const listener of [...listeners]) listener(value);
}

function supported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

function watchInstalling(worker: ServiceWorker | null): void {
  if (!worker) return;
  const check = () => {
    // A worker installed while another controls the page is an update.
    if (worker.state === 'installed' && navigator.serviceWorker.controller) set(true);
  };
  check();
  worker.addEventListener('statechange', check);
}

async function start(): Promise<void> {
  if (started || !supported()) return;
  started = true;
  const registration = await navigator.serviceWorker.ready;
  if (registration.waiting && navigator.serviceWorker.controller) set(true);
  watchInstalling(registration.installing);
  registration.addEventListener('updatefound', () => watchInstalling(registration.installing));
}

/**
 * True once a new version is installed and waiting. A Svelte store
 * (`$updateAvailable` in a component): `subscribe` calls the listener now
 * and on every change, and returns the unsubscribe function.
 */
export const updateAvailable = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    listener(available);
    void start().catch(() => undefined);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** Whether an update is waiting right now. */
export function isUpdateAvailable(): boolean {
  return available;
}

/** Asks the server for a newer version now (browsers also check on navigation). */
export async function checkForUpdate(): Promise<boolean> {
  if (!supported()) return false;
  await start();
  const registration = await navigator.serviceWorker.getRegistration();
  await registration?.update();
  return available;
}

/**
 * Switches to the waiting version and reloads the page once it controls it.
 * Other open tabs of the app reload too, since they would otherwise run old
 * code against the new version's cache. Resolves without doing anything when
 * no update is waiting.
 */
export async function applyUpdate(): Promise<void> {
  if (!supported()) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const waiting = registration?.waiting;
  if (!waiting) return;
  waiting.postMessage({ type: 'skip-waiting' });
}

// Every tab reloads when a new service worker takes control after an update.
if (supported()) {
  let hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      // The first install claiming the page: not an update.
      hadController = true;
      return;
    }
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}
