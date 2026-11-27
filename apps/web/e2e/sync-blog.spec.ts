// The blog settings screen (More → Public blog) end to end, through the real
// server with a real Postgres (playwright.sync.config.ts): live checks of the
// public name, turning the blog on, a published post's public address, and
// turning it off again. Invented content only.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, importBrain } from './fixtures.ts';
import {
  TEST_TOKEN,
  baseURL,
  clientGo,
  connectViaUi,
  engineCall,
  expectSynced,
  skipWithoutServer,
  syncCall,
  uniqueBrainId,
} from './sync-fixtures.ts';

skipWithoutServer();

const SHOTS =
  process.env.GAPS_SCREENSHOT_DIR ??
  join(import.meta.dirname, '../../../node_modules/.cache/somememos-e2e/screens-gaps');
mkdirSync(SHOTS, { recursive: true });

const api = (method: string, path: string, body?: unknown) =>
  fetch(`${baseURL()}/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

test('blog settings: a checked name, on with confirmation, a public post, then off', async ({
  page,
}, info) => {
  const brainId = uniqueBrainId(info, 'blog');
  const suffix = brainId.split('-').at(-1) as string;
  const slug = `invented-${suffix}`;
  const takenSlug = `taken-${suffix}`;

  // Another brain on the server already has a blog called `takenSlug`.
  const other = `${brainId}-other`;
  expect((await api('POST', '/brains', { id: other })).status).toBe(201);
  expect(
    (
      await api('PUT', `/brains/${other}/blog`, {
        enabled: true,
        slug: takenSlug,
        title: 'Someone else',
      })
    ).status,
  ).toBe(200);

  await importBrain(page, { blog: true });
  // Not connected: there is no blog section.
  await expect(page.locator('#blog')).toHaveCount(0);
  await connectViaUi(page, { brain: { create: brainId }, kind: 'create-upload' });
  await expectSynced(page);

  await clientGo(page, '/more#blog');
  const section = page.getByTestId('blog-settings');
  await expect(section).toContainText('published: true');
  await expect(section).toContainText('takes every page down');
  const state = section.getByTestId('blog-slug-state');
  const slugInput = section.getByLabel('Public name');
  const save = section.getByRole('button', { name: 'Save blog settings' });

  await slugInput.fill('Bad Name');
  await expect(state).toContainText('lower-case');
  await slugInput.fill('api');
  await expect(state).toContainText('reserved');
  await slugInput.fill(takenSlug);
  await expect(state).toContainText('another blog on this server has that name');
  await slugInput.fill(slug);
  await expect(state).toContainText('Available.');
  await section.getByLabel('Title').fill('Invented field notes');
  await section.getByLabel(/^Description/).fill('Notes about invented things.');
  await section.getByLabel(/^Author/).fill('A. Writer');
  await section.getByTestId('blog-enabled').check();
  await page.locator('#blog').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS, `blog-settings-${info.project.name}.png`) });
  await expectNoHorizontalScroll(page);

  // Turning it on asks first; cancelling changes nothing.
  await save.click();
  const dialog = page.getByRole('dialog', { name: 'Turn your blog on?' });
  await expect(dialog).toContainText(`/blog/${slug}/`);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(
    ((await (await api('GET', `/brains/${brainId}/blog`)).json()) as { enabled: boolean }).enabled,
  ).toBe(false);
  await save.click();
  await page
    .getByRole('dialog', { name: 'Turn your blog on?' })
    .getByRole('button', { name: 'Turn it on' })
    .click();
  await expect(section.getByTestId('blog-message')).toContainText('Your blog is on');
  const address = section.getByTestId('blog-address').getByRole('link');
  await expect(address).toHaveAttribute('href', `${baseURL()}/blog/${slug}/`);
  await page.locator('#blog').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS, `blog-settings-on-${info.project.name}.png`) });

  // A published post syncs and is public; its page shows the address.
  const post = 'blog/first-light.md';
  await engineCall(
    page,
    'saveNote',
    post,
    '---\npublished: true\n---\n# First light\n\nA morning walk.\n',
    {
      message: 'a first post',
    },
  );
  await syncCall(page, 'syncNow');
  const publicUrl = `${baseURL()}/blog/${slug}/p/first-light`;
  const live = await fetch(publicUrl);
  expect(live.status).toBe(200);
  expect(await live.text()).toContain('First light');
  await clientGo(page, `/note/${post}`);
  await expect(page.getByTestId('post-address')).toHaveAttribute('href', publicUrl);
  await page.screenshot({ path: join(SHOTS, `post-address-${info.project.name}.png`) });

  // Turning it off asks, then every page is gone.
  await clientGo(page, '/more#blog');
  await section.getByTestId('blog-enabled').uncheck();
  await save.click();
  await page
    .getByRole('dialog', { name: 'Turn your blog off?' })
    .getByRole('button', { name: 'Turn it off' })
    .click();
  await expect(section.getByTestId('blog-message')).toContainText('Every public page is gone');
  await expect(section.getByTestId('blog-address')).toHaveCount(0);
  expect((await fetch(publicUrl)).status).toBe(404);
  expect((await fetch(`${baseURL()}/blog/${slug}/`)).status).toBe(404);
});
