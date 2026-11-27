import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { markdown, storage } from '@somememos/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { Context } from '../context.js';
import { brainPaths } from '../store/index.js';
import { EXCLUDED_FOLDER, generateBrain, materializeGitHistory } from '../testing/index.js';
import { importGitCommand } from './command.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeContext(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: Context = {
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
    cwd,
    env: {},
  };
  return { ctx, stdout: () => out.join(''), stderr: () => err.join('') };
}

function brain(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'somememos-import-cmd-')), 'brain');
  dirs.push(dirname(dir));
  materializeGitHistory(dir, generateBrain({ seed: 4 }));
  const config = storage.parseBrainConfig({
    clientId: 'test-client',
    roles: { ...markdown.DEFAULT_FOLDER_ROLES, excluded: [`${EXCLUDED_FOLDER}/`] },
  });
  mkdirSync(brainPaths(dir).sidecarDir, { recursive: true });
  writeFileSync(
    join(brainPaths(dir).sidecarDir, 'config.json'),
    storage.serializeBrainConfig(config),
  );
  return dir;
}

describe('somememos import-git', () => {
  it('prints full help with an example', async () => {
    const io = fakeContext('/nonexistent');
    expect(await importGitCommand.run(['--help'], io.ctx)).toBe(0);
    expect(io.stdout()).toContain('Usage: somememos import-git');
    expect(io.stdout()).toContain('--ignore-commit');
    expect(io.stdout()).toContain('Example:');
  });

  it('imports, prints counts only, and adds nothing the second time', async () => {
    const dir = brain();
    const io = fakeContext(dirname(dir));
    expect(await importGitCommand.run(['--brain', 'brain'], io.ctx)).toBe(0);
    const text = io.stdout();
    expect(text).toMatch(/^Imported 60 commits/);
    expect(text).toMatch(/Events: \d+ edit, \d+ mention\./);
    expect(text).toMatch(/skipped 0 already stored/);
    expect(text).not.toMatch(/memos\/|diary\/|sources\/|\.md/);
    expect(text).not.toContain(EXCLUDED_FOLDER);

    const again = fakeContext(dir);
    expect(await importGitCommand.run(['--json'], again.ctx)).toBe(0);
    const json = JSON.parse(again.stdout()) as {
      appended: { log: number; changes: number };
      duplicates: { log: number; changes: number };
      folded: { events: number };
    };
    expect(json.appended).toEqual({ log: 0, changes: 0 });
    expect(json.duplicates.log).toBeGreaterThan(0);
    expect(json.folded.events).toBe(0);
  });

  it('rejects stray arguments and an empty --until', async () => {
    const io = fakeContext('/nonexistent');
    await expect(importGitCommand.run(['extra'], io.ctx)).rejects.toThrow(/unexpected argument/);
    await expect(importGitCommand.run(['--until', ''], io.ctx)).rejects.toThrow(/--until/);
  });
});
