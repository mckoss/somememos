// Finds `[[wiki-links]]` and `![[embeds]]` outside code.

import { scanBlocks, type BlockScan } from './blocks.js';
import { sectionsFromScan, type Section } from './chunker.js';
import { maskCodeSpans, splitWikiLink } from './inline.js';

export interface WikiLink {
  /** The link target as written, trimmed (`folder/Note`, `Note.md`, `../x`). */
  target: string;
  /** The part after `#`, if any (a heading, or `^block` id). */
  heading?: string;
  /** The part after `|`, if any. */
  alias?: string;
  /** True for `![[...]]`. */
  embed: boolean;
  /** 1-based line the link starts on. */
  line: number;
  /** Index into the note's sections of the section holding the link. */
  section: number;
}

const LINK = /(!?)\[\[([^[\]\n]*)\]\]/g;

/** Links from an existing block scan and its sections. */
export function linksFromScan(scan: BlockScan, sections: readonly Section[]): WikiLink[] {
  const { lines } = scan;
  const links: WikiLink[] = [];
  let sectionIdx = 0;

  // Code spans may span the lines of one paragraph, so mask each run of text
  // lines together. A heading is a block of its own.
  let i = scan.bodyStart;
  while (i < lines.length) {
    const kind = lines[i]?.kind;
    if (kind !== 'text' && kind !== 'heading') {
      i++;
      continue;
    }
    let end = i + 1;
    if (kind === 'text') while (end < lines.length && lines[end]?.kind === 'text') end++;
    const block = lines
      .slice(i, end)
      .map((l) => l.text)
      .join('\n');
    const masked = maskCodeSpans(block);

    let line = i + 1;
    let lastOffset = 0;
    for (const m of masked.matchAll(LINK)) {
      let offset = m.index;
      let embed = m[1] === '!';
      // A backslash before `[[` (or before `!`) escapes the link (or the embed).
      if (embed && isEscaped(masked, offset)) {
        embed = false;
        offset += 1;
      } else if (!embed && isEscaped(masked, offset)) {
        continue;
      }
      // A match that overlaps a code span is not a link.
      if (block.slice(m.index, m.index + m[0].length) !== m[0]) continue;
      const parts = splitWikiLink(m[2] as string);
      if (parts.target === '') continue;
      for (let k = lastOffset; k < offset; k++) if (masked[k] === '\n') line++;
      lastOffset = offset;
      while (
        sectionIdx + 1 < sections.length &&
        (sections[sectionIdx + 1] as Section).startLine <= line
      ) {
        sectionIdx++;
      }
      const link: WikiLink = { target: parts.target, embed, line, section: sectionIdx };
      if (parts.heading !== undefined) link.heading = parts.heading;
      if (parts.alias !== undefined) link.alias = parts.alias;
      links.push(link);
    }
    i = end;
  }
  return links;
}

function isEscaped(text: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) n++;
  return n % 2 === 1;
}

/** Finds every wiki-link and embed in a note, in document order. */
export function parseLinks(text: string): WikiLink[] {
  const scan = scanBlocks(text);
  return linksFromScan(scan, sectionsFromScan(scan));
}
