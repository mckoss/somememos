// The blog publish toggle (PLAN.md section 8): a post is public only when its
// YAML front matter says `published: true`. These helpers read and write that
// one line and leave every other byte of the note exactly as it was, so the
// markdown stays the single record of the post's state. They are not a YAML
// parser: only top-level `published:` lines are looked at.

const OPEN = /^---[ \t]*$/;
const CLOSE = /^(?:---|\.\.\.)[ \t]*$/;
const PUBLISHED_KEY = /^published[ \t]*:/;
// YAML 1.2 core schema `true`, optionally followed by a comment.
const PUBLISHED_TRUE = /^published[ \t]*:[ \t]*(?:true|True|TRUE)[ \t]*(?:#.*)?$/;

interface Line {
  /** The line's text, without its line ending. */
  readonly text: string;
  /** Offset of the line's first character. */
  readonly start: number;
  /** Offset just past the line's ending (or the end of the text). */
  readonly end: number;
  /** The line's ending as written: '\r\n', '\n', '\r', or '' for the last line. */
  readonly eol: string;
}

function linesFrom(text: string, from: number): Line[] {
  const lines: Line[] = [];
  const re = /\r\n|\n|\r/g;
  re.lastIndex = from;
  let start = from;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    lines.push({ text: text.slice(start, m.index), start, end: m.index + m[0].length, eol: m[0] });
    start = m.index + m[0].length;
  }
  lines.push({ text: text.slice(start), start, end: text.length, eol: '' });
  return lines;
}

interface Block {
  readonly open: Line;
  /** The lines between the delimiters. */
  readonly inner: Line[];
  readonly close: Line;
}

/** The front matter block: a first line (after any BOM) of `---`, then a closing `---` or `...`. */
function findBlock(text: string): Block | null {
  const lines = linesFrom(text, text.startsWith('\uFEFF') ? 1 : 0);
  const open = lines[0] as Line;
  if (!OPEN.test(open.text) || open.eol === '') return null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as Line;
    if (CLOSE.test(line.text)) return { open, inner: lines.slice(1, i), close: line };
  }
  return null;
}

/** True when the note's front matter says `published: true`. */
export function isPublished(text: string): boolean {
  return findBlock(text)?.inner.some((l) => PUBLISHED_TRUE.test(l.text)) ?? false;
}

/**
 * Returns `text` with the post published or unpublished.
 *
 * - Publishing rewrites the first top-level `published:` line (for example
 *   `published: false`) to `published: true`; without one, it adds that line
 *   at the end of the front matter, or creates a front matter block holding
 *   only that line.
 * - Unpublishing removes every `published: true` line. If that leaves the block
 *   with no lines at all, the block is removed too, so publishing and then
 *   unpublishing a note without front matter gives back the original text.
 *
 * Everything else, including line endings and a byte order mark, is kept byte
 * for byte. Returns `text` unchanged when it is already in the asked-for state.
 */
export function setPublished(text: string, published: boolean): string {
  if (isPublished(text) === published) return text;
  const block = findBlock(text);

  if (published) {
    if (!block) {
      const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      return `${bom}---${eol}published: true${eol}---${eol}${text.slice(bom.length)}`;
    }
    const existing = block.inner.find((l) => PUBLISHED_KEY.test(l.text));
    if (existing) {
      const after = existing.start + existing.text.length;
      return `${text.slice(0, existing.start)}published: true${text.slice(after)}`;
    }
    // A new last line, ended the way the opening delimiter is.
    const at = block.close.start;
    return `${text.slice(0, at)}published: true${block.open.eol}${text.slice(at)}`;
  }

  // Unpublishing: isPublished was true, so the block exists.
  const { open, inner, close } = block as Block;
  const keep = inner.filter((l) => !PUBLISHED_TRUE.test(l.text));
  if (keep.length === 0) return text.slice(0, open.start) + text.slice(close.end);
  let out = text.slice(0, open.end);
  for (const line of keep) out += text.slice(line.start, line.end);
  return out + text.slice(close.start);
}
