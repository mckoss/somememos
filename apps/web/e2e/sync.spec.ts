// Sync between two devices (two browser contexts) through the real server
// with a real Postgres (playwright.sync.config.ts, e2e/sync-setup.ts).
// Invented content only: the brain comes from `generateBrain`.

import { expect, test, type Page } from '@playwright/test';
import { typeAtEnd } from './fixtures.ts';
import {
  TEST_TOKEN,
  baseURL,
  clientGo,
  connectViaUi,
  engineCall,
  expectSynced,
  newDevice,
  openSyncSettings,
  serverStatus,
  skipWithoutServer,
  status,
  syncCall,
  twoDevices,
  uniqueBrainId,
  type SyncViewLike,
} from './sync-fixtures.ts';
import { OTHER_TOKEN, freePort, startServer } from './sync-server.ts';
import { importBrain } from './fixtures.ts';

skipWithoutServer();

interface NoteView {
  path: string;
  text: string;
  hash: string;
}

const read = (page: Page, path: string) =>
  engineCall<NoteView>(page, 'readNote', path, { record: false });
const titles = (page: Page) =>
  engineCall<{ path: string }[]>(page, 'noteTitles').then((t) => t.map((n) => n.path));

/** A memo of the invented brain, by position. */
async function memo(page: Page, n: number): Promise<string> {
  const paths = (await titles(page)).filter(
    (p) => p.startsWith('memos/') && !p.includes('.conflict-'),
  );
  return paths[n] as string;
}

test('a device uploads, another downloads; an edit with its message reaches the other; events count once', async ({
  browser,
  page,
}, info) => {
  // Not connected: no indicator at all.
  await page.goto('/');
  await page.waitForFunction(() => 'somememos' in globalThis);
  await expect(page.getByTestId('sync-indicator')).toHaveCount(0);

  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));

  const { a, b, brainId } = await twoDevices(browser, page, info, 'main');
  const aStatus = await status(a);
  const bStatus = await status(b.page);
  const server = await serverStatus(brainId);
  expect(bStatus.notes.total).toBe(aStatus.notes.total);
  expect(server.notes.total).toBe(aStatus.notes.total);
  expect(bStatus.events).toEqual(aStatus.events);
  expect(server.events).toEqual(aStatus.events);
  // The download was paged (the test server sends 10 mutations a page).
  const bView = await syncCall(b.page, 'status');
  expect(bView.brainId).toBe(brainId);

  // Hot lists agree: B scores A's events, counted once.
  const hot = async (p: Page) =>
    (
      await engineCall<{ results: { item: string }[] }>(p, 'list', 'hot', { limit: 10 })
    ).results.map((r) => r.item);
  expect(await hot(b.page)).toEqual(await hot(a));

  // An edit on A, with a change message, through the editor.
  const path = await memo(a, 0);
  await clientGo(a, `/edit/${path}`);
  await expect(a.locator('.cm-content')).toBeVisible();
  await typeAtEnd(a, '\n\nA line added on the first device.\n');
  await a.getByPlaceholder(/What changed/).fill('Added a line from device one');
  await a.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(a.getByText('Saved.')).toBeVisible();
  // Automatic sync, a few seconds after the save.
  await expect(a.getByTestId('sync-indicator')).toHaveAttribute('data-state', /waiting|syncing/);
  await expectSynced(a);
  await expect.poll(async () => (await syncCall(a, 'status')).pending.notes).toBe(0);

  // B picks it up on its next sync ("Sync now").
  await openSyncSettings(b.page);
  await b.page.getByTestId('sync-now').click();
  await expect
    .poll(async () => (await read(b.page, path)).text)
    .toContain('A line added on the first device.');
  await expectSynced(b.page);
  const afterA = await status(a);
  const afterB = await status(b.page);
  expect(afterB.events).toEqual(afterA.events);
  expect((await serverStatus(brainId)).events).toEqual(afterA.events);
  await clientGo(b.page, `/note/${path}`);
  await expect(b.page.getByText('Added a line from device one')).toBeVisible();

  // The token never shows: not in the DOM, web storage, a URL, or the exported log.
  for (const p of [a, b.page]) {
    await openSyncSettings(p);
    await expect(p.getByTestId('sync-token-hint')).toHaveText(`••••••••${TEST_TOKEN.slice(-4)}`);
    expect(await p.content()).not.toContain(TEST_TOKEN);
    const stored = await p.evaluate(() =>
      JSON.stringify([{ ...localStorage }, { ...sessionStorage }, location.href]),
    );
    expect(stored).not.toContain(TEST_TOKEN);
    expect(await engineCall<string>(p, 'exportLog')).not.toContain(TEST_TOKEN);
    expect(JSON.stringify(await syncCall(p, 'status'))).not.toContain(TEST_TOKEN);
  }
  expect(requests.length).toBeGreaterThan(0);
  for (const url of requests) expect(url).not.toContain(TEST_TOKEN);
  await b.context.close();
});

test('offline edits on both devices queue up and sync when back online; a same-note edit becomes a conflict', async ({
  browser,
  page,
}, info) => {
  const { a, b, brainId } = await twoDevices(browser, page, info, 'offline');
  const [p1, p2, p3] = [await memo(a, 1), await memo(a, 2), await memo(a, 3)];

  // Both go offline and edit different notes.
  await a.context().setOffline(true);
  await b.context.setOffline(true);
  const textA = `${(await read(a, p1)).text}\nWritten on device one while offline.\n`;
  const textB = `${(await read(b.page, p2)).text}\nWritten on device two while offline.\n`;
  await engineCall(a, 'saveNote', p1, textA, { message: 'offline edit one' });
  await engineCall(b.page, 'saveNote', p2, textB, { message: 'offline edit two' });
  await expect(a.getByTestId('sync-indicator')).toHaveAttribute('data-state', 'offline');
  await expect(b.page.getByTestId('sync-indicator')).toHaveAttribute('data-state', 'offline');
  expect((await syncCall(a, 'status')).pending.notes).toBe(1);

  // Back online: they sync without a click.
  await a.context().setOffline(false);
  await expectSynced(a);
  await b.context.setOffline(false);
  await expectSynced(b.page);
  expect((await read(b.page, p1)).text).toBe(textA);
  await syncCall(a, 'syncNow');
  expect((await read(a, p2)).text).toBe(textB);

  // The same note, changed on both: A syncs first, B's version becomes a conflict copy.
  const base = (await read(a, p3)).text;
  const mineA = `${base}\nDevice one's ending.\n`;
  const mineB = `${base}\nDevice two's ending.\n`;
  await b.context.setOffline(true);
  await engineCall(a, 'saveNote', p3, mineA, {});
  await syncCall(a, 'syncNow');
  await engineCall(b.page, 'saveNote', p3, mineB, {});
  await b.context.setOffline(false);
  await expect(b.page.getByTestId('sync-indicator')).toHaveAttribute('data-state', 'attention', {
    timeout: 30_000,
  });
  // Both texts are kept: the server's at the note, B's in the conflict copy.
  expect((await read(b.page, p3)).text).toBe(mineA);
  const conflicts = await syncCall<
    { path: string; original: string; mine: string; theirs: string }[]
  >(b.page, 'conflicts');
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]).toMatchObject({ original: p3, mine: mineB, theirs: mineA });
  // The conflict copy syncs like any note; device one sees it too.
  await syncCall(a, 'syncNow');
  await expect.poll(async () => (await syncCall(a, 'status')).conflicts).toBe(1);

  // Resolve on B: keep this device's version.
  await clientGo(b.page, '/');
  await expect(b.page.getByTestId('conflicts-notice')).toBeVisible();
  await b.page.getByTestId('conflicts-notice').getByRole('link', { name: 'Review' }).click();
  const item = b.page.getByTestId('sync-conflict');
  await expect(item.getByTestId('conflict-mine')).toContainText("Device two's ending.");
  await expect(item.getByTestId('conflict-theirs')).toContainText("Device one's ending.");
  await item.getByRole('button', { name: 'Keep this device’s' }).click();
  await expect(b.page.getByTestId('conflict-message')).toContainText('Kept this device’s version');
  await expect(b.page.getByTestId('sync-conflict')).toHaveCount(0);
  expect((await read(b.page, p3)).text).toBe(mineB);
  await expectSynced(b.page);
  await syncCall(a, 'syncNow');
  expect((await read(a, p3)).text).toBe(mineB);
  expect((await syncCall(a, 'status')).conflicts).toBe(0);
  expect((await serverStatus(brainId)).notes.total).toBe((await status(a)).notes.total);
  await b.context.close();
});

test('a rename and a delete reach the other device', async ({ browser, page }, info) => {
  test.skip(info.project.name !== 'desktop', 'one viewport is enough');
  const { a, b } = await twoDevices(browser, page, info, 'rename');
  const from = await memo(a, 4);
  const gone = await memo(a, 5);
  const to = from.replace(/\.md$/, '-renamed.md');
  await engineCall(a, 'renameNote', from, to, { message: 'renamed on device one' });
  await engineCall(a, 'deleteNote', gone, { message: 'deleted on device one' });
  await expectSynced(a);
  await expect.poll(async () => (await syncCall(a, 'status')).pending.notes).toBe(0);
  await syncCall(b.page, 'syncNow');
  const onB = await titles(b.page);
  expect(onB).toContain(to);
  expect(onB).not.toContain(from);
  expect(onB).not.toContain(gone);
  expect((await status(b.page)).events).toEqual((await status(a)).events);
  await b.context.close();
});

test('a blog post says "waiting to sync" until the server has it', async ({ page }, info) => {
  const brainId = uniqueBrainId(info, 'blog');
  await importBrain(page, { blog: true });
  const post = 'blog/2026/2026-11-20-a-small-post.md';
  await engineCall(page, 'saveNote', post, '# A small post\n\nInvented words for a test.\n', {});
  await connectViaUi(page, { brain: { create: brainId }, kind: 'create-upload' });
  await expectSynced(page);
  await clientGo(page, `/note/${post}`);
  await expect(page.getByTestId('publish-badge')).toHaveText('Draft');

  await page.context().setOffline(true);
  await page.getByRole('button', { name: /Publish…/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByTestId('publish-badge')).toHaveText('Published, waiting to sync');
  await page.context().setOffline(false);
  await expect(page.getByTestId('publish-badge')).toHaveText('Published', { timeout: 30_000 });
  await expect(page.getByTestId('publish-badge')).toHaveAttribute('data-sync', 'synced');
});

test('a second tab on the same device shows the same status', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'one viewport is enough');
  const brainId = uniqueBrainId(info, 'tabs');
  await importBrain(page);
  await connectViaUi(page, { brain: { create: brainId }, kind: 'create-upload' });
  await expectSynced(page);
  const second = await page.context().newPage();
  await second.goto('/more#sync');
  await expect(second.getByTestId('sync-indicator')).toHaveAttribute('data-state', 'synced');
  await expect(second.getByTestId('runs-in-other-tab')).toBeVisible();
  await expect(second.getByTestId('sync-status')).toContainText(brainId);
  // A change made in the second tab is synced by the first (which runs the brain), and both see it.
  await page.context().setOffline(true);
  const path = await memo(second, 0);
  const text = `${(await read(second, path)).text}\nFrom the second tab.\n`;
  await engineCall(second, 'saveNote', path, text, {});
  await expect(second.getByTestId('sync-indicator')).toHaveAttribute('data-state', 'offline');
  await expect(page.getByTestId('sync-indicator')).toHaveAttribute('data-state', 'offline');
  await page.context().setOffline(false);
  await expectSynced(second);
  await expectSynced(page);
});

test('a token the server no longer accepts needs attention and stops retrying until fixed', async ({
  browser,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'one viewport is enough');
  // A server of its own, so its token can change.
  const port = freePort();
  const shared = {
    port,
    databaseUrl: process.env.SYNC_E2E_DATABASE_URL as string,
    dataDir: process.env.SYNC_E2E_DATA_DIR as string,
  };
  let server = await startServer({ ...shared, token: TEST_TOKEN });
  const device = await newDevice(browser, info, server.url);
  const { page } = device;
  try {
    await importBrain(page);
    await connectViaUi(page, {
      brain: { create: uniqueBrainId(info, 'token') },
      kind: 'create-upload',
    });
    await expectSynced(page);

    await server.stop();
    server = await startServer({ ...shared, token: OTHER_TOKEN });
    await syncCall(page, 'syncNow');
    await expect(page.getByTestId('sync-indicator')).toHaveAttribute('data-state', 'attention');
    let view = await syncCall(page, 'status');
    expect(view.problem?.kind).toBe('auth');
    expect(view.autoSync).toBe(false);
    expect(view.failures).toBe(1);

    // Nothing automatic tries again: not a change, not coming online, not becoming visible.
    const path = await memo(page, 0);
    await engineCall(page, 'saveNote', path, `${(await read(page, path)).text}\nmore\n`, {});
    await page.evaluate(() =>
      (
        globalThis as unknown as {
          somememos: { host: { sync: { hint(k: string): Promise<void> } } };
        }
      ).somememos.host.sync.hint('online'),
    );
    await page.waitForTimeout(6_000);
    view = await syncCall(page, 'status');
    expect(view.failures).toBe(1);
    expect(view.nextAttemptAt).toBeNull();
    expect(view.indicator).toBe('attention');

    // Fixing the token resumes sync.
    await openSyncSettings(page);
    await expect(page.getByTestId('sync-problem')).toContainText('didn’t accept');
    await page.getByTestId('sync-new-token').fill(OTHER_TOKEN);
    await page.getByRole('button', { name: 'Save token' }).click();
    await expectSynced(page);
    expect(await page.content()).not.toContain(OTHER_TOKEN);
  } finally {
    await device.context.close();
    await server.stop();
  }
});

test('connecting to a different brain than before asks first; disconnect keeps the notes', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'one viewport is enough');
  const first = uniqueBrainId(info, 'first');
  const second = uniqueBrainId(info, 'second');
  await importBrain(page);
  const notes = (await status(page)).notes.total;
  await connectViaUi(page, { brain: { create: first }, kind: 'create-upload' });
  await expectSynced(page);

  await openSyncSettings(page);
  await page.getByRole('button', { name: 'Disconnect…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByTestId('sync-indicator')).toHaveCount(0);
  expect((await status(page)).notes.total).toBe(notes);
  await expect(page.locator('#sync')).toContainText(`last synced with ${first}`);

  // A different brain: the plan says so and waits for a yes.
  await connectViaUi(page, {
    brain: { create: second },
    kind: 'create-upload',
    before: async (step) => {
      if (step !== 'plan') return;
      const plan = page.getByTestId('sync-plan');
      await expect(plan).toContainText(`last synced with “${first}”`);
      await expect(plan.getByRole('button', { name: 'Yes, connect' })).toBeVisible();
    },
  });
  await expectSynced(page);
  expect((await serverStatus(second)).notes.total).toBe(notes);
});

test('the sync view reports the first download in pages', async ({ browser, page }, info) => {
  test.skip(info.project.name !== 'phone', 'one viewport is enough');
  const { b } = await twoDevices(browser, page, info, 'paged');
  const view = await b.page.evaluate(() =>
    (
      globalThis as unknown as {
        somememos: { host: { sync: { status(): Promise<SyncViewLike> } } };
      }
    ).somememos.host.sync.status(),
  );
  expect(view.lastRun?.rounds ?? 0).toBeGreaterThan(1);
  expect(baseURL()).toContain('127.0.0.1');
  await b.context.close();
});
