// The public blog in a real browser: pages render with JavaScript off at
// phone and desktop sizes, the feed and sitemap parse, the service worker
// never stands in for a blog page, and the app still works beside it.
// Screenshots (light and dark) go to $BLOG_SCREENSHOT_DIR.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { SLUG } from './global-setup.ts';

test.skip(
  !process.env.SOMEMEMOS_TEST_DATABASE_URL,
  'needs SOMEMEMOS_TEST_DATABASE_URL (a test Postgres)',
);

const SHOTS =
  process.env.BLOG_SCREENSHOT_DIR ??
  new URL('../../../node_modules/.cache/somememos-e2e-blog/screens/', import.meta.url).pathname;
const INDEX = `/blog/${SLUG}/`;
const POST = `/blog/${SLUG}/2026/11/20/notes-from-a-week-of-slow-bread`;

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the index and a post render, readable at this size', async ({ page }, info) => {
    mkdirSync(SHOTS, { recursive: true });
    const response = await page.goto(INDEX);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle('Field Notes');
    await expect(page.getByRole('heading', { level: 1, name: 'Field Notes' })).toBeVisible();
    const posts = page.locator('.posts h2');
    await expect(posts).toHaveText([
      'Notes from a week of slow bread',
      'The first starter',
      'A kitchen scale',
    ]);
    await expect(page.getByText('Unfinished draft')).toHaveCount(0);
    expect(await page.locator('script').count()).toBe(0);
    await expectNoHorizontalScroll(page);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({
        path: join(SHOTS, `index-${info.project.name}-${scheme}.png`),
        fullPage: true,
      });
    }

    await page.getByRole('link', { name: 'Notes from a week of slow bread' }).click();
    await expect(page).toHaveURL(POST);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Notes from a week of slow bread' }),
    ).toBeVisible();
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'the first attempt' })).toHaveAttribute(
      'href',
      `/blog/${SLUG}/2026/10/02/the-first-starter`,
    );
    // The private memo's link is plain text, and its path appears nowhere.
    await expect(page.getByRole('link', { name: 'baking-log' })).toHaveCount(0);
    expect(await page.content()).not.toContain('memos/');
    expect(await page.locator('script').count()).toBe(0);
    await expectNoHorizontalScroll(page);
    // Code and tables scroll inside themselves on a narrow screen.
    if (info.project.name === 'phone') {
      for (const box of await page.locator('.scroll').all()) {
        const { scroll, client } = await box.evaluate((el) => ({
          scroll: el.scrollWidth,
          client: el.clientWidth,
        }));
        expect(client).toBeLessThanOrEqual(page.viewportSize()!.width);
        expect(scroll).toBeGreaterThanOrEqual(client);
      }
    }
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({
        path: join(SHOTS, `post-${info.project.name}-${scheme}.png`),
        fullPage: true,
      });
    }
    const missing = await page.goto(`/blog/${SLUG}/2026/11/25/unfinished`);
    expect(missing?.status()).toBe(404);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.screenshot({ path: join(SHOTS, `not-found-${info.project.name}.png`) });
  });
});

test('the feed is valid Atom and the sitemap valid XML', async ({ page, request }) => {
  await page.goto(INDEX);
  const feedHref = await page
    .locator('link[rel="alternate"][type="application/atom+xml"]')
    .getAttribute('href');
  const feed = await request.get(feedHref!);
  expect(feed.headers()['content-type']).toBe('application/atom+xml; charset=utf-8');
  const map = await request.get(`${INDEX}sitemap.xml`);
  const parsed = await page.evaluate(
    ([atom, sitemap]: string[]) => {
      const parse = (xml = '') => new DOMParser().parseFromString(xml, 'application/xml');
      const f = parse(atom);
      const s = parse(sitemap);
      const ns = 'http://www.w3.org/2005/Atom';
      return {
        errors:
          f.getElementsByTagName('parsererror').length +
          s.getElementsByTagName('parsererror').length,
        root: [f.documentElement.namespaceURI, f.documentElement.localName],
        titles: [...f.getElementsByTagNameNS(ns, 'entry')].map(
          (e) => e.getElementsByTagNameNS(ns, 'title')[0]?.textContent,
        ),
        // Every entry has the elements Atom requires.
        complete: [...f.getElementsByTagNameNS(ns, 'entry')].every((e) =>
          ['id', 'title', 'updated', 'link'].every(
            (n) => e.getElementsByTagNameNS(ns, n).length > 0,
          ),
        ),
        content: f.getElementsByTagNameNS(ns, 'content')[0]?.textContent ?? '',
        locs: [...s.getElementsByTagName('loc')].map((l) => new URL(l.textContent!).pathname),
      };
    },
    [await feed.text(), await map.text()],
  );
  expect(parsed.errors).toBe(0);
  expect(parsed.root).toEqual(['http://www.w3.org/2005/Atom', 'feed']);
  expect(parsed.titles).toEqual([
    'Notes from a week of slow bread',
    'The first starter',
    'A kitchen scale',
  ]);
  expect(parsed.complete).toBe(true);
  expect(parsed.content).toContain('<h2 id="h-the-schedule">The schedule</h2>');
  expect(parsed.locs).toEqual([
    INDEX,
    POST,
    `/blog/${SLUG}/2026/10/02/the-first-starter`,
    `/blog/${SLUG}/2026/09/15/a-kitchen-scale`,
  ]);
  const robots = await request.get('/robots.txt');
  expect(await robots.text()).toContain(`Sitemap: `);
});

test.describe('with the service worker installed', () => {
  test.use({ serviceWorkers: 'allow' });

  test('blog pages come from the server, never the app shell, and the app still works', async ({
    page,
    context,
  }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r));
      }
    });
    await expect(page.getByText('Your brain is empty')).toBeVisible();

    // Online: the server's page, with nothing of the app in it.
    await page.goto(POST);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Notes from a week of slow bread' }),
    ).toBeVisible();
    expect(await page.locator('script').count()).toBe(0);
    expect(await page.evaluate(() => 'somememos' in globalThis)).toBe(false);
    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const key of await caches.keys()) {
        for (const r of await (await caches.open(key)).keys()) urls.push(new URL(r.url).pathname);
      }
      return urls.filter((u) => u.startsWith('/blog/'));
    });
    expect(cached).toEqual([]);

    // Offline: the browser's own error, not the app's offline shell.
    await context.setOffline(true);
    try {
      // The app itself still opens offline from the shell…
      await page.goto('/neglected');
      await expect(page.getByRole('heading', { level: 1, name: 'Neglected' })).toBeVisible();
      // …but a blog page never does. One read a moment ago may come from the
      // browser's HTTP cache (max-age), as itself; one never read just fails.
      await page.goto(POST);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Notes from a week of slow bread' }),
      ).toBeVisible();
      expect(await page.locator('script').count()).toBe(0);
      await expect(page.goto(`/blog/${SLUG}/2026/09/15/a-kitchen-scale`)).rejects.toThrow(
        /ERR_INTERNET_DISCONNECTED/,
      );
    } finally {
      await context.setOffline(false);
    }
    await page.goto('/');
    await page.waitForFunction(() => 'somememos' in globalThis);
    await expect(page.getByText('Your brain is empty')).toBeVisible();
  });
});
