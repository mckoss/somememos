import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FOLDER_ROLES } from '../markdown/roles.js';
import { HALF_LIVES } from '../timescore/halfLives.js';
import { UNIT_WEIGHTS } from '../timescore/weights.js';
import {
  ConfigError,
  defaultBrainConfig,
  foldOptions,
  parseBrainConfig,
  serializeBrainConfig,
} from './config.js';
import { decodePositions, encodePositions } from './positions.js';
import { newEvent, newRename, parseSectionId, sectionId } from './validate.js';

describe('positions codec', () => {
  it('round-trips any ascending positions (property)', () => {
    const field = fc
      .uniqueArray(fc.integer({ min: 0, max: 1_000_000 }), { maxLength: 30 })
      .map((a) => a.sort((x, y) => x - y));
    fc.assert(
      fc.property(field, field, field, (title, heading, body) => {
        const positions = { title, heading, body };
        const bytes = encodePositions(positions);
        const counts = { title: title.length, heading: heading.length, body: body.length };
        expect(decodePositions(bytes, counts)).toEqual(positions);
      }),
    );
  });

  it('takes one byte per occurrence for nearby positions', () => {
    const bytes = encodePositions({ title: [0], heading: [], body: [0, 1, 2, 50, 127] });
    expect([...bytes]).toEqual([0, 0, 0, 0, 47, 76]);
    expect(encodePositions({ title: [], heading: [], body: [200] }).length).toBe(2);
  });

  it('rejects unsorted positions and mismatched counts', () => {
    expect(() => encodePositions({ title: [3, 1], heading: [], body: [] })).toThrow(RangeError);
    const bytes = encodePositions({ title: [1, 2], heading: [], body: [] });
    expect(() => decodePositions(bytes, { title: 1, heading: 0, body: 0 })).toThrow(RangeError);
    expect(() => decodePositions(bytes, { title: 3, heading: 0, body: 0 })).toThrow(RangeError);
  });
});

describe('ids', () => {
  it('builds and parses section ids', () => {
    expect(sectionId('memos/a#b.md', 3)).toBe('memos/a#b.md#3');
    expect(parseSectionId('memos/a#b.md#3')).toEqual({ path: 'memos/a#b.md', index: 3 });
    for (const bad of ['memos/a.md', '#3', 'memos/a.md#', 'memos/a.md#x', 'memos/a.md#01']) {
      expect(parseSectionId(bad)).toBeNull();
    }
  });

  it('makes live events and renames with fresh ids', () => {
    const a = newEvent({ kind: 'read', item: 'memos/a.md', client: 'c', time: 5 });
    const b = newEvent({ kind: 'read', item: 'memos/a.md', client: 'c' });
    expect(a).toMatchObject({ kind: 'read', item: 'memos/a.md', client: 'c', time: 5 });
    expect(a.id).not.toBe(b.id);
    expect(Number.isInteger(b.time)).toBe(true);
    expect(newRename({ item: 'a', to: 'b', client: 'c', time: 1 })).toMatchObject({
      kind: 'rename',
      item: 'a',
      to: 'b',
    });
  });
});

describe('brain config', () => {
  it('fills in every default from a minimal config', () => {
    expect(parseBrainConfig({ clientId: 'laptop-1' })).toEqual({
      version: 1,
      clientId: 'laptop-1',
      roles: {},
      halfLives: { ...HALF_LIVES },
      burstWindow: 3600,
      weights: { ...UNIT_WEIGHTS },
      alpha: 0.5,
      keyword: {},
      analyzer: { stem: true },
      changeOps: ['ingest', 'update', 'session', 'query', 'lint'],
    });
  });

  it('writes the default layout for init, and reads back what it writes', () => {
    const config = defaultBrainConfig('abc-123');
    expect(config.roles).toEqual(DEFAULT_FOLDER_ROLES);
    const text = serializeBrainConfig(config);
    expect(text.endsWith('\n')).toBe(true);
    expect(parseBrainConfig(JSON.parse(text))).toEqual(config);
  });

  it('accepts overrides', () => {
    const config = parseBrainConfig({
      $schema: 'ignored',
      version: 1,
      clientId: 'c',
      roles: { memo: ['notes/'], excluded: ['private/'] },
      halfLives: { hour: 3600, week: 604800 },
      burstWindow: 0,
      weights: { read: 0.5 },
      alpha: 0.25,
      keyword: { k1: 1.5, b: { body: 0.6 }, weights: { title: 4 } },
      analyzer: { stem: false },
      changeOps: ['ingest', 'garden'],
    });
    expect(config.halfLives).toEqual({ hour: 3600, week: 604800 });
    expect(config.burstWindow).toBe(0);
    expect(foldOptions(config)).toEqual({ halfLives: config.halfLives, burstWindow: 0 });
    expect(config.weights).toEqual({ read: 0.5, edit: 1, mention: 1 });
    expect(config.keyword).toEqual({ k1: 1.5, b: { body: 0.6 }, weights: { title: 4 } });
    expect(config.analyzer).toEqual({ stem: false });
    expect(config.changeOps).toEqual(['ingest', 'garden']);
  });

  it('lists every problem, including unknown keys', () => {
    let error: ConfigError | undefined;
    try {
      parseBrainConfig(
        {
          clientId: '',
          role: {},
          roles: { memo: 'memos/', dated: ['diary/'], archive: [] },
          halfLives: { day: -1 },
          burstWindow: -5,
          weights: { read: -1, like: 2 },
          alpha: 'high',
          keyword: { k1: 1.2, b: { body: 2 } },
          analyzer: { stem: 'yes', lang: 'en' },
          changeOps: ['Ingest'],
          version: 2,
        },
        '/brain/.somememos/config.json',
      );
    } catch (e) {
      error = e as ConfigError;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const text = error?.message ?? '';
    expect(text).toContain('/brain/.somememos/config.json is invalid');
    for (const fragment of [
      'unknown key "role"',
      'clientId: required',
      'roles.memo: must be an array',
      'unknown key "archive"',
      'Dated pattern lacks',
      'halfLives:',
      'burstWindow:',
      'weights.read',
      'unknown key "like"',
      'alpha:',
      'b.body must be in [0, 1]',
      'analyzer.stem',
      'unknown key "lang"',
      'changeOps:',
      'version: must be 1',
    ]) {
      expect(text).toContain(fragment);
    }
    expect(() => parseBrainConfig([])).toThrow(ConfigError);
    expect(() => parseBrainConfig(null)).toThrow(ConfigError);
  });
});
