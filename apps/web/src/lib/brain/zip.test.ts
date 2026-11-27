import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, readZip, ZipError, ZipWriter } from './zip.ts';

const enc = new TextEncoder();

function has(tool: string): boolean {
  try {
    execFileSync(tool, ['-h'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const FILES: [string, string | Uint8Array][] = [
  ['memos/fern.md', '# Fern\n\nSpores under the frond.\n'],
  ['diary/2026/2026-11-27.md', '# 27 November\n'],
  ['memos/café ☕/naïve 日本.md', '# Ünïcödé\n\nemoji 🌱 and CJK 森\n'],
  ['memos/empty.md', ''],
  ['bytes.bin', new Uint8Array([0, 255, 1, 254, 0x50, 0x4b, 5, 6])],
  ['events.jsonl', '{"type":"log","id":"e1"}\n'],
];

async function archive(): Promise<Uint8Array> {
  const w = new ZipWriter();
  for (const [name, data] of FILES) w.add(name, data, new Date(Date.UTC(2026, 10, 27, 13, 45, 30)));
  return new Uint8Array(await w.finish().arrayBuffer());
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
    // Continuing from a previous CRC equals the CRC of the whole.
    expect(crc32(enc.encode('6789'), crc32(enc.encode('12345')))).toBe(0xcbf43926);
  });
});

describe('ZipWriter', () => {
  it('writes a valid store-only archive with UTF-8 names', async () => {
    const bytes = await archive();
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // End of central directory: last 22 bytes, no comment.
    const end = bytes.length - 22;
    expect(v.getUint32(end, true)).toBe(0x06054b50);
    expect(v.getUint16(end + 8, true)).toBe(FILES.length);
    expect(v.getUint16(end + 10, true)).toBe(FILES.length);
    const cdSize = v.getUint32(end + 12, true);
    const cdStart = v.getUint32(end + 16, true);
    expect(cdStart + cdSize).toBe(end);

    let p = cdStart;
    let local = 0;
    const dec = new TextDecoder('utf-8', { fatal: true });
    for (const [name, data] of FILES) {
      const body = typeof data === 'string' ? enc.encode(data) : data;
      const nameBytes = enc.encode(name);
      expect(v.getUint32(p, true)).toBe(0x02014b50);
      expect(v.getUint16(p + 8, true) & 0x0800).toBe(0x0800); // UTF-8 names
      expect(v.getUint16(p + 10, true)).toBe(0); // stored
      expect(v.getUint32(p + 16, true)).toBe(crc32(body));
      expect(v.getUint32(p + 20, true)).toBe(body.length);
      expect(v.getUint32(p + 24, true)).toBe(body.length);
      expect(v.getUint16(p + 28, true)).toBe(nameBytes.length);
      expect(v.getUint32(p + 42, true)).toBe(local);
      expect(dec.decode(bytes.subarray(p + 46, p + 46 + nameBytes.length))).toBe(name);
      // The local header agrees and is followed by exactly the file's bytes.
      expect(v.getUint32(local, true)).toBe(0x04034b50);
      expect(v.getUint16(local + 6, true)).toBe(0x0800);
      expect(v.getUint32(local + 14, true)).toBe(crc32(body));
      expect(v.getUint16(local + 26, true)).toBe(nameBytes.length);
      expect(v.getUint16(local + 28, true)).toBe(0);
      const start = local + 30 + nameBytes.length;
      expect(bytes.subarray(start, start + body.length)).toEqual(body);
      // DOS time 13:45:30 and date 2026-11-27, in both headers.
      for (const at of [p + 12, local + 10]) {
        expect(v.getUint16(at, true)).toBe((13 << 11) | (45 << 5) | 15);
        expect(v.getUint16(at + 2, true)).toBe(((2026 - 1980) << 9) | (11 << 5) | 27);
      }
      local = start + body.length;
      p += 46 + nameBytes.length;
    }
    expect(local).toBe(cdStart);
    expect(p).toBe(end);
  });

  it('reads back exactly what it wrote', async () => {
    const entries = await readZip(await archive());
    expect(entries.map((e) => e.name)).toEqual(FILES.map(([n]) => n));
    expect(entries[0]?.modified.toISOString()).toBe('2026-11-27T13:45:30.000Z');
    entries.forEach((e, i) => {
      const data = FILES[i]![1];
      expect(e.data).toEqual(typeof data === 'string' ? enc.encode(data) : data);
    });
  });

  it('refuses duplicate and unsafe names', () => {
    const w = new ZipWriter();
    w.add('a.md', 'x');
    expect(() => w.add('a.md', 'y')).toThrow(RangeError);
    expect(() => w.add('/abs.md', 'y')).toThrow(RangeError);
    expect(() => w.add('back\\slash.md', 'y')).toThrow(RangeError);
    w.finish();
    expect(() => w.add('b.md', 'y')).toThrow();
  });

  it.runIf(has('unzip'))('is accepted by unzip, which extracts the same bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
    try {
      writeFileSync(join(dir, 'a.zip'), await archive());
      execFileSync('unzip', ['-tq', join(dir, 'a.zip')]);
      execFileSync('unzip', ['-q', join(dir, 'a.zip'), '-d', join(dir, 'out')]);
      for (const [name, data] of FILES) {
        const want = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
        expect(readFileSync(join(dir, 'out', name))).toEqual(want);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readZip', () => {
  /** A one-file archive with a deflated entry, assembled by hand. */
  function deflated(name: string, text: string): Uint8Array {
    const body = enc.encode(text);
    const packed = deflateRawSync(body);
    const n = enc.encode(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(body), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(body), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(n.length, 28);
    const cdStart = 30 + n.length + packed.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(46 + n.length, 12);
    end.writeUInt32LE(cdStart, 16);
    return new Uint8Array(Buffer.concat([local, n, packed, central, n, end]));
  }

  it('reads deflated entries too', async () => {
    const text = '# Moss\n\n'.concat('carpet of moss '.repeat(200));
    const [entry] = await readZip(deflated('memos/moss.md', text));
    expect(entry?.name).toBe('memos/moss.md');
    expect(new TextDecoder().decode(entry?.data)).toBe(text);
  });

  it('rejects damaged archives', async () => {
    await expect(readZip(enc.encode('not a zip at all'))).rejects.toThrow(ZipError);
    const bytes = await archive();
    // Flip one byte of the first file's data: its CRC no longer matches.
    const at = 30 + enc.encode('memos/fern.md').length;
    bytes[at] = (bytes[at] as number) ^ 1;
    await expect(readZip(bytes)).rejects.toThrow(/checksum/);
  });
});
