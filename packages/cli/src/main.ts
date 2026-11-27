// The CLI's entry point for the one-file build (scripts/bundle.mjs): run with
// the process's arguments and exit with the command's code.

import process from 'node:process';
import { run } from './index.js';

process.exitCode = await run(process.argv.slice(2));
