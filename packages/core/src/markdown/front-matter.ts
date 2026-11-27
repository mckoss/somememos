// YAML front matter: only detection and a simple scalar `title`. This is not a
// YAML parser; every other key is ignored.

export interface FrontMatter {
  /** The lines between the delimiters, joined with `\n`. */
  raw: string;
  /** The `title` key, when it is a simple (plain or quoted) scalar. */
  title?: string;
  /** 1-based line of the closing delimiter; the body starts on the next line. */
  endLine: number;
}

const OPEN = /^---[ \t]*$/;
const CLOSE = /^(?:---|\.\.\.)[ \t]*$/;

/**
 * Detects a front matter block: a first line of `---` and a later closing line
 * of `---` or `...`. Without a closing line there is no front matter.
 */
export function detectFrontMatter(lines: readonly string[]): FrontMatter | null {
  if (lines.length === 0 || !OPEN.test(lines[0] as string)) return null;
  for (let i = 1; i < lines.length; i++) {
    if (CLOSE.test(lines[i] as string)) {
      const inner = lines.slice(1, i);
      const fm: FrontMatter = { raw: inner.join('\n'), endLine: i + 1 };
      const title = extractTitle(inner);
      if (title !== undefined) fm.title = title;
      return fm;
    }
  }
  return null;
}

const TITLE_KEY = /^title[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/;
const NULLS = new Set(['~', 'null', 'Null', 'NULL']);
const NOT_SIMPLE = /^[|>[{&*!%@`]/;

function extractTitle(lines: readonly string[]): string | undefined {
  for (let i = 0; i < lines.length; i++) {
    const m = TITLE_KEY.exec(lines[i] as string);
    if (!m) continue;
    const value = (m[1] ?? '').trim();
    let title: string | undefined;
    if (value.startsWith('"')) title = doubleQuoted(value);
    else if (value.startsWith("'")) title = singleQuoted(value);
    else if (value !== '' && !NOT_SIMPLE.test(value)) {
      // A plain scalar may continue on more-indented lines; YAML folds them with spaces.
      const parts = [stripComment(value)];
      for (let j = i + 1; j < lines.length && /^[ \t]+\S/.test(lines[j] as string); j++) {
        parts.push(stripComment((lines[j] as string).trim()));
      }
      title = parts.join(' ').trim();
      if (NULLS.has(title)) title = undefined;
    }
    return title === '' ? undefined : title;
  }
  return undefined;
}

function stripComment(value: string): string {
  const m = /(^|[ \t])#/.exec(value);
  return (m ? value.slice(0, m.index) : value).trim();
}

/** Only a comment or nothing may follow a closing quote. */
function restIsEmpty(rest: string): boolean {
  return /^[ \t]*(?:#.*)?$/.test(rest);
}

const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  n: '\n',
  t: '\t',
  r: '\r',
  '0': '\0',
  ' ': ' ',
};

function doubleQuoted(value: string): string | undefined {
  let out = '';
  for (let i = 1; i < value.length; i++) {
    const ch = value[i] as string;
    if (ch === '"') return restIsEmpty(value.slice(i + 1)) ? out : undefined;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = value[++i];
    if (next === undefined) return undefined;
    if (next === 'u' || next === 'x') {
      const len = next === 'u' ? 4 : 2;
      const hex = value.slice(i + 1, i + 1 + len);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) return undefined;
      out += String.fromCharCode(parseInt(hex, 16));
      i += len;
    } else if (next in ESCAPES) {
      out += ESCAPES[next];
    } else {
      return undefined;
    }
  }
  return undefined; // unterminated (multi-line quoted scalars are not supported)
}

function singleQuoted(value: string): string | undefined {
  let out = '';
  for (let i = 1; i < value.length; i++) {
    const ch = value[i] as string;
    if (ch !== "'") {
      out += ch;
    } else if (value[i + 1] === "'") {
      out += "'";
      i++;
    } else {
      return restIsEmpty(value.slice(i + 1)) ? out : undefined;
    }
  }
  return undefined;
}
