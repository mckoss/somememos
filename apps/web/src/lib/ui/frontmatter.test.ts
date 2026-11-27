import { describe, expect, it } from 'vitest';
import { isPublished, setPublished } from './frontmatter.ts';

describe('isPublished', () => {
  it('reads published: true from the front matter', () => {
    expect(isPublished('---\npublished: true\n---\n# Post\n')).toBe(true);
    expect(isPublished('---\ntitle: A\npublished: True # live\n---\n')).toBe(true);
  });

  it('is false for drafts', () => {
    expect(isPublished('# Post\n')).toBe(false);
    expect(isPublished('---\npublished: false\n---\n')).toBe(false);
    expect(isPublished('---\npublished: "true"\n---\n')).toBe(false);
    expect(isPublished('---\npublished: yes\n---\n')).toBe(false);
    expect(isPublished('---\n  published: true\n---\n')).toBe(false); // not top level
    expect(isPublished('---\npublished: true\n')).toBe(false); // never closed
    expect(isPublished('# Post\n---\npublished: true\n---\n')).toBe(false); // not at the top
  });
});

describe('setPublished', () => {
  it('creates a front matter block when there is none', () => {
    expect(setPublished('# Post\n\nBody', true)).toBe('---\npublished: true\n---\n# Post\n\nBody');
    expect(setPublished('', true)).toBe('---\npublished: true\n---\n');
  });

  it('adds the line at the end of an existing block, keeping the rest', () => {
    const text = '---\ntitle: "Why memos"\ntags: [a, b]\n---\n# Post\n';
    expect(setPublished(text, true)).toBe(
      '---\ntitle: "Why memos"\ntags: [a, b]\npublished: true\n---\n# Post\n',
    );
  });

  it('rewrites published: false in place', () => {
    expect(setPublished('---\npublished: false\ntitle: x\n---\n', true)).toBe(
      '---\npublished: true\ntitle: x\n---\n',
    );
  });

  it('removes the line when unpublishing, keeping other keys', () => {
    expect(setPublished('---\ntitle: x\npublished: true\n---\nBody', false)).toBe(
      '---\ntitle: x\n---\nBody',
    );
  });

  it('removes a block that held only the published line', () => {
    expect(setPublished('---\npublished: true\n---\n# Post\n', false)).toBe('# Post\n');
  });

  it('round-trips a note without front matter exactly', () => {
    for (const text of ['# Post\n', '', 'no newline', '\r\n# CRLF\r\n', '\uFEFF# bom\n']) {
      expect(setPublished(setPublished(text, true), false)).toBe(text);
    }
  });

  it('keeps CRLF line endings and a byte order mark', () => {
    expect(setPublished('\uFEFF# Post\r\nBody\r\n', true)).toBe(
      '\uFEFF---\r\npublished: true\r\n---\r\n# Post\r\nBody\r\n',
    );
    expect(setPublished('---\r\ntitle: x\r\n---\r\nBody', true)).toBe(
      '---\r\ntitle: x\r\npublished: true\r\n---\r\nBody',
    );
    expect(setPublished('\uFEFF---\r\npublished: true\r\n---\r\nBody', false)).toBe('\uFEFFBody');
  });

  it('accepts a ... closing delimiter', () => {
    expect(setPublished('---\ntitle: x\n...\nBody', true)).toBe(
      '---\ntitle: x\npublished: true\n...\nBody',
    );
  });

  it('returns the text unchanged when already in that state', () => {
    const draft = '---\npublished: false\n---\n';
    expect(setPublished(draft, false)).toBe(draft);
    const live = '---\npublished: true\n---\n';
    expect(setPublished(live, true)).toBe(live);
  });

  it('the result always agrees with isPublished', () => {
    const samples = ['# a', '---\nx: 1\n---\n', '---\npublished: false\n---\n', '---\n---\nB'];
    for (const text of samples) {
      expect(isPublished(setPublished(text, true))).toBe(true);
      expect(isPublished(setPublished(setPublished(text, true), false))).toBe(false);
    }
  });
});
