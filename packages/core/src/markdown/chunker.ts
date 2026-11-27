// Splits a note into sections: a preamble, then one section per `##` heading.

import { scanBlocks, type BlockScan } from './blocks.js';
import { stripInlineMarkdown } from './inline.js';
import { baseName, stripMd } from './paths.js';

export interface Section {
  /** Position in the note's section list. */
  index: number;
  /** Heading text with inline markdown stripped; null for the preamble. */
  heading: string | null;
  /** The section's lines after its heading, joined with `\n`, outer blank lines trimmed. */
  body: string;
  /** 1-based first line: the heading line, or the preamble's first line. */
  startLine: number;
  /** 1-based last line, inclusive. */
  endLine: number;
}

/** Sections from an existing block scan. */
export function sectionsFromScan(scan: BlockScan): Section[] {
  const { lines, bodyStart } = scan;
  const sections: Section[] = [];
  // Each section is [start, end) in 0-based line indexes; heading is null for the preamble.
  const push = (start: number, end: number, heading: string | null) => {
    const bodyFrom = heading === null ? start : start + 1;
    const body = trimBlankLines(lines.slice(bodyFrom, end).map((l) => l.text));
    if (heading === null && body === '') return; // an empty preamble is omitted
    sections.push({
      index: sections.length,
      heading,
      body,
      startLine: start + 1,
      endLine: end,
    });
  };

  let start = bodyStart;
  let heading: string | null = null;
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    if (line?.kind === 'heading' && line.level === 2) {
      push(start, i, heading);
      start = i;
      heading = stripInlineMarkdown(line.heading ?? '');
    }
  }
  push(start, lines.length, heading);
  return sections;
}

function trimBlankLines(texts: string[]): string {
  let a = 0;
  let b = texts.length;
  while (a < b && (texts[a] as string).trim() === '') a++;
  while (b > a && (texts[b - 1] as string).trim() === '') b--;
  return texts.slice(a, b).join('\n');
}

/** Splits a note's text into sections. */
export function chunkNote(text: string): Section[] {
  return sectionsFromScan(scanBlocks(text));
}

/** The file name without its folder or `.md`: `memos/Big idea.md` -> `Big idea`. */
export function titleFromPath(path: string): string {
  return stripMd(baseName(path));
}

/** Title from an existing block scan: front matter, first `#` heading, or file name. */
export function titleFromScan(scan: BlockScan, path: string): string {
  if (scan.frontMatter?.title !== undefined) return scan.frontMatter.title;
  for (const line of scan.lines) {
    if (line.kind === 'heading' && line.level === 1) {
      const text = stripInlineMarkdown(line.heading ?? '');
      if (text !== '') return text;
    }
  }
  return titleFromPath(path);
}

/**
 * A note's title: its front matter `title`, else its first non-empty level-1
 * heading, else its file name without `.md`.
 */
export function noteTitle(path: string, text: string): string {
  return titleFromScan(scanBlocks(text), path);
}
