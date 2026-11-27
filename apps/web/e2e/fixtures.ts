// Shared end-to-end helpers: an invented brain written to a temporary folder
// (files plus an events.jsonl built from its timeline), importing it through
// the UI, and client-side navigation (the brain lives in the page, so a full
// reload would start from an empty brain while storage is in memory).

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { generateBrain } from '../../../packages/core/src/testing/index.ts';
import { markdown } from '../../../packages/core/src/index.ts';

const DAY = 86_400;

export interface TestBrain {
  readonly dir: string;
  readonly eventsFile: string;
  readonly files: Record<string, string>;
  readonly paths: string[];
}

let cached: TestBrain | null = null;

/** The invented brain, generated once per worker: 120 days ending yesterday. */
export function testBrain(): TestBrain {
  if (cached) return cached;
  const now = Math.floor(Date.now() / 1000);
  const brain = generateBrain({ seed: 7, steps: 60, topics: 6, start: now - 121 * DAY, days: 120 });
  const root = mkdtempSync(join(tmpdir(), 'somememos-e2e-'));
  const dir = join(root, 'brain');
  for (const [path, text] of Object.entries(brain.files)) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }

  // The timeline as an event log: an edit for each write, a rename record for
  // each rename, a mention for each link a step added. Nothing in private/.
  const lines: string[] = [];
  let n = 0;
  const priv = (p: string | null | undefined) => !!p && p.startsWith('private/');
  const record = (kind: string, item: string, time: number, to?: string) =>
    lines.push(
      JSON.stringify({
        type: 'log',
        id: `e2e-${n++}`,
        kind,
        item,
        ...(to ? { to } : {}),
        time,
        client: 'e2e',
      }),
    );
  for (const step of brain.steps) {
    for (const change of step.changes) {
      if (change.type === 'write' && !priv(change.path)) record('edit', change.path, step.time);
      if (change.type === 'rename' && !priv(change.from) && !priv(change.to)) {
        record('rename', change.from, step.time, change.to);
      }
    }
    for (const link of step.truth.linksAdded) {
      if (priv(link.source) || priv(link.resolvedPath)) continue;
      record('mention', link.resolvedPath ?? markdown.normalizeDanglingKey(link.target), step.time);
    }
  }
  const eventsFile = join(root, 'events.jsonl');
  writeFileSync(eventsFile, `${lines.join('\n')}\n`);
  cached = { dir, eventsFile, files: brain.files, paths: Object.keys(brain.files) };
  return cached;
}

/** Navigates inside the app without reloading it. */
export async function clientGo(page: Page, href: string): Promise<void> {
  await page.evaluate((h) => {
    const a = document.createElement('a');
    a.href = h;
    document.body.append(a);
    a.click();
    a.remove();
  }, href);
}

/** Calls the brain engine in the page. */
export async function engineCall<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ({ method, args }) => {
      const w = globalThis as unknown as {
        somememos: { host: { engine: Record<string, (...a: unknown[]) => Promise<unknown>> } };
      };
      return w.somememos.host.engine[method]!(...args);
    },
    { method, args },
  ) as Promise<T>;
}

export interface Status {
  notes: { total: number } & Record<string, number>;
  events: Record<string, number>;
}

export const status = (page: Page) => engineCall<Status>(page, 'status');

/** Opens the app and imports the test brain through the More screen. */
export async function importBrain(page: Page, opts: { blog?: boolean } = {}): Promise<TestBrain> {
  const brain = testBrain();
  await page.goto('/more');
  await expect(page.getByRole('heading', { name: 'Import notes' })).toBeVisible();
  await page.waitForFunction(() => 'somememos' in globalThis);
  await page.getByTestId('import-folder').setInputFiles(brain.dir);
  await expect(page.getByText(/files? found/)).toBeVisible();
  // Keep the private folder out before anything is read.
  const importSection = page.locator('#import');
  await importSection.getByLabel(/Excluded/).fill('private/');
  if (opts.blog) await importSection.getByLabel(/^Blog/).fill('blog/');
  await importSection.getByRole('button', { name: /^Import \d+ notes/ }).click();
  await expect(importSection.getByText(/^Imported \d+ notes/)).toBeVisible();
  await page.getByTestId('import-log').setInputFiles(brain.eventsFile);
  await expect(page.getByTestId('log-message')).toContainText('Added');
  return brain;
}

/** Clicks a main navigation entry (bottom bar on a phone, sidebar on a desktop). */
export async function nav(page: Page, name: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name, exact: true })
    .click();
}

/** The page is no wider than the viewport. */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const { scroll, width } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    width: window.innerWidth,
  }));
  expect(scroll, 'page scrolls sideways').toBeLessThanOrEqual(width);
}

/** Where screenshots go. */
export function screenshotPath(name: string, project: string): string {
  const dir =
    process.env.SCREENSHOT_DIR ??
    join(process.cwd(), '../../node_modules/.cache/somememos-e2e/screens');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${project}-${name}.png`);
}

/** Puts the CodeMirror cursor at the end of the text and types. */
export async function typeAtEnd(page: Page, text: string): Promise<void> {
  const content = page.locator('.cm-content');
  await content.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(text);
}
