// A small zip writer and reader for exporting and importing a whole brain
// (PLAN.md section 2: an export is the markdown plus the event log). No
// library: the writer only stores (no compression), which keeps it short and
// is enough for text a person wants back byte for byte.
//
// Format (APPNOTE 6.3): for each file a local header, then its bytes; then
// the central directory and its end record. File names are UTF-8 (general
// purpose flag bit 11). Sizes and CRC-32 are known before each file is
// written, so no data descriptors are used. No zip64: an archive is limited
// to 65,535 files and 4 GiB, far beyond a brain of notes of at most 2 MiB
// each; going past either throws instead of writing a broken archive.
//
// The writer streams into a `Blob`, folding what it has written into a new
// Blob every few megabytes, so the whole archive never sits in one string or
// one array buffer (browsers may keep large Blobs on disk).

/** CRC-32 (IEEE 802.3, as zip uses it). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC-32 of `data`, continuing from `crc` (the CRC of what came before). */
export function crc32(data: Uint8Array, crc = 0): number {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) {
    c = (CRC_TABLE[(c ^ (data[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;
const VERSION = 20; // 2.0: what a stored file needs
const MADE_BY_UNIX = (3 << 8) | VERSION;
const FILE_MODE = 0o100644; // a regular file, rw-r--r--
const MAX_16 = 0xffff;
const MAX_32 = 0xffffffff;
const FLUSH_BYTES = 8 * 1024 * 1024;

const encoder = new TextEncoder();

/** MS-DOS date and time for `date`, in UTC (zip records no time zone). */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >>> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

interface CentralEntry {
  readonly name: Uint8Array;
  readonly crc: number;
  readonly size: number;
  readonly offset: number;
  readonly time: number;
  readonly date: number;
}

/** Writes a store-only zip archive into a Blob. */
export class ZipWriter {
  private readonly blobs: Blob[] = [];
  private parts: Uint8Array<ArrayBuffer>[] = [];
  private pending = 0;
  private offset = 0;
  private readonly entries: CentralEntry[] = [];
  private readonly names = new Set<string>();
  private finished = false;

  /** Bytes written so far. */
  get size(): number {
    return this.offset;
  }

  private push(bytes: Uint8Array<ArrayBuffer>): void {
    this.parts.push(bytes);
    this.pending += bytes.length;
    this.offset += bytes.length;
    if (this.pending >= FLUSH_BYTES) this.flush();
  }

  private flush(): void {
    if (this.parts.length === 0) return;
    this.blobs.push(new Blob(this.parts));
    this.parts = [];
    this.pending = 0;
  }

  /**
   * Adds one file. `name` is a relative path with `/` separators; a name may
   * appear once. `data` is a string (written as UTF-8) or bytes.
   */
  add(name: string, data: string | Uint8Array, modified: Date = new Date()): void {
    if (this.finished) throw new Error('the archive is already finished');
    if (name === '' || name.startsWith('/') || name.includes('\\') || name.includes('\0')) {
      throw new RangeError(`not a zip entry name: ${JSON.stringify(name)}`);
    }
    if (this.names.has(name)) throw new RangeError(`duplicate zip entry: ${name}`);
    const nameBytes = encoder.encode(name);
    const bytes = typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data);
    if (nameBytes.length > MAX_16) throw new RangeError('a zip entry name is too long');
    if (this.entries.length >= MAX_16) throw new RangeError('too many files for a zip archive');
    if (this.offset + 30 + nameBytes.length + bytes.length > MAX_32) {
      throw new RangeError('the archive would be larger than 4 GiB');
    }
    const crc = crc32(bytes);
    const { time, date } = dosDateTime(modified);
    const header = new Uint8Array(30 + nameBytes.length);
    const v = new DataView(header.buffer);
    v.setUint32(0, LOCAL_SIG, true);
    v.setUint16(4, VERSION, true);
    v.setUint16(6, UTF8_FLAG, true);
    v.setUint16(8, 0, true); // stored
    v.setUint16(10, time, true);
    v.setUint16(12, date, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, bytes.length, true);
    v.setUint32(22, bytes.length, true);
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, 0, true);
    header.set(nameBytes, 30);
    this.entries.push({
      name: nameBytes,
      crc,
      size: bytes.length,
      offset: this.offset,
      time,
      date,
    });
    this.names.add(name);
    this.push(header);
    this.push(bytes);
  }

  /** Writes the central directory and returns the archive. */
  finish(): Blob {
    if (this.finished) throw new Error('the archive is already finished');
    this.finished = true;
    const start = this.offset;
    for (const e of this.entries) {
      const rec = new Uint8Array(46 + e.name.length);
      const v = new DataView(rec.buffer);
      v.setUint32(0, CENTRAL_SIG, true);
      v.setUint16(4, MADE_BY_UNIX, true);
      v.setUint16(6, VERSION, true);
      v.setUint16(8, UTF8_FLAG, true);
      v.setUint16(10, 0, true);
      v.setUint16(12, e.time, true);
      v.setUint16(14, e.date, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, e.size, true);
      v.setUint32(24, e.size, true);
      v.setUint16(28, e.name.length, true);
      // extra, comment, disk number, internal attributes: all 0
      v.setUint32(38, (FILE_MODE << 16) >>> 0, true);
      v.setUint32(42, e.offset, true);
      rec.set(e.name, 46);
      this.push(rec);
    }
    const size = this.offset - start;
    if (this.offset + 22 > MAX_32) throw new RangeError('the archive would be larger than 4 GiB');
    const end = new Uint8Array(22);
    const v = new DataView(end.buffer);
    v.setUint32(0, END_SIG, true);
    v.setUint16(8, this.entries.length, true);
    v.setUint16(10, this.entries.length, true);
    v.setUint32(12, size, true);
    v.setUint32(16, start, true);
    this.push(end);
    this.flush();
    return new Blob(this.blobs, { type: 'application/zip' });
  }
}

/** One file read from an archive. */
export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
  /** The recorded modification time, read as UTC (as the writer writes it). */
  readonly modified: Date;
}

/** The time a DOS date and time stand for, read as UTC. */
function fromDos(time: number, date: number): Date {
  return new Date(
    Date.UTC(
      1980 + (date >>> 9),
      Math.max(0, ((date >>> 5) & 0xf) - 1),
      Math.max(1, date & 0x1f),
      time >>> 11,
      (time >>> 5) & 0x3f,
      (time & 0x1f) * 2,
    ),
  );
}

/** Thrown for an archive this reader cannot read. */
export class ZipError extends Error {
  override name = 'ZipError';
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipError('this browser cannot read compressed zip files');
  }
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Reads every file of a zip archive (stored or deflated; no zip64, no
 * encryption), checking each CRC-32. Folders are left out.
 */
export async function readZip(bytes: Uint8Array): Promise<ZipEntry[]> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - MAX_16); i--) {
    if (v.getUint32(i, true) === END_SIG) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipError('not a zip file');
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  if (count === MAX_16 || p === MAX_32) throw new ZipError('zip64 archives are not supported');
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== CENTRAL_SIG) {
      throw new ZipError('the zip file is damaged');
    }
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const modified = fromDos(v.getUint16(p + 12, true), v.getUint16(p + 14, true));
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new ZipError(`${name} is encrypted`);
    if (local + 30 > bytes.length || v.getUint32(local, true) !== LOCAL_SIG) {
      throw new ZipError('the zip file is damaged');
    }
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    if (start + csize > bytes.length) throw new ZipError('the zip file is damaged');
    const raw = bytes.subarray(start, start + csize);
    let data: Uint8Array;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflateRaw(raw);
    else throw new ZipError(`${name} uses a compression this app cannot read`);
    if (data.length !== usize || crc32(data) !== crc) {
      throw new ZipError(`${name} is damaged (its checksum does not match)`);
    }
    out.push({ name, data, modified });
  }
  return out;
}
