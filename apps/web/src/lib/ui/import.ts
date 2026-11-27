// Collecting a folder of markdown files from the device, by any of the three
// ways a browser offers: a folder <input>, drag and drop, and the File System
// Access API. Only the list of files is gathered here; reading their text
// happens after the person has reviewed the folder roles.

import { markdown } from '@somememos/core';
import type { RolePatterns } from './paths.ts';

/** A file found in the chosen folder, with its brain-relative path. */
export interface PickedFile {
  readonly path: string;
  readonly file: File;
}

/** Folders that are never part of a brain: tool and version-control data. */
export function isHiddenPath(path: string): boolean {
  return path.split('/').some((s) => s.startsWith('.') || s === 'node_modules');
}

/**
 * Brain-relative paths for files picked inside one top folder: a folder
 * <input> names files `<folder>/<path>`, so the shared first segment is
 * dropped.
 */
export function stripTopFolder(paths: readonly string[]): string[] {
  const first = paths[0]?.split('/')[0];
  const shared =
    first !== undefined && paths.length > 0 && paths.every((p) => p.startsWith(`${first}/`));
  return shared ? paths.map((p) => p.slice(first.length + 1)) : [...paths];
}

/**
 * Brain-relative paths for any way of picking a folder (input, drag and
 * drop, File System Access API). If every file still sits inside one common
 * folder (`vault/memos/a.md`: the picked folder's own name, or a wrapper
 * folder such as an unzipped download) and that leaves the folder roles
 * matching nothing, that one folder is dropped so the roles apply
 * (`memos/a.md`). A brain whose files really all live in one role folder
 * (`memos/a.md`, `memos/b.md`) is left alone, because its roles already match.
 */
export function stripCommonFolder(paths: readonly string[], roles: RolePatterns): string[] {
  const stripped = stripTopFolder(paths);
  if (paths.length === 0 || stripped.every((p, i) => p === paths[i])) return [...paths];
  const declared = Object.values(roles).some((list) => (list?.length ?? 0) > 0);
  if (!declared) return stripped;
  const matches = (list: readonly string[]) => {
    for (const role of classifyForImport(list, roles).values()) {
      if (role !== 'none' && role !== 'excluded') return true;
    }
    return false;
  };
  return !matches(paths) && matches(stripped) ? stripped : [...paths];
}

/** `stripCommonFolder` applied to picked files. */
export function normalizePicked(files: readonly PickedFile[], roles: RolePatterns): PickedFile[] {
  const paths = stripCommonFolder(
    files.map((f) => f.path),
    roles,
  );
  return files.map((f, i) => ({ path: paths[i] as string, file: f.file }));
}

export type ImportRole = 'memo' | 'dated' | 'source' | 'blog' | 'excluded' | 'none';

/**
 * What role each path would get under `roles`, for the review before an
 * import. Mirrors core's precedence (excluded, source, dated, memo) and puts
 * blog right after excluded.
 */
export function classifyForImport(
  paths: readonly string[],
  roles: RolePatterns,
): Map<string, ImportRole> {
  const coreRoles: markdown.FolderRolesConfig = {};
  for (const r of ['memo', 'dated', 'source', 'excluded'] as const) {
    const list = roles[r];
    if (list && list.length) coreRoles[r] = list;
  }
  const blog = (roles.blog ?? []).map((p) => markdown.compilePathPattern(p));
  const anyDeclared = Object.keys(coreRoles).length > 0 || blog.length > 0;
  const classifier = markdown.createRoleClassifier(coreRoles);
  const out = new Map<string, ImportRole>();
  for (const path of paths) {
    if (!markdown.isMarkdownPath(path)) {
      out.set(path, 'none');
      continue;
    }
    const m = classifier.classify(path);
    if (m?.role === 'excluded') out.set(path, 'excluded');
    else if (blog.some((b) => b.match(path) !== null)) out.set(path, 'blog');
    else if (m && (classifier.declared || !anyDeclared)) out.set(path, m.role);
    else out.set(path, 'none');
  }
  return out;
}

/** Files from a folder <input> (`webkitdirectory`). */
export function filesFromInput(list: FileList): PickedFile[] {
  const files = [...list];
  const paths = stripTopFolder(files.map((f) => f.webkitRelativePath || f.name));
  return files
    .map((file, i) => ({ path: paths[i] as string, file }))
    .filter((f) => !isHiddenPath(f.path));
}

/** Files from a folder dropped on the page (`webkitGetAsEntry`). */
export async function filesFromDrop(items: DataTransferItemList): Promise<PickedFile[]> {
  const entries = [...items]
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  const out: PickedFile[] = [];
  // One dropped folder is the brain itself; otherwise keep each item's name.
  const [only] = entries;
  if (entries.length === 1 && only?.isDirectory) await walkEntry(only, '', out);
  else for (const entry of entries) await walkEntry(entry, entry.name, out);
  return out.filter((f) => !isHiddenPath(f.path));
}

async function walkEntry(entry: FileSystemEntry, path: string, out: PickedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) =>
      (entry as FileSystemFileEntry).file(res, rej),
    );
    out.push({ path, file });
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries returns results in batches until it returns an empty one.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
    if (batch.length === 0) break;
    for (const child of batch) {
      if (child.name.startsWith('.')) continue;
      await walkEntry(child, path ? `${path}/${child.name}` : child.name, out);
    }
  }
}

interface DirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;
  values(): AsyncIterable<DirectoryHandle | FileHandle>;
}

interface FileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
}

/** True where the File System Access API can pick a folder. */
export function canPickDirectory(): boolean {
  return (
    typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
  );
}

/** Files from a folder chosen with `showDirectoryPicker`. Null if the person cancelled. */
export async function filesFromDirectoryPicker(): Promise<PickedFile[] | null> {
  const pick = (globalThis as { showDirectoryPicker?: (o: object) => Promise<DirectoryHandle> })
    .showDirectoryPicker;
  if (!pick) return null;
  let dir: DirectoryHandle;
  try {
    dir = await pick({ mode: 'read', id: 'somememos-import' });
  } catch {
    return null;
  }
  const out: PickedFile[] = [];
  const walk = async (d: DirectoryHandle, prefix: string): Promise<void> => {
    for await (const h of d.values()) {
      if (h.name.startsWith('.') || h.name === 'node_modules') continue;
      if (h.kind === 'file') out.push({ path: `${prefix}${h.name}`, file: await h.getFile() });
      else await walk(h, `${prefix}${h.name}/`);
    }
  };
  await walk(dir, '');
  return out;
}

/** A role config from the roles editor's text: one pattern per line, blanks dropped. */
export function rolesFromText(text: Readonly<Record<string, string>>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [role, value] of Object.entries(text)) {
    const list = value
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
    if (list.length) out[role] = list;
  }
  return out;
}

/** Problems with a role config, by role: unknown placeholders, dated patterns without a date. */
export function roleProblems(
  roles: Readonly<Record<string, readonly string[]>>,
): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const [role, list] of Object.entries(roles)) {
    for (const p of list) {
      try {
        const compiled = markdown.compilePathPattern(p);
        if (role === 'dated' && !compiled.hasDate) {
          problems[role] = `“${p}” needs {YYYY}, {MM} and {DD} so each entry has a date.`;
        }
      } catch (e) {
        problems[role] = e instanceof Error ? e.message : String(e);
      }
    }
  }
  return problems;
}
