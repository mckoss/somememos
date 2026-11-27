// The working-folder flow in remote mode (PLAN.md section 6): `read` places a
// note in the folder and records its base hash; `commit` sends each edited or
// new file with its base; a stale base is refused for that file only, and the
// server's version is saved beside it as `<name>.server.md`.

import { existsSync } from 'node:fs';
import { engine, markdown } from '@somememos/core';
import type { RemoteSession } from '../brain/session.js';
import { pendingFiles, serverCopyPath } from './workfolder.js';

export interface FetchResult {
  /** What `read` prints: the server's text, or the local file when it was edited. */
  readonly text: string;
  /** The server's view, or null when the server has no such note (a new local file). */
  readonly note: engine.NoteView | null;
  /** True when the working-folder file was written (fetched anew). */
  readonly wrote: boolean;
  /** One-line notices for stderr. */
  readonly notices: string[];
}

/**
 * Fetches `path` (logging a read unless `record` is false), places it in the
 * working folder unless the local file was edited, and records its base.
 */
export async function fetchIntoFolder(
  remote: RemoteSession,
  path: string,
  options: { readonly record?: boolean; readonly display?: (path: string) => string } = {},
): Promise<FetchResult> {
  const { folder } = remote;
  const show = options.display ?? ((p: string) => p);
  const state = await folder.stateOf(path);
  let note: engine.NoteView | null = null;
  try {
    note = await remote.engine.readNote(path, options.record === false ? { record: false } : {});
  } catch (error) {
    const localCopy = state && (state.kind === 'new' || state.kind === 'edited');
    if (!(engine.isEngineError(error) && error.code === 'not-found' && localCopy)) throw error;
  }
  if (note === null) {
    // Only reached with a local file the server does not have.
    const local = state as Extract<typeof state, { kind: 'new' | 'edited' }>;
    if (local.kind === 'edited') {
      folder.update((notes) => {
        delete notes[path];
      });
      return {
        text: local.text,
        note: null,
        wrote: false,
        notices: [
          `the server no longer has ${show(path)}; your copy is kept, and somememos commit adds it again`,
        ],
      };
    }
    return {
      text: local.text,
      note: null,
      wrote: false,
      notices: [`${show(path)} is not on the server yet; somememos commit adds it`],
    };
  }

  if (state?.kind === 'edited' || state?.kind === 'new') {
    if (note.hash === state.hash) {
      // The server has exactly this text: the local file is now untouched.
      const fp = folder.fingerprintOf(path);
      folder.update((notes) => {
        notes[path] = { base: note.hash, fingerprint: fp };
      });
      return { text: state.text, note, wrote: false, notices: [] };
    }
    const notices: string[] = [];
    if (state.kind === 'new') {
      notices.push(
        `kept the local file at ${show(path)}, which was not fetched from the server and differs from its version`,
      );
    } else if (note.hash !== state.base) {
      notices.push(
        `the server has a newer version of ${show(path)} than the one you edited; somememos commit will save it beside yours to merge`,
      );
    }
    return { text: state.text, note, wrote: false, notices };
  }

  // Not here yet, untouched, or missing: (re)place the server's version.
  let wrote = false;
  let fp: string | null;
  if (state?.kind === 'untouched' && state.base === note.hash) {
    fp = folder.fingerprintOf(path);
  } else {
    fp = folder.writeText(path, note.text);
    wrote = true;
  }
  const hash = note.hash;
  folder.update((notes) => {
    notes[path] = { base: hash, fingerprint: fp };
  });
  return { text: note.text, note, wrote, notices: [] };
}

export interface CommitOutcome {
  readonly committed: boolean;
  readonly saved: {
    readonly path: string;
    readonly hash: string;
    readonly created: boolean;
    readonly change: engine.ChangeRecord | null;
  }[];
  readonly unchanged: string[];
  /** Refused as stale: the server's version is at `serverCopy` (null when the server has none). */
  readonly conflicts: {
    readonly path: string;
    readonly serverCopy: string | null;
    readonly instruction: string;
  }[];
  /** Refused for another reason (excluded, no role, source-immutable…). */
  readonly failed: { readonly path: string; readonly code: string; readonly message: string }[];
  /** New files never sent: they are in excluded folders. */
  readonly skipped: string[];
  /** Edited or new files left out by the path filters. */
  readonly remaining: string[];
}

/**
 * Sends every edited or new file covered by `filters` (brain paths or
 * folders; none means all) with its base hash and `message`.
 */
export async function commitFolder(
  remote: RemoteSession,
  options: {
    readonly message: string | null;
    readonly filters: readonly string[];
    readonly display?: (path: string) => string;
  },
): Promise<CommitOutcome> {
  const { folder } = remote;
  const show = options.display ?? ((p: string) => p);
  const classifier = markdown.createRoleClassifier((await remote.engine.brainConfig()).roles);
  const all = pendingFiles(await folder.scan());
  const covered = (p: string) =>
    options.filters.length === 0 || options.filters.some((f) => engine.pathCovers(f, p));
  const chosen = all.filter((s) => covered(s.path));
  const remaining = all.filter((s) => !covered(s.path)).map((s) => s.path);

  const saved: CommitOutcome['saved'] = [];
  const unchanged: string[] = [];
  const conflicts: CommitOutcome['conflicts'][number][] = [];
  const failed: CommitOutcome['failed'][number][] = [];
  const skipped: string[] = [];

  for (const file of chosen) {
    const role = classifier.classify(file.path)?.role;
    if (role === 'excluded') {
      skipped.push(file.path);
      continue;
    }
    if (role === undefined) {
      failed.push({
        path: file.path,
        code: 'not-found',
        message: "that path has no role in this brain's config",
      });
      continue;
    }
    let base: string | null = file.kind === 'edited' ? file.base : null;
    if (file.kind === 'edited' && file.conflict !== undefined) {
      const copy = serverCopyPath(file.path);
      if (existsSync(folder.file(copy))) {
        conflicts.push({
          path: file.path,
          serverCopy: copy,
          instruction: `${show(file.path)}: not committed: merge ${show(copy)} into it, delete ${show(copy)}, then commit again`,
        });
        continue;
      }
      base = file.conflict === '' ? null : file.conflict;
    }
    if (base === '') base = null;
    let result: engine.SaveResult;
    try {
      result = await remote.engine.saveNote(file.path, file.text, {
        baseHash: base,
        ...(options.message !== null ? { message: options.message } : {}),
      });
    } catch (error) {
      if (engine.isEngineError(error)) {
        failed.push({ path: file.path, code: error.code, message: error.message });
        continue;
      }
      throw error;
    }
    const fp = folder.fingerprintOf(file.path);
    if (result.status === 'conflict' && result.currentHash === file.hash) {
      // A retried request that had been applied: the server has this text.
      unchanged.push(file.path);
      folder.update((notes) => {
        notes[file.path] = { base: file.hash, fingerprint: fp };
      });
      continue;
    }
    if (result.status === 'conflict') {
      if (result.currentText === null || result.currentHash === null) {
        folder.update((notes) => {
          delete notes[file.path];
        });
        conflicts.push({
          path: file.path,
          serverCopy: null,
          instruction: `${show(file.path)}: not committed: the server no longer has this note (deleted or renamed meanwhile); your copy is kept, and committing again adds it back`,
        });
        continue;
      }
      const copy = serverCopyPath(file.path);
      folder.writeText(copy, result.currentText);
      const current = result.currentHash;
      folder.update((notes) => {
        notes[file.path] = {
          base: file.kind === 'edited' ? file.base : '',
          fingerprint: null,
          conflict: current,
        };
      });
      conflicts.push({
        path: file.path,
        serverCopy: copy,
        instruction: `${show(file.path)}: not committed: the server has a newer version, saved as ${show(copy)}; merge it into ${show(file.path)}, delete ${show(copy)}, then commit again`,
      });
      continue;
    }
    folder.update((notes) => {
      notes[file.path] = { base: result.hash, fingerprint: fp };
    });
    if (result.status === 'unchanged') unchanged.push(file.path);
    else
      saved.push({
        path: file.path,
        hash: result.hash,
        created: result.created,
        change: result.change,
      });
  }

  return {
    committed: saved.length > 0,
    saved,
    unchanged,
    conflicts,
    failed,
    skipped,
    remaining,
  };
}

/**
 * After a change made on the server (a restore), places the server's current
 * version in the folder unless the local file was edited. Logs no read.
 * Returns a notice, or null.
 */
export async function refreshFromServer(
  remote: RemoteSession,
  path: string,
  display: (path: string) => string,
): Promise<string | null> {
  const state = await remote.folder.stateOf(path);
  if (state?.kind === 'edited' || state?.kind === 'new') {
    return `kept your edited ${display(path)}; the server's version changed (somememos read it after committing or reverting your edits)`;
  }
  const result = await fetchIntoFolder(remote, path, { record: false, display });
  return result.notices[0] ?? null;
}
