import { describe, expect, it } from 'vitest';
import { createRoleClassifier } from '../markdown/roles.js';
import { hasNonMarkdownExtension } from '../markdown/paths.js';
import { parseBrainConfig } from '../storage/config.js';
import { createMemoryContentStore, type ContentStore } from '../storage/content.js';
import { createMemoryStores } from '../storage/memory.js';
import { derivedId, listContent, runIndexPass } from './pass.js';

const config = parseBrainConfig({
  clientId: 'c',
  roles: { memo: ['memos/'], excluded: ['private/'] },
});

describe('derivedId', () => {
  it('is ix- plus SHA-256 of the parts joined by NUL (ids already in event logs)', async () => {
    expect(await derivedId('edit', 'memos/a.md', '', 'abc', 100)).toBe(
      'ix-1f0e3ea20eafce17379a21955a4e0f41d13479ce863b7fb2603d9912ce491b76',
    );
  });
});

describe('attachment targets', () => {
  it('have an extension other than .md with a letter in it', () => {
    for (const t of ['photo.png', 'a/b/scan.PDF', 'drawing.excalidraw', ' x.jpeg ']) {
      expect(hasNonMarkdownExtension(t), t).toBe(true);
    }
    for (const t of ['note', 'note.md', 'v1.2', 'Dr. Smith', '.hidden', 'a.b/c']) {
      expect(hasNonMarkdownExtension(t), t).toBe(false);
    }
  });
});

describe('listContent', () => {
  it('classifies markdown files, keeps excluded ones apart, and ignores the rest', async () => {
    const content = createMemoryContentStore({ now: () => 1 });
    for (const path of ['memos/a.md', 'private/p.md', 'other/x.md', 'memos/photo.png']) {
      await content.write(path, 'x');
    }
    const listing = await listContent(content, createRoleClassifier(config.roles));
    expect([...listing.files.keys()]).toEqual(['memos/a.md']);
    expect([...listing.excluded]).toEqual(['private/p.md']);
  });
});

describe('runIndexPass paths', () => {
  it('re-reads the given paths even when their fingerprint did not change', async () => {
    const files = createMemoryContentStore({ now: () => 100 });
    // A store whose fingerprint never changes (a coarse clock and no hash).
    const coarse: ContentStore = {
      ...files,
      list: async () =>
        (await files.list()).map(({ hash: _h, ...e }) => ({ ...e, fingerprint: 'same' })),
    };
    const stores = createMemoryStores({ now: () => 200 });
    await files.write('memos/a.md', '# A\n');
    await runIndexPass({ stores, content: coarse, config, now: () => 200 });
    await files.write('memos/a.md', '# A\n\n[[b]]\n');
    const missed = await runIndexPass({ stores, content: coarse, config, now: () => 200 });
    expect(missed.indexed).toBe(0);
    const seen = await runIndexPass({
      stores,
      content: coarse,
      config,
      now: () => 200,
      paths: ['memos/a.md'],
    });
    expect(seen).toMatchObject({ indexed: 1, events: { edit: 1, mention: 1, rename: 0 } });
  });
});
