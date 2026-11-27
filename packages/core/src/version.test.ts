import { describe, expect, it } from 'vitest';
import rootPkg from '../../../package.json' with { type: 'json' };
import { VERSION } from './index.js';

describe('VERSION', () => {
  it('matches the root package.json version', () => {
    expect(VERSION).toBe(rootPkg.version);
  });

  it('is a semver string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });
});
