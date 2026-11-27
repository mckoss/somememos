#!/usr/bin/env node
// Thin launcher for the compiled CLI. Run `npm run build` first.
import process from 'node:process';
import { run } from '../dist/index.js';

process.exitCode = await run(process.argv.slice(2));
