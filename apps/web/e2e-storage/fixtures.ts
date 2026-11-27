// Helpers for the storage tests. The app tests drive the real production
// build through its brain host: `openBrainHost` from the built chunk of
// src/lib/brain/open.ts (a dynamic entry, so its export keeps its name), the
// same module instance the UI uses. Nothing in the app is there for tests.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

const webDir = fileURLToPath(new URL('..', import.meta.url));

export const harnessUrl = (): string => `http://127.0.0.1:${process.env.STORAGE_HARNESS_PORT}/`;

let openChunk: string | undefined;

/** The URL path of the built `open.ts` chunk, from the client build's Vite manifest. */
export function openChunkPath(): string {
  if (openChunk) return openChunk;
  const manifest = JSON.parse(
    readFileSync(`${webDir}/.svelte-kit/output/client/.vite/manifest.json`, 'utf8'),
  ) as Record<string, { file: string }>;
  const entry = manifest['src/lib/brain/open.ts'];
  if (!entry) throw new Error('src/lib/brain/open.ts is not in the client build manifest');
  openChunk = `/${entry.file}`;
  return openChunk;
}

/**
 * Opens the brain host in `page` (once per page load) and stores it on
 * `window.__host` for later `page.evaluate` calls. Returns the time it took.
 */
export async function openHost(page: Page): Promise<number> {
  return page.evaluate(async (chunk) => {
    const w = window as unknown as { __host?: unknown };
    const started = performance.now();
    const mod = (await import(/* @vite-ignore */ chunk)) as {
      openBrainHost(): Promise<unknown>;
    };
    w.__host = await mod.openBrainHost();
    return performance.now() - started;
  }, openChunkPath());
}

/** Invented notes: a small linked brain. */
export function inventedNotes(
  count: number,
  prefix = 'memos/',
): { path: string; text: string; mtime: number }[] {
  const words = [
    'harbor',
    'lantern',
    'quartz',
    'maple',
    'orbit',
    'meadow',
    'cobalt',
    'ember',
    'tundra',
    'willow',
  ];
  const out: { path: string; text: string; mtime: number }[] = [];
  for (let i = 0; i < count; i++) {
    const w = words[i % words.length] as string;
    const v = words[(i * 7 + 3) % words.length] as string;
    out.push({
      path: `${prefix}note-${i}.md`,
      text: `# Note ${i} about ${w}\n\nThe ${w} meets the ${v} near [[note-${(i + 1) % count}]].\n`,
      mtime: 1_790_000_000 + i,
    });
  }
  return out;
}
