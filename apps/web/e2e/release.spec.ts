// The UI on the real on-device brain, end to end: persistence across reloads,
// working offline from the service worker, installability, several tabs, a
// brain that can't be opened, the memory fallback, the update prompt, and
// importing a folder wrapped in an extra folder. Every note is invented.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { clientGo, engineCall, importBrain, nav, status, typeAtEnd } from './fixtures.ts';

interface NoteView {
  path: string;
  text: string;
  hash: string;
}

const readQuiet = (page: Page, path: string) =>
  engineCall<NoteView>(page, 'readNote', path, { record: false });

/** Waits until the service worker has installed and controls the page. */
async function controlled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r));
    }
  });
}

/** Reloads and waits for the brain to be open again. */
async function reloadAndOpen(page: Page): Promise<void> {
  await page.reload();
  await page.waitForFunction(() => 'somememos' in globalThis);
}

/** The first result of a search typed into the search screen. */
async function searchFor(page: Page, words: string) {
  await nav(page, 'Search');
  await page.getByRole('searchbox', { name: 'Search your notes' }).fill(words);
  const first = page
    .getByRole('list', { name: /Results for/ })
    .getByRole('article')
    .first();
  await expect(first).toBeVisible();
  return first;
}

test.describe('with the service worker', () => {
  test.use({ serviceWorkers: 'allow' });

  test('import, search, read, edit, reload, then all of it offline', async ({ page, context }) => {
    await importBrain(page);
    await controlled(page);

    // Search and explain a rank.
    const first = await searchFor(page, 'hive');
    await first.getByText('Why this rank').click();
    await expect(first.getByRole('region', { name: 'Activity' })).toContainText('Last week');

    // Open a note (one read), then edit and save it.
    const link = first.getByRole('link').first();
    const title = (await link.textContent())!.trim();
    await link.click();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    const path = decodeURIComponent(new URL(page.url()).pathname.replace(/^\/note\//, ''));
    await page.getByRole('link', { name: 'Edit' }).click();
    await expect(page.locator('.cm-content')).toBeVisible();
    await typeAtEnd(page, '\n\nKept across reloads.');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    const before = await status(page);

    // Everything is still there after a reload.
    await reloadAndOpen(page);
    expect((await readQuiet(page, path)).text).toContain('Kept across reloads.');
    expect(await status(page)).toEqual(before);
    await clientGo(page, `/note/${path}`);
    await expect(page.locator('.prose')).toContainText('Kept across reloads.');

    // Offline: the app opens from the service worker and still works.
    await context.setOffline(true);
    try {
      await reloadAndOpen(page);
      await expect(page.locator('header .version')).toBeVisible();
      const offlineHit = await searchFor(page, 'hive');
      await offlineHit.getByRole('link').first().click();
      await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
      await clientGo(page, `/edit/${path}`);
      await expect(page.locator('.cm-content')).toContainText('Kept across reloads.');
      await typeAtEnd(page, '\nWritten offline.');
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText('Saved.')).toBeVisible();
      expect((await readQuiet(page, path)).text).toMatch(
        /Kept across reloads\.\nWritten offline\.$/,
      );
      // A screen this tab never opened comes from the offline shell.
      await page.goto('/neglected');
      await expect(page.getByRole('heading', { level: 1, name: 'Neglected' })).toBeVisible();
      await expect(
        page.getByRole('list', { name: 'Neglected' }).getByRole('article').first(),
      ).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });

  test('installable: manifest, icons and a controlling service worker', async ({ page }) => {
    await page.goto('/');
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(href).toBeTruthy();
    const response = await page.request.get(new URL(href!, page.url()).href);
    expect(response.ok()).toBe(true);
    const manifest = (await response.json()) as {
      name: string;
      short_name: string;
      start_url: string;
      display: string;
      theme_color: string;
      background_color: string;
      icons: { src: string; sizes: string; type: string; purpose?: string }[];
    };
    expect(manifest).toMatchObject({ name: 'somememos', start_url: '/', display: 'standalone' });
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    const sizes = manifest.icons.map((i) => `${i.sizes} ${i.purpose ?? 'any'}`);
    expect(sizes).toEqual(
      expect.arrayContaining([
        '192x192 any',
        '512x512 any',
        '192x192 maskable',
        '512x512 maskable',
      ]),
    );
    // The theme colours are the page's own background, light and dark.
    const pageBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(pageBg).toBe(hexToRgb(manifest.background_color));
    const themeColors = await page
      .locator('meta[name="theme-color"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('content')));
    expect(themeColors).toContain(manifest.theme_color);

    const icons = [
      ...manifest.icons.map((i) => i.src),
      ...(await page
        .locator('link[rel="icon"], link[rel="apple-touch-icon"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('href')!))),
    ];
    for (const src of icons) {
      const icon = await page.request.get(new URL(src, page.url()).href);
      expect(icon.ok(), src).toBe(true);
      expect(icon.headers()['content-type'], src).toMatch(/^image\/(png|svg\+xml)/);
    }
    const loaded = await page.evaluate(async (srcs) => {
      const results = await Promise.all(
        srcs.map(async (src) => {
          const img = new Image();
          img.src = src;
          try {
            await img.decode();
            return img.naturalWidth > 0;
          } catch {
            return false;
          }
        }),
      );
      return results.every(Boolean);
    }, icons);
    expect(loaded).toBe(true);

    await controlled(page);
    await page.reload();
    expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  });

  test('a new version shows a prompt, and Reload switches to it', async ({ page }) => {
    // A proxy in front of the app that can serve a changed service worker, as
    // a new deploy would (Playwright can't route a service worker's own script).
    let version: string | null = null;
    const app = test.info().project.use.baseURL as string;
    const proxy = createServer((req, res) => {
      void (async () => {
        const upstream = await fetch(new URL(req.url ?? '/', app), {
          headers: { 'accept-encoding': 'identity' },
        });
        let body = Buffer.from(await upstream.arrayBuffer());
        if (version && req.url?.startsWith('/service-worker.js')) {
          const text = body.toString('utf8').replaceAll(version, `${version}.next`);
          body = Buffer.from(`${text}\n// next version\n`);
        }
        const headers: Record<string, string> = {};
        upstream.headers.forEach((v, k) => {
          if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(k)) {
            headers[k] = v;
          }
        });
        res.writeHead(upstream.status, headers).end(body);
      })().catch(() => res.writeHead(502).end());
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    try {
      await page.goto(`${origin}/`);
      await controlled(page);
      const prompt = page.getByTestId('update-prompt');
      await expect(prompt).toHaveCount(0);
      const [cache] = await page.evaluate(() => caches.keys());
      version = cache!.slice('somememos-app-'.length);
      await page.evaluate(async () => {
        await (await navigator.serviceWorker.getRegistration())?.update();
      });
      await expect(prompt).toContainText('A new version is ready');
      const reloaded = page.waitForEvent('load');
      await prompt.getByRole('button', { name: 'Reload' }).click();
      await reloaded;
      await expect.poll(() => page.evaluate(() => caches.keys())).toEqual([`${cache}.next`]);
      await expect(page.getByTestId('update-prompt')).toHaveCount(0);
    } finally {
      await page.close();
      proxy.close();
    }
  });
});

test('two tabs: the second forwards to the first and follows its changes', async ({ context }) => {
  const a = await context.newPage();
  await importBrain(a);
  const b = await context.newPage();
  await b.goto('/more');
  await b.waitForFunction(() => 'somememos' in globalThis);
  await expect(b.getByTestId('runs-in-other-tab')).toBeVisible();

  // The second tab searches and reads through the first.
  const hit = await searchFor(b, 'hive');
  await hit.getByRole('link').first().click();
  await expect(b.getByRole('heading', { name: 'History' })).toBeVisible();

  // A note saved in the second tab shows up in the first tab's search.
  await searchFor(a, 'hive');
  await a.getByRole('searchbox', { name: 'Search your notes' }).fill('zephyrine');
  await expect(a.getByText('No notes match “zephyrine”.')).toBeVisible();
  await clientGo(b, '/edit/memos/zephyr.md');
  await typeAtEnd(b, '# Zephyr\n\nA zephyrine breeze.');
  await b.getByRole('button', { name: 'Create' }).click();
  await expect(b.getByText('Created.')).toBeVisible();
  await expect(
    a.getByRole('list', { name: /Results for “zephyrine”/ }).getByRole('article'),
  ).toHaveCount(1);

  // Closing the first tab hands the brain to the second.
  await a.close();
  await clientGo(b, '/more');
  await expect(b.getByRole('heading', { level: 2, name: 'Storage on this device' })).toBeVisible();
  await expect(b.getByText('Your notes are stored in this browser')).toBeVisible();
  // The hint goes once this tab has taken over (it hears `reopen` via subscribe).
  await expect(b.getByTestId('runs-in-other-tab')).toHaveCount(0);
  expect((await readQuiet(b, 'memos/zephyr.md')).text).toContain('A zephyrine breeze.');
});

test('a brain held by another window says so, and Try again opens it', async ({ context }) => {
  test.setTimeout(90_000);
  // Without Web Locks a tab can't ask the owner to share, so a second tab
  // finds the files held (StorageBusyError) after waiting for them.
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'locks', {
      configurable: true,
      get: () => undefined,
    });
  });
  const a = await context.newPage();
  await a.goto('/');
  await a.waitForFunction(() => 'somememos' in globalThis);
  const b = await context.newPage();
  await b.goto('/');
  const alert = b.getByRole('alert');
  await expect(alert).toContainText('Your notes are open in another window', { timeout: 30_000 });
  await a.close();
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(b.getByText('Your brain is empty')).toBeVisible({ timeout: 30_000 });
  await expect(b.getByRole('alert')).toHaveCount(0);
});

test('without device storage, a plain warning says why', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(StorageManager.prototype, 'getDirectory', {
      configurable: true,
      value: () => Promise.reject(new DOMException('blocked by the test', 'SecurityError')),
    });
  });
  await page.goto('/');
  const warning = page.getByTestId('memory-warning');
  await expect(warning).toContainText('Your notes are not being saved on this device');
  await expect(warning).toContainText('private browsing');
  await expect(warning).toContainText('SecurityError');
  // Still usable for this tab.
  await expect(page.getByText('Your brain is empty')).toBeVisible();
});

test('a folder wrapped in another folder still matches its roles', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'somememos-wrapped-'));
  const files: Record<string, string> = {
    'outer/vault/memos/compost.md': '# Compost\n\nTurn the heap weekly.\n',
    'outer/vault/memos/garden/beans.md': '# Beans\n\nSee [[Compost]].\n',
    'outer/vault/diary/2026/03/2026-03-02.md': '# 2 March\n\nPlanted beans.\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  await page.goto('/more');
  await page.waitForFunction(() => 'somememos' in globalThis);
  // The picked folder is `outer`; the brain is one folder further in.
  await page.getByTestId('import-folder').setInputFiles(join(root, 'outer'));
  const importSection = page.locator('#import');
  await importSection.getByRole('button', { name: /^Import 3 notes/ }).click();
  await expect(importSection.getByText(/^Imported 3 notes/)).toBeVisible();
  const titles = await engineCall<{ path: string }[]>(page, 'noteTitles');
  expect(titles.map((t) => t.path).sort()).toEqual([
    'diary/2026/03/2026-03-02.md',
    'memos/compost.md',
    'memos/garden/beans.md',
  ]);
});

test('writing a note from “Not written yet” resolves its links', async ({ page }) => {
  await importBrain(page);
  await engineCall(
    page,
    'saveNote',
    'memos/orchard.md',
    '# Orchard\n\nPrune per [[Winter Pruning]].\n',
    {},
  );
  await clientGo(page, '/dangling');
  const row = page.getByRole('listitem').filter({ hasText: 'winter pruning' });
  await row.getByRole('link', { name: 'Write it' }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  await typeAtEnd(page, 'Cut on a dry day.');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('Created.')).toBeVisible();

  // The engine hands the list normalized (lower-case) keys, so the file is
  // named in lower case; links resolve regardless of case.
  const dangling = await engineCall<{ key: string }[]>(page, 'danglingLinks');
  expect(dangling.map((d) => d.key)).not.toContain('winter pruning');
  await clientGo(page, '/note/memos/orchard.md');
  const link = page.locator('.prose a.wikilink', { hasText: 'Winter Pruning' });
  await expect(link).toBeVisible();
  await expect(link).not.toHaveClass(/wikilink-missing/);
});

test('every control on the main screens has a name', async ({ page }) => {
  await importBrain(page, { blog: true });
  const unnamed = async () =>
    page.evaluate(() => {
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none' && r.width + r.height > 0;
      };
      const named = (el: HTMLElement) =>
        Boolean(
          el.getAttribute('aria-label')?.trim() ||
          el.getAttribute('aria-labelledby') ||
          (el as HTMLInputElement).labels?.length ||
          el.closest('label') ||
          el.textContent?.trim() ||
          el.getAttribute('title')?.trim(),
        );
      return [...document.querySelectorAll<HTMLElement>('a[href], button, input, textarea, select')]
        .filter((el) => (el as HTMLInputElement).type !== 'hidden')
        .filter((el) => visible(el) || el.matches('input[type=file]'))
        .filter((el) => !named(el))
        .map((el) => el.outerHTML.slice(0, 120));
    });
  const screens = ['/', '/hot', '/trending', '/neglected', '/dangling', '/new', '/more'];
  for (const href of screens) {
    await clientGo(page, href);
    await page.waitForTimeout(200);
    expect(await unnamed(), href).toEqual([]);
  }
  await nav(page, 'Search');
  await page.getByRole('searchbox').fill('hive');
  await page.getByText('Why this rank').first().click();
  expect(await unnamed(), 'search').toEqual([]);
  const hot = await engineCall<{ results: { path: string | null }[] }>(page, 'list', 'hot', {});
  const path = hot.results.find((r) => r.path)!.path!;
  await clientGo(page, `/note/${path}`);
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
  expect(await unnamed(), 'note').toEqual([]);
  await clientGo(page, `/edit/${path}`);
  await expect(page.locator('.cm-content')).toBeVisible();
  expect(await unnamed(), 'editor').toEqual([]);
});

function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
