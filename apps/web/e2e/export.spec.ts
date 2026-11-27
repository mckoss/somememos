// "Export everything" on the More screen: a deflated zip of every stored
// note plus events.jsonl, built in the worker. The zip is parsed here with a
// reader of its own (not the app's), and every file is compared byte for byte.

import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { engineCall, importBrain } from './fixtures.ts';

interface Entry {
  readonly name: string;
  readonly data: Buffer;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const b of data) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Parses a zip by its central directory, checking every local header, data
 * descriptor and CRC, and that the files sit back to back.
 */
function parseZip(zip: Buffer): Entry[] {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end), 'end of central directory').toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  const cdSize = zip.readUInt32LE(end + 12);
  let p = zip.readUInt32LE(end + 16);
  expect(p + cdSize).toBe(end);
  const out: Entry[] = [];
  let expectedLocal = 0;
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50);
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const csize = zip.readUInt32LE(p + 20);
    const usize = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extra = zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const nameBytes = zip.subarray(p + 46, p + 46 + nameLen);
    const name = nameBytes.toString('utf8');
    // An ASCII name reads the same in every encoding; any other must be flagged UTF-8.
    if (nameBytes.some((b) => b > 0x7f)) {
      expect(flags & 0x0800, `${name}: UTF-8 flag`).toBe(0x0800);
    }
    expect(method, `${name}: deflated`).toBe(8);
    expect(local, `${name}: files are back to back`).toBe(expectedLocal);
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    expect(
      zip.subarray(local + 30, local + 30 + nameLen).equals(nameBytes),
      `${name}: local name`,
    ).toBe(true);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    let next = start + csize;
    if (flags & 0x0008) {
      // Sizes and CRC follow the data, in a data descriptor (its signature is optional).
      if (zip.readUInt32LE(next) === 0x08074b50) next += 4;
      expect(zip.readUInt32LE(next), `${name}: descriptor CRC`).toBe(crc);
      expect(zip.readUInt32LE(next + 4)).toBe(csize);
      expect(zip.readUInt32LE(next + 8)).toBe(usize);
      next += 12;
    } else {
      expect(zip.readUInt32LE(local + 14)).toBe(crc);
    }
    const raw = zip.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    expect(data.length).toBe(usize);
    expect(crc32(data), `${name}: CRC-32`).toBe(crc);
    out.push({ name, data });
    expectedLocal = next;
    p += 46 + nameLen + extra;
  }
  expect(expectedLocal).toBe(zip.readUInt32LE(end + 16));
  return out;
}

/** Imports the test brain, then excludes one more folder (its notes stay stored). */
async function prepare(page: Page): Promise<{ expected: Map<string, string>; excluded: string }> {
  const brain = await importBrain(page);
  // Notes in private/ were excluded before the import, so they were never stored.
  const stored = brain.paths.filter((p) => !p.startsWith('private/') && p.endsWith('.md'));
  const folder = stored.find((p) => p.includes('/'))?.split('/')[0];
  expect(folder).toBeTruthy();
  const excluded = `${folder}/`;
  await page.evaluate(async (excluded) => {
    const host = (
      globalThis as unknown as {
        somememos: {
          host: {
            engine: { config: { roles: Record<string, string[]> } };
            updateConfig(c: unknown): Promise<void>;
          };
        };
      }
    ).somememos.host;
    const config = host.engine.config;
    await host.updateConfig({
      ...config,
      roles: { ...config.roles, excluded: [...(config.roles.excluded ?? []), excluded] },
    });
  }, excluded);
  const expected = new Map(stored.map((p) => [p, brain.files[p] as string]));
  expected.set('events.jsonl', await engineCall<string>(page, 'exportLog'));
  return { expected, excluded };
}

function compare(entries: Entry[], expected: Map<string, string>, excluded: string): void {
  expect(entries.map((e) => e.name).sort()).toEqual([...expected.keys()].sort());
  expect(entries.some((e) => e.name.startsWith(excluded))).toBe(true);
  for (const e of entries) {
    expect(e.data.equals(Buffer.from(expected.get(e.name) as string, 'utf8')), e.name).toBe(true);
  }
}

/** Hides the save picker, so the app falls back to a download. */
const withoutPicker = (page: Page) =>
  page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });

test('exports every note and the event log as a zip download', async ({ page }) => {
  await withoutPicker(page);
  const { expected, excluded } = await prepare(page);
  const downloading = page.waitForEvent('download');
  await page.getByTestId('export-everything').click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^somememos-\d{4}-\d\d-\d\d\.zip$/);
  const zip = readFileSync(await download.path());
  compare(parseZip(zip), expected, excluded);
  await expect(page.getByTestId('export-message')).toContainText(
    `Exported ${expected.size - 1} notes`,
  );
});

test('imports an exported zip into an empty brain: notes and log come back', async ({
  page,
  browser,
}, info) => {
  await withoutPicker(page);
  const { expected, excluded } = await prepare(page);
  const downloading = page.waitForEvent('download');
  await page.getByTestId('export-everything').click();
  const zipPath = await (await downloading).path();
  const first = parseZip(readFileSync(zipPath));
  compare(first, expected, excluded);

  // A fresh browser context is a fresh, empty brain.
  const context = await browser.newContext(info.project.use);
  try {
    const other = await context.newPage();
    await other.goto('/more');
    await other.waitForFunction(() => 'somememos' in globalThis);
    await other.getByTestId('import-zip').setInputFiles(zipPath);
    const importSection = other.locator('#import');
    await expect(other.getByText(/files? found/)).toBeVisible();
    await importSection.getByRole('button', { name: /^Import \d+ notes/ }).click();
    await expect(importSection.getByText(/^Imported \d+ notes/)).toBeVisible();
    await expect(importSection.getByText(/Added \d+ records from the event log/)).toBeVisible();

    // Exporting the new brain gives the same notes, byte for byte, and the same log.
    const bytes = await other.evaluate(async () => {
      const host = (
        globalThis as unknown as {
          somememos: { host: { exportArchive(): Promise<{ archive: Blob }> } };
        }
      ).somememos.host;
      const { archive } = await host.exportArchive();
      return Array.from(new Uint8Array(await archive.arrayBuffer()));
    });
    const second = parseZip(Buffer.from(bytes));
    const lines = (e: Entry[]) =>
      e
        .find((x) => x.name === 'events.jsonl')!
        .data.toString('utf8')
        .split('\n')
        .filter(Boolean)
        .sort();
    expect(lines(second)).toEqual(lines(first));
    const notes = (e: Entry[]) => e.filter((x) => x.name !== 'events.jsonl');
    expect(notes(second).map((x) => x.name)).toEqual(notes(first).map((x) => x.name));
    notes(second).forEach((x, i) =>
      expect(x.data.equals(notes(first)[i]!.data), x.name).toBe(true),
    );
  } finally {
    await context.close();
  }
});

test('writes the zip to a file chosen with the File System Access API', async ({ page }) => {
  // A stand-in for the save picker that collects what the app writes.
  await page.addInitScript(() => {
    const w = window as unknown as { savedChunks: number[][]; savedName: string };
    w.savedChunks = [];
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async (opts: {
      suggestedName: string;
    }) => {
      w.savedName = opts.suggestedName;
      return {
        createWritable: async () =>
          new WritableStream<Uint8Array>({
            write(chunk) {
              w.savedChunks.push(Array.from(chunk));
            },
          }),
      };
    };
  });
  const { expected, excluded } = await prepare(page);
  await page.getByTestId('export-everything').click();
  await expect(page.getByTestId('export-message')).toContainText('Exported');
  const { chunks, name } = await page.evaluate(() => {
    const w = window as unknown as { savedChunks: number[][]; savedName: string };
    return { chunks: w.savedChunks, name: w.savedName };
  });
  expect(name).toMatch(/\.zip$/);
  const zip = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  compare(parseZip(zip), expected, excluded);
});
