import { describe, expect, it } from 'vitest';
import {
  contentFingerprint,
  contentHash,
  createMemoryContentStore,
  sha256Hex,
  utf8Length,
} from './content.js';

describe('content hashing', () => {
  it('is SHA-256 of the UTF-8 text, hex (the same as the CLI has always stored)', async () => {
    expect(await contentHash('café\n')).toBe(
      '7b49b9e063bd91a4f9252b413261f5557b9c570aa61516989499f64a62dbcdd6',
    );
    expect(await sha256Hex(new TextEncoder().encode('café\n'))).toBe(await contentHash('café\n'));
    expect(utf8Length('café')).toBe(5);
  });

  it('fingerprints by the store token, else size, mtime and hash', () => {
    expect(contentFingerprint({ path: 'a.md', size: 3, mtime: 9, fingerprint: 'x' })).toBe('x');
    expect(contentFingerprint({ path: 'a.md', size: 3, mtime: 9, hash: 'h' })).toBe('3:9:h');
    expect(contentFingerprint({ path: 'a.md', size: 3, mtime: 9 })).toBe('3:9:');
  });
});

describe('createMemoryContentStore', () => {
  it('writes, lists, renames and removes, keeping text byte for byte', async () => {
    const content = createMemoryContentStore({ now: () => 50 });
    const text = '# Ünïcode\r\n\ttabs  \n';
    const entry = await content.write('memos/a.md', text);
    expect(entry).toEqual({
      path: 'memos/a.md',
      size: utf8Length(text),
      mtime: 50,
      hash: await contentHash(text),
    });
    await content.write('memos/b.md', 'b', { mtime: 7 });
    expect((await content.list()).map((e) => e.path).sort()).toEqual(['memos/a.md', 'memos/b.md']);
    await content.rename('memos/b.md', 'memos/c.md');
    expect(await content.stat('memos/c.md')).toMatchObject({ mtime: 7 });
    expect(() => content.rename('memos/b.md', 'memos/x.md')).toThrow(RangeError);
    expect(() => content.rename('memos/c.md', 'memos/a.md')).toThrow(RangeError);
    expect(await content.remove('memos/c.md')).toBe(true);
    expect(await content.remove('memos/c.md')).toBe(false);
    expect(await content.read('memos/a.md')).toBe(text);
    expect(content.snapshot()).toEqual({ 'memos/a.md': text });
  });
});
