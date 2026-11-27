import { describe, expect, it } from 'vitest';
import {
  ConnectPlanError,
  brainIdFromName,
  canonicalJson,
  compareVersions,
  describePlan,
  maskToken,
  parseConflictPath,
  planConnect,
  type ConnectFacts,
} from './connect-plan.ts';

const ROLES = { memo: ['memos/'], dated: ['diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md'] };
const config = (roles: object = ROLES, extra: object = {}) => ({
  version: 1,
  roles,
  halfLives: { day: 86_400 },
  ...extra,
});

const facts = (over: Partial<ConnectFacts> = {}): ConnectFacts => ({
  brainId: 'main',
  create: false,
  exists: true,
  serverMutation: 40,
  serverConfig: config(),
  localConfig: config(),
  localNotes: 0,
  hasSyncState: false,
  previous: null,
  origin: 'https://example.test',
  ...over,
});

describe('planConnect', () => {
  it('creates and uploads when the device has notes and the server has no such brain', () => {
    const plan = planConnect(
      facts({ create: true, exists: false, serverConfig: null, localNotes: 12 }),
    );
    expect(plan).toMatchObject({
      kind: 'create-upload',
      create: true,
      needsConfirmation: false,
      rolesDiffer: false,
      differentBrain: false,
    });
  });

  it('creates an empty brain from an empty device', () => {
    expect(planConnect(facts({ create: true, exists: false, serverConfig: null })).kind).toBe(
      'create-empty',
    );
  });

  it('downloads into an empty device, taking the server roles without asking', () => {
    const plan = planConnect(facts({ localConfig: config({ memo: [''] }) }));
    expect(plan).toMatchObject({ kind: 'download', rolesDiffer: true, needsConfirmation: false });
  });

  it('asks before combining when both have notes', () => {
    const plan = planConnect(facts({ localNotes: 3 }));
    expect(plan).toMatchObject({ kind: 'merge', needsConfirmation: true, rolesDiffer: false });
  });

  it('notes when the roles differ on a merge (the server wins after confirmation)', () => {
    const plan = planConnect(facts({ localNotes: 3, localConfig: config({ memo: ['notes/'] }) }));
    expect(plan).toMatchObject({ kind: 'merge', rolesDiffer: true, needsConfirmation: true });
    expect(describePlan(plan).details.join(' ')).toMatch(/server’s replace them/);
  });

  it('uploads into an empty server brain, asking only when the roles would re-sort notes', () => {
    expect(planConnect(facts({ serverMutation: 0, localNotes: 5 }))).toMatchObject({
      kind: 'upload',
      needsConfirmation: false,
    });
    expect(
      planConnect(
        facts({ serverMutation: 0, localNotes: 5, localConfig: config({ memo: ['x/'] }) }),
      ),
    ).toMatchObject({ kind: 'upload', rolesDiffer: true, needsConfirmation: true });
    expect(planConnect(facts({ serverMutation: 0 })).kind).toBe('empty');
  });

  it('compares configs regardless of key order, and tells settings from roles', () => {
    const plan = planConnect(
      facts({
        serverConfig: { halfLives: { day: 86_400 }, roles: ROLES, version: 1 },
        localConfig: config({ dated: ROLES.dated, memo: ROLES.memo }),
      }),
    );
    expect(plan).toMatchObject({ rolesDiffer: false, settingsDiffer: false });
    expect(planConnect(facts({ localConfig: config(ROLES, { alpha: 2 }) })).settingsDiffer).toBe(
      true,
    );
  });

  it('resumes the brain this device synced with, without asking', () => {
    const plan = planConnect(
      facts({
        localNotes: 30,
        hasSyncState: true,
        previous: { brainId: 'main', origin: 'https://example.test' },
      }),
    );
    expect(plan).toMatchObject({ kind: 'resume', differentBrain: false, needsConfirmation: false });
  });

  it('never merges silently into a different brain than before', () => {
    const plan = planConnect(
      facts({
        brainId: 'work',
        localNotes: 30,
        hasSyncState: true,
        previous: { brainId: 'main', origin: 'https://example.test' },
      }),
    );
    expect(plan).toMatchObject({
      kind: 'merge',
      differentBrain: true,
      previousBrainId: 'main',
      needsConfirmation: true,
    });
    expect(describePlan(plan).details.join(' ')).toMatch(/last synced with “main”/);
  });

  it('treats the same brain id on another server, or a sync record it cannot place, as different', () => {
    expect(
      planConnect(
        facts({
          hasSyncState: true,
          previous: { brainId: 'main', origin: 'https://other.test' },
        }),
      ),
    ).toMatchObject({ differentBrain: true, needsConfirmation: true, kind: 'download' });
    expect(planConnect(facts({ hasSyncState: true, previous: null }))).toMatchObject({
      differentBrain: true,
      needsConfirmation: true,
    });
  });

  it('asks before pushing a device that synced elsewhere into a new brain', () => {
    expect(
      planConnect(
        facts({
          create: true,
          exists: false,
          serverConfig: null,
          localNotes: 4,
          hasSyncState: true,
          previous: { brainId: 'main', origin: 'https://example.test' },
        }),
      ),
    ).toMatchObject({ kind: 'create-upload', differentBrain: true, needsConfirmation: true });
  });

  it('refuses to create a brain that exists, or to join one that does not', () => {
    expect(() => planConnect(facts({ create: true }))).toThrow(ConnectPlanError);
    expect(() => planConnect(facts({ exists: false, serverConfig: null }))).toThrow(
      /no brain called “main”/,
    );
  });
});

describe('describePlan', () => {
  it('explains a merge plainly: combined, a differing note kept twice', () => {
    const { title, details } = describePlan(planConnect(facts({ localNotes: 1 })));
    expect(title).toBe('Combine this device’s 1 note with the notes in “main”.');
    expect(details.join(' ')).toMatch(/kept twice/);
    expect(details.join(' ')).toMatch(/conflict copy/);
  });
});

describe('helpers', () => {
  it('canonicalJson sorts keys at every level and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('brainIdFromName makes a server brain id', () => {
    expect(brainIdFromName('My Notes')).toBe('my-notes');
    expect(brainIdFromName('  Café — 2026!  ')).toBe('cafe-2026');
    expect(brainIdFromName('---')).toBe('');
    expect(brainIdFromName('x'.repeat(80))).toHaveLength(63);
    expect(brainIdFromName(`${'a'.repeat(62)} b`)).toBe('a'.repeat(62));
  });

  it('parseConflictPath reads conflict copy names', () => {
    expect(parseConflictPath('memos/plan.conflict-3f2a-b1-2026-11-27.md')).toEqual({
      original: 'memos/plan.md',
      client: '3f2a-b1',
      date: '2026-11-27',
    });
    expect(parseConflictPath('memos/plan.conflict-dev-2026-11-27-3.md')?.original).toBe(
      'memos/plan.md',
    );
    expect(parseConflictPath('memos/plan.md')).toBeNull();
    expect(parseConflictPath('memos/.conflict-a-2026-11-27.md')).toBeNull();
  });

  it('compareVersions starts the side-by-side view just before the first difference', () => {
    const top = ['# T', 'a', 'b', 'c', 'd', 'e'].join('\n');
    expect(compareVersions(`${top}\nmine`, `${top}\ntheirs`)).toEqual({
      same: 5,
      mine: 'e\nmine',
      theirs: 'e\ntheirs',
    });
    expect(compareVersions('a\nb', 'a\nc')).toEqual({ same: 0, mine: 'a\nb', theirs: 'a\nc' });
    expect(compareVersions('x', null)).toEqual({ same: 0, mine: 'x', theirs: null });
  });

  it('maskToken shows only the last four characters', () => {
    expect(maskToken('cdef')).toBe('••••••••cdef');
    expect(maskToken(null)).toBe('');
  });
});
