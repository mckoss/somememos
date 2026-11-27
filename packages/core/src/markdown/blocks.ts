// Line-level block scan shared by the chunker and the link parser. It decides,
// for every line, whether it is front matter, fenced code, indented code, a
// blank line, an ATX heading or ordinary text. This is a deliberately small
// subset of CommonMark: enough to never mistake code for headings or links.

import { detectFrontMatter, type FrontMatter } from './front-matter.js';

export type LineKind = 'front-matter' | 'fence' | 'code' | 'blank' | 'heading' | 'text';

export interface ScannedLine {
  /** The line's text, without its line ending. */
  text: string;
  kind: LineKind;
  /** Heading level 1-6, for `heading` lines only. */
  level?: number;
  /** Raw heading content (closing hashes removed), for `heading` lines only. */
  heading?: string;
}

export interface BlockScan {
  lines: ScannedLine[];
  frontMatter: FrontMatter | null;
  /** 0-based index of the first line after the front matter. */
  bodyStart: number;
}

/**
 * Splits text into lines on `\r\n`, `\r` or `\n`. A final line ending does not
 * start another line, so `"a\n"` is one line and `""` is none. A leading byte
 * order mark is dropped.
 */
export function splitLines(text: string): string[] {
  if (text.startsWith('﻿')) text = text.slice(1);
  if (text === '') return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Leading indentation in columns, with tabs advancing to the next multiple of 4. */
export function indentWidth(line: string): number {
  let col = 0;
  for (const ch of line) {
    if (ch === ' ') col += 1;
    else if (ch === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const CLOSING_HASHES = /(?:^|[ \t]+)#+$/;

/** Parses an ATX heading line, or returns null. `## Title ##` -> level 2, `Title`. */
export function parseAtxHeading(line: string): { level: number; text: string } | null {
  const m = ATX.exec(line);
  if (!m) return null;
  const hashes = m[1] as string;
  const content = (m[2] ?? '').replace(CLOSING_HASHES, '').trim();
  return { level: hashes.length, text: content };
}

interface OpenFence {
  char: string;
  length: number;
  maxCloseIndent: number;
}

function closesFence(line: string, fence: OpenFence): boolean {
  if (indentWidth(line) > fence.maxCloseIndent) return false;
  const rest = line.trimStart();
  let n = 0;
  while (rest[n] === fence.char) n++;
  return n >= fence.length && BLANK.test(rest.slice(n));
}

/** Classifies every line of a note. */
export function scanBlocks(text: string): BlockScan {
  const raw = splitLines(text);
  const frontMatter = detectFrontMatter(raw);
  const bodyStart = frontMatter ? frontMatter.endLine : 0;
  const lines: ScannedLine[] = [];

  for (let i = 0; i < bodyStart; i++) lines.push({ text: raw[i] as string, kind: 'front-matter' });

  let fence: OpenFence | null = null;
  let inList = false;
  // Whether the previous line was paragraph text, which indented code may not interrupt.
  let prevParagraph = false;
  let prevBlank = true;

  for (let i = bodyStart; i < raw.length; i++) {
    const line = raw[i] as string;

    if (fence) {
      lines.push({ text: line, kind: 'fence' });
      if (closesFence(line, fence)) fence = null;
      prevParagraph = false;
      prevBlank = false;
      continue;
    }

    if (BLANK.test(line)) {
      lines.push({ text: line, kind: 'blank' });
      prevParagraph = false;
      prevBlank = true;
      continue;
    }

    const indent = indentWidth(line);

    // Indented code: 4+ columns, not continuing a paragraph, not inside a list
    // (where indentation means nested list content instead).
    if (indent >= 4 && !prevParagraph && !inList) {
      lines.push({ text: line, kind: 'code' });
      prevBlank = false;
      continue;
    }

    const open = FENCE_OPEN.exec(line);
    if (open && (indent <= 3 || inList)) {
      const marker = open[2] as string;
      const info = open[3] as string;
      if (!(marker[0] === '`' && info.includes('`'))) {
        fence = { char: marker[0] as string, length: marker.length, maxCloseIndent: indent + 3 };
        lines.push({ text: line, kind: 'fence' });
        prevParagraph = false;
        prevBlank = false;
        continue;
      }
    }

    if (indent < 4) {
      if (LIST_ITEM.test(line)) inList = true;
      else if (prevBlank) inList = false;
    }

    const heading = indent < 4 ? parseAtxHeading(line) : null;
    if (heading) {
      lines.push({ text: line, kind: 'heading', level: heading.level, heading: heading.text });
      prevParagraph = false;
    } else {
      lines.push({ text: line, kind: 'text' });
      prevParagraph = true;
    }
    prevBlank = false;
  }

  return { lines, frontMatter, bodyStart };
}
