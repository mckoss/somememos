// Light and dark themes. By default the app follows the system; a person can
// pin light or dark. The choice is stored per device and applied as
// `html[data-theme]`, which app.css maps to the `color-scheme` property.

import { readStorage, writeStorage } from './storage.ts';

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'somememos:theme';

export const theme = $state({
  choice: 'system' as ThemeChoice,
  /** What the system prefers right now. */
  systemDark: false,
});

/** The scheme actually shown. */
export function shownScheme(): 'light' | 'dark' {
  if (theme.choice === 'system') return theme.systemDark ? 'dark' : 'light';
  return theme.choice;
}

function apply(): void {
  const root = document.documentElement;
  if (theme.choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme.choice;
}

export function setTheme(choice: ThemeChoice): void {
  theme.choice = choice;
  writeStorage('local', KEY, choice === 'system' ? null : choice);
  apply();
}

/**
 * The header toggle: switch to the opposite of what is shown. Choosing what
 * the system already prefers goes back to following the system, so the app
 * isn't silently pinned.
 */
export function toggleTheme(): void {
  const target = shownScheme() === 'dark' ? 'light' : 'dark';
  setTheme(target === (theme.systemDark ? 'dark' : 'light') ? 'system' : target);
}

/** Reads the stored choice and watches the system. Returns a cleanup function. */
export function startTheme(): () => void {
  const stored = readStorage('local', KEY);
  theme.choice = stored === 'light' || stored === 'dark' ? stored : 'system';
  const mq = matchMedia('(prefers-color-scheme: dark)');
  theme.systemDark = mq.matches;
  apply();
  const onChange = (e: MediaQueryListEvent) => (theme.systemDark = e.matches);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    theme.choice = e.newValue === 'light' || e.newValue === 'dark' ? e.newValue : 'system';
    apply();
  };
  mq.addEventListener('change', onChange);
  addEventListener('storage', onStorage);
  return () => {
    mq.removeEventListener('change', onChange);
    removeEventListener('storage', onStorage);
  };
}
