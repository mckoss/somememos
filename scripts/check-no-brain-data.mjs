#!/usr/bin/env node
// Privacy guard (IMPLEMENTATION.md task 0.1a). This repository is public and a
// brain is private, so fail if any tracked file looks like brain data: a
// `.somememos/` directory, a SQLite database, an `events.jsonl` export, or any
// unexpectedly large file. Run in CI and by `npm run check`.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const MAX_BYTES = 200 * 1024;
const SIZE_EXEMPT = new Set(['package-lock.json']);

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
// Tracked files plus staged additions; -z keeps unusual names intact.
const files = execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const problems = [];
for (const file of files) {
  const parts = file.split('/');
  const base = parts[parts.length - 1] ?? '';
  if (parts.slice(0, -1).includes('.somememos')) {
    problems.push(`${file}: inside a .somememos/ directory`);
  } else if (/\.sqlite/i.test(base)) {
    problems.push(`${file}: looks like a SQLite database`);
  } else if (base === 'events.jsonl') {
    problems.push(`${file}: looks like an exported event log`);
  }

  if (!SIZE_EXEMPT.has(file)) {
    let size;
    try {
      size = statSync(path.join(root, file)).size;
    } catch {
      continue; // deleted in the working tree
    }
    if (size > MAX_BYTES) {
      problems.push(
        `${file}: ${Math.round(size / 1024)} KB exceeds the ${MAX_BYTES / 1024} KB limit`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error('Privacy guard failed: these tracked files may hold brain data.');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('Brain data must never be committed here (AGENTS.md, first ground rule).');
  process.exit(1);
}
console.log(`Privacy guard passed: ${files.length} tracked files checked.`);
