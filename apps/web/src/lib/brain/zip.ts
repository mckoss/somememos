// Zip archives for exporting and importing a whole brain (PLAN.md section 2:
// an export is the markdown plus the event log), on top of fflate.
//
// Writing streams: each file is deflated as it is added and its bytes are
// folded into a new Blob every few megabytes, so the archive never sits in
// one string or one array buffer (browsers may keep large Blobs on disk).
// fflate writes no zip64 records, so an archive is limited to 65,535 files
// and 4 GiB; going past either throws instead of writing a broken archive.
//
// Reading goes through the central directory (fflate's `unzipSync`), with
// limits checked before anything is inflated, so a hostile archive (path
// traversal, duplicate names, a zip bomb) is refused with a plain message.
// It reads zip64 archives, deflated or stored entries, and archives made by
// other tools: folder entries, macOS `__MACOSX` and `.DS_Store` junk, and a
// single folder wrapping an export are taken care of.

import { unzipSync, Zip, ZipDeflate, type DeflateOptions } from 'fflate';

/** Thrown for an archive that cannot be read or is refused. */
export class ZipError extends Error {
  override name = 'ZipError';
}

const MIB = 1024 * 1024;
const FLUSH_BYTES = 8 * MIB;
/** What an archive without zip64 records can hold. */
const MAX_WRITE_ENTRIES = 0xffff;
const MAX_WRITE_BYTES = 0xffffffff;

const encoder = new TextEncoder();

/**
 * fflate's memory level for one file of `length` bytes: the size its own
 * one-shot `deflateSync` picks. A streaming deflater otherwise defaults to
 * the largest tables (a few megabytes per file), which is slow for thousands
 * of small notes.
 */
function memLevel(length: number): DeflateOptions['mem'] {
  const level = Math.ceil(Math.max(8, Math.min(13, Math.log(Math.max(length, 1)))) * 1.5) - 12;
  return level as DeflateOptions['mem']; // 0 to 8
}

/** Writes a deflated zip archive into a Blob. */
export class ZipWriter {
  private readonly blobs: Blob[] = [];
  private parts: Uint8Array<ArrayBuffer>[] = [];
  private pending = 0;
  private written = 0;
  /** Bytes the central directory will take. */
  private directory = 0;
  private count = 0;
  private finished = false;
  private result: Blob | undefined;
  private failure: Error | undefined;
  private readonly zip = new Zip((error, chunk, final) => {
    if (error) {
      this.failure = error;
      return;
    }
    this.parts.push(chunk as Uint8Array<ArrayBuffer>);
    this.pending += chunk.length;
    this.written += chunk.length;
    if (this.pending >= FLUSH_BYTES || final) this.flush();
    if (final) this.result = new Blob(this.blobs, { type: 'application/zip' });
  });

  /** Bytes written so far. */
  get size(): number {
    return this.written;
  }

  private flush(): void {
    if (this.parts.length === 0) return;
    this.blobs.push(new Blob(this.parts));
    this.parts = [];
    this.pending = 0;
  }

  private check(): void {
    if (this.failure) throw this.failure;
  }

  /**
   * Adds one file. `name` is a brain-relative path with `/` separators,
   * written as UTF-8; `data` is a string (written as UTF-8) or bytes.
   */
  add(name: string, data: string | Uint8Array, modified: Date = new Date()): void {
    if (this.finished) throw new Error('the archive is already finished');
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    if (this.count >= MAX_WRITE_ENTRIES) {
      throw new RangeError('too many files for one zip archive (at most 65,535)');
    }
    // Headers (local 30 + descriptor 16, central 46, end 22) plus the data,
    // which deflate grows by at most 5 bytes per 64 KiB.
    const nameLength = encoder.encode(name).length;
    const worst =
      this.written + this.directory + 114 + 2 * nameLength + bytes.length + (bytes.length >>> 10);
    if (worst > MAX_WRITE_BYTES) throw new RangeError('the archive would be larger than 4 GiB');
    this.directory += 46 + nameLength;
    const file = new ZipDeflate(name, { level: 6, mem: memLevel(bytes.length) });
    file.mtime = modified;
    this.zip.add(file);
    file.push(bytes, true);
    this.count++;
    this.check();
  }

  /** Writes the central directory and returns the archive. */
  finish(): Blob {
    if (this.finished) throw new Error('the archive is already finished');
    this.finished = true;
    this.zip.end();
    this.check();
    if (!this.result) throw new Error('the archive did not finish');
    return this.result;
  }
}

/** One file read from an archive. */
export interface ZipEntry {
  /** The brain-relative path: `/`-separated, never absolute, no `.` or `..`. */
  readonly name: string;
  readonly data: Uint8Array;
}

/** What `readZip` refuses to go past. */
export interface ZipLimits {
  /** Files in the archive (folders and junk included). */
  readonly entries: number;
  /** The archive itself, in bytes. */
  readonly archiveBytes: number;
  /** One file once inflated. */
  readonly entryBytes: number;
  /** All files once inflated. */
  readonly totalBytes: number;
  /** Inflated size over stored size, for files larger than `ratioFrom` bytes. */
  readonly ratio: number;
  readonly ratioFrom: number;
}

export const ZIP_LIMITS: ZipLimits = {
  entries: 250_000,
  archiveBytes: 2048 * MIB,
  entryBytes: 256 * MIB,
  totalBytes: 2048 * MIB,
  ratio: 100,
  ratioFrom: MIB,
};

/** Files other tools add that are never part of a brain. */
function isJunk(segments: readonly string[]): boolean {
  return segments[0] === '__MACOSX' || segments[segments.length - 1] === '.DS_Store';
}

/** A safe relative path for an entry name, or a ZipError. */
function safeName(raw: string): string[] {
  const name = raw.replaceAll('\\', '/');
  const quoted = JSON.stringify(raw);
  if (name.includes('\0'))
    throw new ZipError(`the zip file has a file with an invalid name: ${quoted}`);
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new ZipError(`the zip file has a file with an absolute path: ${quoted}`);
  }
  const segments = name.split('/');
  if (segments.some((s) => s === '..')) {
    throw new ZipError(`the zip file has a file outside its folder: ${quoted}`);
  }
  if (segments.some((s) => s === '' || s === '.')) {
    throw new ZipError(`the zip file has a file with an invalid name: ${quoted}`);
  }
  return segments;
}

function size(bytes: number): string {
  return bytes >= MIB ? `${Math.round(bytes / MIB)} MiB` : `${bytes} bytes`;
}

/**
 * Reads every file of a zip archive (stored or deflated, zip64 or not).
 * Folders, `__MACOSX` and `.DS_Store` are left out; when everything sits in
 * one folder beside an `events.jsonl` (an export someone zipped again), that
 * folder is dropped from the names. Refuses unsafe or duplicate names, and
 * archives past `limits`, before inflating anything.
 */
export function readZip(bytes: Uint8Array, limits: ZipLimits = ZIP_LIMITS): ZipEntry[] {
  if (bytes.length > limits.archiveBytes) {
    throw new ZipError(`the zip file is too large (more than ${size(limits.archiveBytes)})`);
  }
  let entries = 0;
  let total = 0;
  const names = new Map<string, string[]>();
  const declared = new Map<string, number>();
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter(info) {
        if (++entries > limits.entries) {
          throw new ZipError(`the zip file has too many files (more than ${limits.entries})`);
        }
        if (info.name.endsWith('/') || info.name.endsWith('\\')) return false;
        const segments = safeName(info.name);
        if (isJunk(segments)) return false;
        const name = segments.join('/');
        if (names.has(name) || declared.has(info.name)) {
          throw new ZipError(`the zip file has ${name} twice`);
        }
        if (info.compression !== 0 && info.compression !== 8) {
          throw new ZipError(`${name} uses a compression this app cannot read`);
        }
        if (info.originalSize > limits.entryBytes) {
          throw new ZipError(`${name} is too large (more than ${size(limits.entryBytes)})`);
        }
        total += info.originalSize;
        if (total > limits.totalBytes) {
          throw new ZipError(
            `the zip file is too large once unpacked (more than ${size(limits.totalBytes)})`,
          );
        }
        if (
          info.originalSize > limits.ratioFrom &&
          info.originalSize > limits.ratio * Math.max(info.size, 1)
        ) {
          throw new ZipError(
            `${name} unpacks to far more than it stores; it looks like a zip bomb`,
          );
        }
        names.set(name, segments);
        declared.set(info.name, info.originalSize);
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ZipError) throw error;
    throw new ZipError(`not a zip file, or a damaged one (${(error as Error).message})`);
  }

  const out: { segments: string[]; data: Uint8Array }[] = [];
  for (const [raw, length] of declared) {
    const data = files[raw];
    const segments = names.get(safeName(raw).join('/')) as string[];
    if (!data || data.length !== length) {
      throw new ZipError(`${segments.join('/')} is damaged (its size does not match)`);
    }
    out.push({ segments, data });
  }

  // One folder around an export: drop it, so events.jsonl and the notes are
  // where they belong. Anything else is left to the folder-role review.
  const top = out[0]?.segments[0];
  const wrapped =
    top !== undefined &&
    out.every((e) => e.segments.length > 1 && e.segments[0] === top) &&
    out.some((e) => e.segments.length === 2 && e.segments[1] === 'events.jsonl');
  return out.map((e) => ({
    name: (wrapped ? e.segments.slice(1) : e.segments).join('/'),
    data: e.data,
  }));
}
