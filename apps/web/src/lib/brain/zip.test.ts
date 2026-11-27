import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, unzipSync, Zip, ZipPassThrough, zipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { readZip, ZIP_LIMITS, ZipError, ZipWriter } from './zip.ts';

const enc = new TextEncoder();

function has(tool: string, arg = '-h'): boolean {
  try {
    execFileSync(tool, [arg], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const hasUnzip = has('unzip');
const hasZip = has('zip');
const hasPython = has('python3', '--version');

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// Invented notes covering what must survive byte for byte.
const FILES: [string, string | Uint8Array][] = [
  ['memos/fern.md', '# Fern\n\nSpores under the frond.\n'],
  ['memos/crlf.md', '# Windows\r\n\r\nLine one\r\nLine two\r\n'],
  ['memos/no-newline.md', '# No trailing newline'],
  ['memos/bom.md', '\ufeff# Starts with a byte order mark\n'],
  ['diary/2026/2026-11-27.md', '# 27 November\n'],
  ['memos/café ☕/naïve 日本.md', '# Ünïcödé\n\nemoji 🌱 and CJK 森\n'],
  ['memos/empty.md', ''],
  ['bytes.bin', new Uint8Array([0, 255, 1, 254, 0x50, 0x4b, 3, 4, 0x50, 0x4b, 7, 8])],
  ['memos/long.md', '# Moss\n\n'.concat('A carpet of moss on the north side.\n'.repeat(5000))],
  ['events.jsonl', '{"type":"log","id":"e1"}\n'],
];
const bytesOf = (data: string | Uint8Array) => (typeof data === 'string' ? enc.encode(data) : data);

async function archive(files = FILES): Promise<Uint8Array> {
  const w = new ZipWriter();
  for (const [name, data] of files) w.add(name, data, new Date(2026, 10, 27, 13, 45, 30));
  return new Uint8Array(await w.finish().arrayBuffer());
}

/** Writes `bytes` to a temp file and returns its path. */
function saved(bytes: Uint8Array, name = 'a.zip'): string {
  const path = join(tempDir(), name);
  writeFileSync(path, bytes);
  return path;
}

/** A zip made by Python's zipfile, from a script that writes to sys.argv[1]. */
function pythonZip(script: string): Uint8Array {
  const dir = tempDir();
  const out = join(dir, 'py.zip');
  const file = join(dir, 'make.py');
  writeFileSync(file, `import sys, zipfile\n${script}\n`);
  execFileSync('python3', ['-I', file, out]);
  return new Uint8Array(readFileSync(out));
}

describe('ZipWriter', () => {
  it('round-trips every file byte for byte, with exact UTF-8 names', async () => {
    const entries = readZip(await archive());
    expect(entries.map((e) => e.name)).toEqual(FILES.map(([n]) => n));
    entries.forEach((e, i) => expect(e.data).toEqual(bytesOf(FILES[i]![1])));
  });

  it('deflates every file and marks non-ASCII names as UTF-8', async () => {
    const bytes = await archive();
    const seen: Record<string, number> = {};
    unzipSync(bytes, {
      filter: (info) => {
        seen[info.name] = info.compression;
        return false;
      },
    });
    expect(Object.values(seen).every((c) => c === 8)).toBe(true);
    // The UTF-8 flag (general purpose bit 11) on the one non-ASCII name's local header.
    const name = enc.encode('memos/café ☕/naïve 日本.md');
    for (let i = 0; i < bytes.length - 4; i++) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 3 && bytes[i + 3] === 4) {
        const len = (bytes[i + 26] as number) | ((bytes[i + 27] as number) << 8);
        const flags = (bytes[i + 6] as number) | ((bytes[i + 7] as number) << 8);
        if (
          len === name.length &&
          bytes.subarray(i + 30, i + 30 + len).every((b, j) => b === name[j])
        ) {
          expect(flags & 0x0800).toBe(0x0800);
          return;
        }
      }
    }
    throw new Error('the non-ASCII entry was not found');
  });

  it('streams: bytes leave the writer as files are added, not at the end', () => {
    const w = new ZipWriter();
    const noise = new Uint8Array(9 * 1024 * 1024);
    let x = 2463534242; // xorshift32: bytes deflate cannot shrink
    for (let i = 0; i < noise.length; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      noise[i] = x & 0xff;
    }
    w.add('big.bin', noise);
    expect(w.size).toBeGreaterThan(9 * 1024 * 1024);
    w.add('after.md', 'x');
    expect(w.finish().size).toBeGreaterThan(w.size - 1024);
  });

  it('refuses to add after finishing', () => {
    const w = new ZipWriter();
    w.add('a.md', 'x');
    w.finish();
    expect(() => w.add('b.md', 'y')).toThrow();
    expect(() => w.finish()).toThrow();
  });

  it('stops at 65,535 files instead of writing a broken archive', async () => {
    const w = new ZipWriter();
    for (let i = 0; i < 65_535; i++) w.add(`n/${i}.md`, '');
    expect(() => w.add('one-too-many.md', '')).toThrow(/65,535/);
    const entries = readZip(new Uint8Array(await w.finish().arrayBuffer()));
    expect(entries).toHaveLength(65_535);
  }, 60_000);

  it.runIf(hasUnzip)('passes unzip -t, and unzip extracts the same bytes', async () => {
    const zip = saved(await archive());
    const out = join(tempDir(), 'out');
    execFileSync('unzip', ['-tq', zip]);
    execFileSync('unzip', ['-q', zip, '-d', out]);
    for (const [name, data] of FILES) {
      expect(new Uint8Array(readFileSync(join(out, name)))).toEqual(bytesOf(data));
    }
  });

  it.runIf(hasPython)('is read by Python zipfile, CRCs checked', async () => {
    const zip = saved(await archive());
    const check = join(tempDir(), 'check.py');
    writeFileSync(
      check,
      'import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(len(z.namelist()))\n',
    );
    expect(execFileSync('python3', ['-I', check, zip]).toString().trim()).toBe(
      String(FILES.length),
    );
  });
});

describe('readZip: archives from other tools', () => {
  it.runIf(hasZip)('reads a zip -r archive with folder entries, stripping a wrapper folder', () => {
    const dir = tempDir();
    const root = join(dir, 'my brain');
    mkdirSync(join(root, 'memos', 'empty folder'), { recursive: true });
    writeFileSync(join(root, 'memos', 'fern.md'), '# Fern\r\n');
    writeFileSync(join(root, 'events.jsonl'), '{"id":"e1"}\n');
    writeFileSync(join(root, '.DS_Store'), 'junk');
    execFileSync('zip', ['-qr', join(dir, 'z.zip'), 'my brain'], { cwd: dir });
    const entries = readZip(new Uint8Array(readFileSync(join(dir, 'z.zip'))));
    expect(entries.map((e) => e.name).sort()).toEqual(['events.jsonl', 'memos/fern.md']);
    expect(entries.find((e) => e.name === 'memos/fern.md')?.data).toEqual(enc.encode('# Fern\r\n'));
  });

  it.runIf(hasPython)('reads stored and deflated entries, and data descriptors', () => {
    const bytes = pythonZip(`
with open(sys.argv[1], 'wb') as raw:
    class Unseekable:
        def write(self, b): return raw.write(b)
        def flush(self): raw.flush()
    with zipfile.ZipFile(Unseekable(), 'w') as z:
        z.writestr('memos/stored.md', '# Stored\\n', compress_type=zipfile.ZIP_STORED)
        z.writestr('memos/deflated.md', '# Deflated\\n' * 50, compress_type=zipfile.ZIP_DEFLATED)
`);
    const entries = readZip(bytes);
    expect(entries.map((e) => [e.name, new TextDecoder().decode(e.data)])).toEqual([
      ['memos/stored.md', '# Stored\n'],
      ['memos/deflated.md', '# Deflated\n'.repeat(50)],
    ]);
  });

  it.runIf(hasPython)('reads zip64 records', () => {
    const bytes = pythonZip(`
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    with z.open('memos/forced.md', 'w', force_zip64=True) as f:
        f.write(b'# Zip64 entry\\n')
`);
    expect(readZip(bytes).map((e) => e.name)).toEqual(['memos/forced.md']);
  });

  it.runIf(hasPython)(
    'reads an archive of more than 65,535 files',
    () => {
      const bytes = pythonZip(`
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_STORED) as z:
    for i in range(70000):
        z.writestr(f'memos/{i}.md', f'# Note {i}\\n')
`);
      const entries = readZip(bytes);
      expect(entries).toHaveLength(70_000);
      expect(new TextDecoder().decode(entries[69_999]?.data)).toBe('# Note 69999\n');
    },
    60_000,
  );

  it('ignores macOS junk and folder entries', () => {
    const bytes = zipSync({
      'brain/': new Uint8Array(),
      'brain/memos/': new Uint8Array(),
      'brain/memos/a.md': strToU8('# A\n'),
      'brain/.DS_Store': strToU8('junk'),
      '__MACOSX/brain/memos/._a.md': strToU8('resource fork'),
      'brain/events.jsonl': strToU8('{}\n'),
    });
    expect(readZip(bytes).map((e) => e.name)).toEqual(['memos/a.md', 'events.jsonl']);
  });

  it('keeps one shared folder when there is no events.jsonl beside it', () => {
    const bytes = zipSync({ 'memos/a.md': strToU8('a'), 'memos/b.md': strToU8('b') });
    expect(readZip(bytes).map((e) => e.name)).toEqual(['memos/a.md', 'memos/b.md']);
  });
});

describe('readZip: hostile and damaged archives', () => {
  const one = (name: string) => zipSync({ [name]: strToU8('x'), 'ok.md': strToU8('y') });

  it.each([
    ['../escape.md', /outside its folder/],
    ['memos/../../escape.md', /outside its folder/],
    ['..\\escape.md', /outside its folder/],
    ['/etc/passwd', /absolute path/],
    ['C:/Windows/evil.md', /absolute path/],
    ['memos//double.md', /invalid name/],
    ['memos/./dot.md', /invalid name/],
  ])('refuses %s', (name, message) => {
    expect(() => readZip(one(name))).toThrow(ZipError);
    expect(() => readZip(one(name))).toThrow(message);
  });

  it('refuses the same name twice', () => {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((error, chunk) => {
      if (error) throw error;
      chunks.push(chunk);
    });
    for (const name of ['memos/a.md', 'memos/a.md']) {
      const file = new ZipPassThrough(name);
      zip.add(file);
      file.push(strToU8(name), true);
    }
    zip.end();
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    chunks.reduce((at, c) => (bytes.set(c, at), at + c.length), 0);
    expect(() => readZip(bytes)).toThrow(/memos\/a.md twice/);
    // Also when the names differ only in their separators.
    const mixed = zipSync({ 'memos/b.md': strToU8('1'), 'memos\\b.md': strToU8('2') });
    expect(() => readZip(mixed)).toThrow(/twice/);
  });

  it('refuses a zip bomb: a large file stored at a tiny fraction of its size', () => {
    const bomb = zipSync({ 'memos/zeros.md': new Uint8Array(4 * 1024 * 1024) }, { level: 9 });
    expect(bomb.length).toBeLessThan(40 * 1024);
    expect(() => readZip(bomb)).toThrow(/zip bomb/);
  });

  it('refuses archives past the limits on files and sizes', () => {
    const many = zipSync(
      Object.fromEntries([...Array(11)].map((_, i) => [`${i}.md`, strToU8('x')])),
    );
    expect(() => readZip(many, { ...ZIP_LIMITS, entries: 10 })).toThrow(/too many files/);
    const big = zipSync({ 'big.md': new Uint8Array(2000), 'b.md': new Uint8Array(2000) });
    expect(() => readZip(big, { ...ZIP_LIMITS, entryBytes: 1000 })).toThrow(/big.md is too large/);
    expect(() => readZip(big, { ...ZIP_LIMITS, totalBytes: 3000 })).toThrow(/once unpacked/);
    expect(() => readZip(big, { ...ZIP_LIMITS, archiveBytes: 100 })).toThrow(/too large/);
  });

  it('refuses unknown compression methods', () => {
    const bytes = one('memos/a.md');
    // The central directory's method field for the first entry: set it to LZMA (14).
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 1 && bytes[i + 3] === 2) {
        bytes[i + 10] = 14;
      }
    }
    expect(() => readZip(bytes)).toThrow(/compression this app cannot read/);
  });

  it('refuses what is not a zip, and damaged archives', async () => {
    expect(() => readZip(enc.encode('not a zip at all'))).toThrow(ZipError);
    const bytes = await archive();
    expect(() => readZip(bytes.subarray(0, bytes.length >>> 1))).toThrow(ZipError);
    // Break the first file's deflate stream (its first byte, a block header).
    const at = 30 + enc.encode('memos/fern.md').length;
    const broken = bytes.slice();
    broken[at] = 0xff;
    expect(() => readZip(broken)).toThrow(ZipError);
  });
});
