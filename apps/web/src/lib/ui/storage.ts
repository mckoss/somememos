// Small, failure-proof wrappers around Web Storage. Private browsing, blocked
// site data and full quotas all make storage throw; none of that may break the
// app, so every access is wrapped and a failure reads as "nothing stored".

export function readStorage(area: 'local' | 'session', key: string): string | null {
  try {
    return (area === 'local' ? localStorage : sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

/** Returns false when the value could not be stored. */
export function writeStorage(
  area: 'local' | 'session',
  key: string,
  value: string | null,
): boolean {
  try {
    const s = area === 'local' ? localStorage : sessionStorage;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Unsaved editor text, kept so a reload or a crash doesn't lose it. */
export interface Draft {
  readonly text: string;
  /** The hash the edit started from (null for a new note). */
  readonly baseHash: string | null;
  readonly message: string;
  /** Unix milliseconds. */
  readonly savedAt: number;
}

const draftKey = (path: string) => `somememos:draft:${path}`;

export function loadDraft(path: string): Draft | null {
  const raw = readStorage('local', draftKey(path));
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<Draft>;
    if (typeof d.text !== 'string' || typeof d.savedAt !== 'number') return null;
    return {
      text: d.text,
      baseHash: typeof d.baseHash === 'string' ? d.baseHash : null,
      message: typeof d.message === 'string' ? d.message : '',
      savedAt: d.savedAt,
    };
  } catch {
    return null;
  }
}

export function saveDraft(path: string, draft: Draft): boolean {
  return writeStorage('local', draftKey(path), JSON.stringify(draft));
}

export function clearDraft(path: string): void {
  writeStorage('local', draftKey(path), null);
}

/**
 * Removes every unsaved draft. Drafts hold note text, so wiping the brain
 * from this device (reset) wipes them too. Returns how many were removed.
 */
export function clearAllDrafts(): number {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null && key.startsWith(draftKey(''))) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
    return keys.length;
  } catch {
    return 0;
  }
}
