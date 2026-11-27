#!/usr/bin/env node
// Writes an invented example brain for trying the CLI and for the examples in
// docs/cli.md: the seeded generator in @somememos/core/testing/brain, as a git
// repository with one commit per step, ending yesterday. Nothing in it comes
// from a real brain. Not part of `npm run check`.
//
//   node docs/scripts/example-brain.mjs /tmp/garden          # a git history
//   node docs/scripts/example-brain.mjs /tmp/garden --files  # the files only
//
// The directory must be empty or absent, and should be outside this checkout
// (somememos refuses to write exports and eval detail inside it).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'rolldown';

const [dirArg, ...flags] = process.argv.slice(2);
if (!dirArg) {
  console.error('usage: node docs/scripts/example-brain.mjs <dir> [--files]');
  process.exit(2);
}
const dir = resolve(dirArg);
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The generator and the git writer are TypeScript sources; bundle them once.
const tmp = mkdtempSync(join(tmpdir(), 'somememos-example-'));
const out = join(tmp, 'testing.mjs');
await build({
  input: join(repo, 'packages', 'cli', 'src', 'testing', 'index.ts'),
  platform: 'node',
  resolve: { conditionNames: ['source', 'import', 'node', 'default'] },
  external: (id) => id.startsWith('node:'),
  output: { file: out, format: 'esm' },
  logLevel: 'silent',
});
const { generateBrain, materializeBrain, materializeGitHistory } = await import(
  pathToFileURL(out).href
);
rmSync(tmp, { recursive: true, force: true });

const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);
const brain = generateBrain({ seed: 7, steps: 60, topics: 6, start: now - 121 * DAY, days: 120 });
if (flags.includes('--files')) materializeBrain(dir, brain);
else materializeGitHistory(dir, brain);
console.log(`wrote ${Object.keys(brain.files).length} files to ${dir}`);
