// A blog post's publish state (PLAN.md section 8, "Publishing a blog"): a post
// is public only when its front matter says `published: true`. Anything else
// is a draft, so a half-written post can't go public by accident. Nothing is
// published anywhere yet; this only reads the state.

import { splitLines } from './blocks.js';
import { detectFrontMatter } from './front-matter.js';

const PUBLISHED_KEY = /^published[ \t]*:[ \t]*(.*)$/;
const TRUE_VALUES = new Set(['true', 'yes']);

/**
 * True when the note's front matter has a top-level `published:` key whose
 * value is the plain (unquoted) scalar `true` or `yes`, in any letter case,
 * optionally followed by a `# comment`. Everything else is a draft: no front
 * matter, no key, `false`, a quoted `"true"` (a string in YAML, not a
 * boolean), or any other value. When the key repeats, the last one wins, as
 * in most YAML readers.
 */
export function isPublished(text: string): boolean {
  const fm = detectFrontMatter(splitLines(text));
  if (!fm) return false;
  let published = false;
  for (const line of fm.raw.split('\n')) {
    const m = PUBLISHED_KEY.exec(line);
    if (!m) continue;
    const value = (m[1] ?? '').replace(/(^|[ \t])#.*$/, '').trim();
    published = TRUE_VALUES.has(value.toLowerCase());
  }
  return published;
}
