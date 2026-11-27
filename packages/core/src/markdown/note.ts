// One-pass parse of a note: title, front matter, sections and links.

import { scanBlocks } from './blocks.js';
import { sectionsFromScan, titleFromScan, type Section } from './chunker.js';
import type { FrontMatter } from './front-matter.js';
import { linksFromScan, type WikiLink } from './links.js';

export interface ParsedNote {
  title: string;
  frontMatter: FrontMatter | null;
  /** 1-based line where the body starts (1 without front matter). */
  bodyStartLine: number;
  sections: Section[];
  links: WikiLink[];
}

/** Parses a note's markdown. `path` is brain-relative and only supplies the fallback title. */
export function parseNote(path: string, text: string): ParsedNote {
  const scan = scanBlocks(text);
  const sections = sectionsFromScan(scan);
  return {
    title: titleFromScan(scan, path),
    frontMatter: scan.frontMatter,
    bodyStartLine: scan.bodyStart + 1,
    sections,
    links: linksFromScan(scan, sections),
  };
}
