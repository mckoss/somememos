import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  clientGo,
  engineCall,
  expectNoHorizontalScroll,
  importBrain,
  nav,
  status,
  typeAtEnd,
} from './fixtures.ts';

interface NoteView {
  path: string;
  text: string;
  hash: string;
  title: string;
}

const readQuiet = (page: Parameters<typeof engineCall>[0], path: string) =>
  engineCall<NoteView>(page, 'readNote', path, { record: false });

/** A memo of the test brain that has activity. */
async function someMemo(page: Parameters<typeof engineCall>[0]): Promise<NoteView> {
  const hot = await engineCall<{ results: { path: string | null }[] }>(page, 'list', 'hot', {});
  const path = hot.results.find((r) => r.path)?.path;
  expect(path).toBeTruthy();
  return readQuiet(page, path!);
}

test('the header shows the app version', async ({ page }) => {
  await page.goto('/');
  // The root package.json is the single source of the version.
  const { version } = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  await expect(page.locator('header .version')).toHaveText(`v${version}`);
  await expect(page.getByText('Your brain is empty')).toBeVisible();
});

test('import a folder, search, and explain a rank', async ({ page }) => {
  await importBrain(page);
  const s = await status(page);
  expect(s.notes.total).toBeGreaterThan(10);
  expect(s.events.edit).toBeGreaterThan(10);

  await nav(page, 'Search');
  const box = page.getByRole('searchbox', { name: 'Search your notes' });
  await box.fill('hive');
  const results = page.getByRole('list', { name: /Results for “hive”/ });
  await expect(results.getByRole('article').first()).toBeVisible();
  await expect(results.locator('mark').first()).toHaveText(/hive/i);
  await expect(page).toHaveURL(/\?q=hive/);

  const first = results.getByRole('article').first();
  await first.getByText('Why this rank').click();
  await expect(first.getByRole('region', { name: 'Keyword match' })).toBeVisible();
  await expect(first.getByText('1.0 means its usual pace', { exact: false })).toBeVisible();
  // Each activity row counts over the window its label names.
  const activity = first.getByRole('region', { name: 'Activity' });
  await expect(activity).toContainText('Last week');
  await expect(activity).toContainText(
    /Last week\s*(about once|about \d[\d,]* times|less than once|almost none|none)/,
  );
  await expect(activity).not.toContainText(/a month|a week/);

  // Modes re-rank; keyword-only says activity isn't used.
  await page.getByText('Keyword only', { exact: true }).click();
  await expect(page).toHaveURL(/mode=all/);
  await expect(results.getByRole('article').first()).toBeVisible();

  await box.fill('zzzznotaword');
  await expect(page.getByText('No notes match “zzzznotaword”.')).toBeVisible();
});

test('hot, trending, neglected and not-written-yet lists', async ({ page }) => {
  await importBrain(page);
  for (const name of ['Hot', 'Trending', 'Neglected']) {
    await nav(page, name);
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    await expect(page.getByRole('list', { name }).getByRole('article').first()).toBeVisible();
  }
  await nav(page, 'More');
  await page.getByRole('link', { name: 'Not written yet' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Not written yet' })).toBeVisible();
});

test('opening a note logs one read', async ({ page }) => {
  await importBrain(page);
  const before = (await status(page)).events.read ?? 0;
  await nav(page, 'Hot');
  const link = page
    .getByRole('list', { name: 'Hot' })
    .getByRole('article')
    .first()
    .getByRole('link')
    .first();
  const title = (await link.textContent())!.trim();
  await link.click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
  // Let any background refresh run; it must not log another read.
  await page.waitForTimeout(500);
  expect((await status(page)).events.read).toBe(before + 1);
});

test('edit, preview, link autocomplete and save', async ({ page }) => {
  await importBrain(page);
  const note = await someMemo(page);
  const other = (await engineCall<{ path: string; title: string }[]>(page, 'noteTitles')).find(
    (t) => t.path !== note.path && t.path.startsWith('memos/'),
  )!;
  await clientGo(page, `/edit/${note.path}`);
  await expect(page.locator('.cm-content')).toBeVisible();
  const editsBefore = (await status(page)).events.edit ?? 0;

  const name = other.path.split('/').pop()!.replace(/\.md$/, '');
  await typeAtEnd(page, `\n\nSee also [[${name.slice(0, 5)}`);
  const option = page.locator('.cm-tooltip-autocomplete li').first();
  await expect(option).toBeVisible();
  // CodeMirror ignores Enter for a moment after the list changes (its interactionDelay).
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await page.keyboard.type(' and **bold** words.');

  // The preview follows typing (on a phone, after switching to it).
  if (await page.getByRole('button', { name: 'Preview' }).isVisible()) {
    await page.getByRole('button', { name: 'Preview' }).click();
  }
  const preview = page.getByTestId('preview');
  await expect(preview.locator('strong', { hasText: 'bold' })).toBeVisible();
  await expect(preview.locator('a.wikilink').last()).not.toHaveClass(/wikilink-missing/);
  if (await page.getByRole('button', { name: 'Edit', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
  }

  await page.getByLabel('What changed (optional)').fill('update add a see-also link');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  const saved = await readQuiet(page, note.path);
  const inserted = saved.text.slice(note.text.length);
  expect(saved.text.startsWith(note.text)).toBe(true);
  expect(inserted).toMatch(/^\n\nSee also \[\[[^\]]+\]\] and \*\*bold\*\* words\.$/);
  expect((await status(page)).events.edit).toBe(editsBefore + 1);
  const log = await engineCall<{ message: string | null }[]>(page, 'log', { path: note.path });
  expect(log[0]?.message).toBe('update add a see-also link');
});

test('the editor keeps text byte for byte', async ({ page }) => {
  await importBrain(page);
  const text = '# Line endings\r\n\r\nCRLF text  \r\nwith trailing spaces\r\n';
  await engineCall(page, 'saveNote', 'memos/crlf.md', text, {});
  await clientGo(page, '/edit/memos/crlf.md');
  await expect(page.locator('.cm-content')).toContainText('CRLF text');
  await typeAtEnd(page, 'more');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  expect((await readQuiet(page, 'memos/crlf.md')).text).toBe(`${text}more`);
});

test('create a note from a link to a note that does not exist yet', async ({ page }) => {
  await importBrain(page);
  const note = await someMemo(page);
  await clientGo(page, `/edit/${note.path}`);
  await typeAtEnd(page, '\n\nIdea: [[Compost Tea]]\n');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  const missing = page.locator('.prose a.wikilink-missing', { hasText: 'Compost Tea' });
  await expect(missing).toBeVisible();
  await missing.click();
  await expect(page.getByRole('heading', { name: /New note/ })).toContainText(
    'memos/Compost Tea.md',
  );
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('Created.')).toBeVisible();
  expect((await readQuiet(page, 'memos/Compost Tea.md')).text).toBe('# Compost Tea\n\n');

  // The link now resolves.
  await clientGo(page, `/note/${note.path}`);
  await expect(page.locator('.prose a.wikilink', { hasText: 'Compost Tea' })).not.toHaveClass(
    /wikilink-missing/,
  );
});

test('a conflicting save shows both versions and keeps typed text', async ({ page }) => {
  await importBrain(page);
  const note = await someMemo(page);
  await clientGo(page, `/edit/${note.path}`);
  await expect(page.locator('.cm-content')).toBeVisible();
  // Another writer saves first.
  await engineCall(page, 'saveNote', note.path, `${note.text}\nTheirs.\n`, { baseHash: note.hash });
  await typeAtEnd(page, '\nMine.');
  await page.getByRole('button', { name: 'Save' }).click();

  const dialog = page.getByRole('dialog', { name: 'This note changed while you were editing' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('conflict-mine')).toContainText('Mine.');
  await expect(dialog.getByTestId('conflict-stored')).toContainText('Theirs.');
  await dialog.getByRole('button', { name: 'Save mine as a separate note' }).click();
  await expect(page.getByText('Your version was saved as a separate note.')).toBeVisible();
  // The editor now holds the stored version; mine is in a sibling note.
  await expect(page.locator('.cm-content')).toContainText('Theirs.');
  const titles = await engineCall<{ path: string }[]>(page, 'noteTitles');
  const aside = titles.find((t) => t.path.includes('(my version'));
  expect(aside).toBeTruthy();
  expect((await readQuiet(page, aside!.path)).text).toBe(`${note.text}\nMine.`);

  // Keep mine: overwrite after a second conflict.
  await engineCall(page, 'saveNote', note.path, `${note.text}\nTheirs again.\n`, {});
  await typeAtEnd(page, '\nMine again.');
  await page.getByRole('button', { name: 'Save' }).click();
  await dialog.getByRole('button', { name: 'Keep mine' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  expect((await readQuiet(page, note.path)).text).toBe(`${note.text}\nTheirs.\n\nMine again.`);
});

test('publishing a blog post only toggles its front matter', async ({ page }) => {
  await importBrain(page, { blog: true });
  await nav(page, 'New');
  await page.getByLabel(/Blog post/).check();
  await page.getByLabel('Title').fill('Why Memos');
  await page.getByRole('button', { name: 'Start writing' }).click();
  await expect(page.getByRole('heading', { name: /New note/ })).toContainText(
    /blog\/\d{4}\/\d{4}-\d\d-\d\d-why-memos\.md/,
  );
  await typeAtEnd(page, 'A post.');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('Created.')).toBeVisible();
  const path = decodeURIComponent(new URL(page.url()).pathname.replace(/^\/edit\//, ''));
  const original = (await readQuiet(page, path)).text;
  expect(original).toBe('# Why Memos\n\nA post.');

  await expect(page.getByTestId('publish-badge')).toHaveText('Draft');
  await page.getByRole('button', { name: 'Publish…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Publish this post?' });
  await expect(confirm).toContainText('public once it syncs');
  await confirm.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByTestId('publish-badge')).toHaveText('Published');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  expect((await readQuiet(page, path)).text).toBe(`---\npublished: true\n---\n${original}`);

  // Unpublishing needs no confirmation and restores the text exactly.
  await page.getByRole('button', { name: 'Unpublish' }).click();
  await expect(page.getByTestId('publish-badge')).toHaveText('Draft');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  expect((await readQuiet(page, path)).text).toBe(original);
});

test('rename and delete a note', async ({ page }) => {
  await importBrain(page);
  const note = await someMemo(page);
  const total = (await status(page)).notes.total;
  await clientGo(page, `/note/${note.path}`);
  await page.getByRole('button', { name: 'Rename' }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename or move this note' });
  const to = note.path.replace(/\.md$/, '-renamed.md');
  await dialog.getByLabel('New path').fill(to);
  await dialog.getByRole('button', { name: 'Rename' }).click();
  await expect(page.locator('.meta .path')).toHaveText(to);
  expect(page.url()).toContain(encodeURI(to).replace(/#/g, '%23'));

  await page.getByRole('button', { name: 'Delete' }).click();
  await page
    .getByRole('dialog', { name: 'Delete this note?' })
    .getByRole('button', { name: 'Delete note' })
    .click();
  await expect(page).toHaveURL(/\/$/);
  expect((await status(page)).notes.total).toBe(total - 1);
});

test('the theme toggle overrides the system theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const light = await bg();
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await bg()).not.toBe(light);
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
  expect(await bg()).toBe(light);
});

test('no screen scrolls sideways', async ({ page }) => {
  await importBrain(page);
  await expectNoHorizontalScroll(page);
  const note = await someMemo(page);
  for (const name of ['Search', 'Hot', 'Trending', 'Neglected', 'New', 'More']) {
    await nav(page, name);
    await page.waitForTimeout(150);
    await expectNoHorizontalScroll(page);
  }
  await nav(page, 'Search');
  await page.getByRole('searchbox').fill('frost');
  await page.getByText('Why this rank').first().click();
  await expectNoHorizontalScroll(page);
  await clientGo(page, `/note/${note.path}`);
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await clientGo(page, `/edit/${note.path}`);
  await expect(page.locator('.cm-content')).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test('the save controls stay visible when the screen gets short', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'phone only');
  await importBrain(page);
  const note = await someMemo(page);
  await clientGo(page, `/edit/${note.path}`);
  await page.locator('.cm-content').click();
  // An on-screen keyboard leaves about this much of the screen.
  await page.setViewportSize({ width: 390, height: 420 });
  await page.waitForTimeout(200);
  await expect(page.getByRole('button', { name: 'Save' })).toBeInViewport();
  const box = await page.locator('.cm-editor').boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(421);
  expect(box!.height).toBeGreaterThan(120);
});

test('keyboard shortcuts on a desktop', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop only');
  await page.goto('/more');
  await expect(page.getByRole('heading', { level: 1, name: 'More' })).toBeVisible();
  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox')).toBeFocused();
  await page.locator('body').click();
  await page.keyboard.press('n');
  await expect(page.getByRole('heading', { level: 1, name: 'New note' })).toBeVisible();
});

test('unsaved text survives a reload as a draft', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => 'somememos' in globalThis);
  await clientGo(page, '/edit/memos/draft-test.md');
  await typeAtEnd(page, 'Draft words.');
  await page.waitForTimeout(500);
  page.on('dialog', (d) => void d.accept());
  await page.reload();
  await expect(page.getByText(/Restored your unsaved changes/)).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('Draft words.');
});
