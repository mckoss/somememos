import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { markdown, storage } from '@somememos/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigNotFoundError, configPath, loadBrainConfig, writeDefaultConfig } from './config.js';

describe('brain config file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'somememos-config-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the default config with a new client id, and loads it back', () => {
    const written = writeDefaultConfig(dir);
    expect(written.clientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(written.roles).toEqual(markdown.DEFAULT_FOLDER_ROLES);
    expect(loadBrainConfig(dir)).toEqual(written);
    expect(configPath(dir)).toBe(join(dir, '.somememos', 'config.json'));
    // A second init does not overwrite the client id.
    expect(() => writeDefaultConfig(dir)).toThrow(/EEXIST/);
    const again = writeDefaultConfig(dir, { clientId: 'laptop', overwrite: true });
    expect(loadBrainConfig(dir).clientId).toBe(again.clientId);
  });

  it('reports a missing file, bad JSON and invalid settings clearly', () => {
    expect(() => loadBrainConfig(dir)).toThrow(ConfigNotFoundError);
    expect(() => loadBrainConfig(dir)).toThrow(/somememos init/);
    mkdirSync(dirname(configPath(dir)), { recursive: true });
    writeFileSync(configPath(dir), '{ "clientId": ');
    expect(() => loadBrainConfig(dir)).toThrow(storage.ConfigError);
    expect(() => loadBrainConfig(dir)).toThrow(/not valid JSON/);
    writeFileSync(configPath(dir), JSON.stringify({ clientId: 'c', weigths: {} }));
    expect(() => loadBrainConfig(dir)).toThrow(/unknown key "weigths"/);
    expect(() => loadBrainConfig(dir)).toThrow(configPath(dir));
  });

  it('fills defaults for a hand-written minimal config', () => {
    mkdirSync(dirname(configPath(dir)), { recursive: true });
    writeFileSync(
      configPath(dir),
      JSON.stringify({ clientId: 'desk', roles: { excluded: ['private/'] } }),
    );
    const config = loadBrainConfig(dir);
    expect(config.roles).toEqual({ excluded: ['private/'] });
    expect(config.alpha).toBe(1);
    expect(readFileSync(configPath(dir), 'utf8')).not.toContain('alpha');
  });
});
