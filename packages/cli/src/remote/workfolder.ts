// A remote working folder (PLAN.md section 6, "The agent's flow"; section 7,
// "Remote clients"): the notes this agent has read, at their brain paths, plus
// `.somememos/manifest.json` recording each one's base hash (the content hash
// it had when fetched) and the file's size and mtime then, so an untouched
// file is never re-read.
//
// - Edited: a manifest file whose content hash differs from its base.
// - New: a `.md` file not in the manifest (not a `*.server.md` copy, not in a
//   dot folder).
// - Missing: a manifest file that is gone locally. Never treated as a
//   delete: deletes are explicit (`somememos rm`).

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { markdown, storage, sync } from '@somememos/core';
import { CommandError } from '../brain/output.js';
import { fingerprint, statFile, walkMarkdown } from '../indexer/walk.js';
import { SIDECAR_DIR } from '../store/open.js';
import { MANIFEST_FILE, writeJsonFile } from './config.js';

export interface ManifestEntry {
  /** The content hash the note had when fetched or last committed. */
  readonly base: string;
  /** `size:mtimeNs` of the file right after it was written or committed. */
  readonly fingerprint: string | null;
  /**
   * Set after a commit was refused as stale: the server's hash then. Once
   * the `.server.md` copy is merged and deleted, the next commit uses it as
   * the base.
   */
  readonly conflict?: string;
}

export interface Manifest {
  readonly version: 1;
  readonly server: string;
  readonly brainId: string;
  readonly notes: Record<string, ManifestEntry>;
}

/** The suffix of the server's version saved beside a file whose commit was refused. */
export const SERVER_COPY_SUFFIX = '.server.md';

/** `memos/a.md` → `memos/a.server.md`. */
export function serverCopyPath(path: string): string {
  return `${path.slice(0, -'.md'.length)}${SERVER_COPY_SUFFIX}`;
}

export function isServerCopy(path: string): boolean {
  return path.toLowerCase().endsWith(SERVER_COPY_SUFFIX);
}

export type FileState =
  | { readonly kind: 'untouched'; readonly path: string; readonly base: string }
  | {
      readonly kind: 'edited';
      readonly path: string;
      readonly base: string;
      readonly hash: string;
      readonly text: string;
      readonly conflict?: string;
    }
  | { readonly kind: 'new'; readonly path: string; readonly hash: string; readonly text: string }
  | { readonly kind: 'missing'; readonly path: string; readonly base: string };

export interface WorkFolder {
  readonly root: string;
  readonly manifestPath: string;
  read(): Manifest;
  /** Re-reads the manifest, applies `fn` to its notes, and writes it atomically. */
  update(fn: (notes: Record<string, ManifestEntry>) => void): Manifest;
  /** The absolute path of a brain path in this folder (checked: it cannot leave the folder). */
  file(path: string): string;
  /** The file's text, or undefined. */
  readText(path: string): string | undefined;
  /** Writes a note's text byte for byte, creating folders; returns its fingerprint. */
  writeText(path: string, text: string): string | null;
  remove(path: string): void;
  fingerprintOf(path: string): string | null;
  /** The state of one path. */
  stateOf(path: string, manifest?: Manifest): Promise<FileState | null>;
  /** Every manifest path and every new `.md` file, with its state, sorted by path. */
  scan(manifest?: Manifest): Promise<FileState[]>;
}

/** A brain path from the server or the user that is safe to write in a working folder. */
export function checkNotePath(path: string): string {
  const problem = sync.syncPathProblem(path);
  if (problem !== null) throw new CommandError(`${path}: ${problem}`);
  return path;
}

export function openWorkFolder(
  root: string,
  target: { server: string; brainId: string },
): WorkFolder {
  const manifestPath = join(root, SIDECAR_DIR, MANIFEST_FILE);
  const empty = (): Manifest => ({
    version: 1,
    server: target.server,
    brainId: target.brainId,
    notes: {},
  });

  const read = (): Manifest => {
    let text: string;
    try {
      text = readFileSync(manifestPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty();
      throw error;
    }
    let value: Manifest;
    try {
      value = JSON.parse(text) as Manifest;
    } catch {
      throw new CommandError(
        `${manifestPath} is not valid JSON; delete it to start the working folder afresh`,
      );
    }
    if (
      value?.version !== 1 ||
      typeof value.notes !== 'object' ||
      value.notes === null ||
      Array.isArray(value.notes)
    ) {
      throw new CommandError(`${manifestPath} is not a somememos manifest`);
    }
    if (value.server !== target.server || value.brainId !== target.brainId) {
      throw new CommandError(
        `${root} is a working folder for brain ${value.brainId} on ${value.server}, not ${target.brainId} on ${target.server}; use another folder (SOMEMEMOS_WORKDIR)`,
      );
    }
    return value;
  };

  const file = (path: string): string => {
    const normalized = markdown.normalizePath(path);
    if (normalized === null || normalized === '' || normalized !== path) {
      throw new CommandError(`${path} is not a brain-relative note path`);
    }
    return join(root, ...path.split('/'));
  };

  const fingerprintOf = (path: string): string | null => {
    const f = statFile(file(path), path);
    return f ? fingerprint(f) : null;
  };

  const readText = (path: string): string | undefined => {
    try {
      return readFileSync(file(path), 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return undefined;
      throw error;
    }
  };

  const stateOf = async (path: string, manifest = read()): Promise<FileState | null> => {
    const entry = manifest.notes[path];
    const f = statFile(file(path), path);
    if (!entry) {
      if (!f) return null;
      const text = readText(path) ?? '';
      return { kind: 'new', path, hash: await storage.contentHash(text), text };
    }
    if (!f) return { kind: 'missing', path, base: entry.base };
    if (entry.fingerprint !== null && entry.fingerprint === fingerprint(f) && !entry.conflict) {
      return { kind: 'untouched', path, base: entry.base };
    }
    const text = readText(path) ?? '';
    const hash = await storage.contentHash(text);
    if (hash === entry.base && !entry.conflict)
      return { kind: 'untouched', path, base: entry.base };
    return {
      kind: 'edited',
      path,
      base: entry.base,
      hash,
      text,
      ...(entry.conflict ? { conflict: entry.conflict } : {}),
    };
  };

  return {
    root,
    manifestPath,
    read,
    update(fn) {
      const current = read();
      const notes = { ...current.notes };
      fn(notes);
      const next: Manifest = { ...current, notes: sortKeys(notes) };
      writeJsonFile(manifestPath, next);
      return next;
    },
    file,
    readText,
    writeText(path, text) {
      const full = file(path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text, 'utf8');
      return fingerprintOf(path);
    },
    remove(path) {
      rmSync(file(path), { force: true });
    },
    fingerprintOf,
    stateOf,
    async scan(manifest = read()) {
      const paths = new Set(Object.keys(manifest.notes));
      for (const f of walkMarkdown(root)) {
        if (!isServerCopy(f.path) && f.path.endsWith('.md')) paths.add(f.path);
      }
      const states: FileState[] = [];
      for (const path of [...paths].sort()) {
        const state = await stateOf(path, manifest);
        if (state) states.push(state);
      }
      return states;
    },
  };
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key] as T;
  return out;
}

/** The files a commit would send: edited and new ones. */
export function pendingFiles(states: readonly FileState[]) {
  return states.filter(
    (s): s is Extract<FileState, { kind: 'edited' | 'new' }> =>
      s.kind === 'edited' || s.kind === 'new',
  );
}
