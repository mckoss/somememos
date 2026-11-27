import { describe, expect, it } from 'vitest';
import rootPkg from '../../../../package.json' with { type: 'json' };
import { APP_VERSION } from './version';

describe('APP_VERSION', () => {
  it('is the root package.json version', () => {
    expect(APP_VERSION).toBe(rootPkg.version);
  });
});
