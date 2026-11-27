// Renders a note's markdown for the note view and the editor's live preview.
//
// `renderMarkdownUnsafe` is pure (markdown-it only) so it can be unit tested in
// Node; its output may contain raw HTML from the note. The UI must only ever
// insert `renderMarkdown`'s output, which is the same HTML sanitized with
// DOMPurify.

import MarkdownIt from 'markdown-it';
import type { MarkdownIt as Renderer, StateCore, StateInline, Token } from 'markdown-it';
import DOMPurify from 'dompurify';
import { markdown as md } from '@somememos/core';
import { slugify } from './paths.ts';

/** What the renderer needs to know about a `[[link]]` target. */
export interface WikiLinkInfo {
  /** Where the link goes in the app. */
  readonly href: string;
  /** False for a link to a note that doesn't exist yet. */
  readonly exists: boolean;
}

export interface RenderOptions {
  /** Resolves a link target (as written, before `#` and `|`). */
  readonly resolveLink: (target: string) => WikiLinkInfo;
}

/** The front matter block and the body after it. */
export interface FrontMatterSplit {
  /** The lines between the delimiters, or null without front matter. */
  readonly frontMatter: string | null;
  readonly body: string;
}

/** Separates YAML front matter (shown as properties, not as markdown) from the body. */
export function splitFrontMatter(text: string): FrontMatterSplit {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)(?:^|\r?\n)(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { frontMatter: null, body: text };
  return { frontMatter: m[1] ?? '', body: text.slice(m[0].length) };
}

/** A heading's anchor id. Prefixed so it can never clobber a DOM property. */
export function headingId(text: string): string {
  return `h-${slugify(text, 60)}`;
}

function wikiLinkRule(options: RenderOptions) {
  return (state: StateInline, silent: boolean): boolean => {
    const src = state.src;
    let pos = state.pos;
    const embed = src.charCodeAt(pos) === 0x21; /* ! */
    if (embed) pos += 1;
    if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
    const close = src.indexOf(']]', pos + 2);
    if (close < 0) return false;
    const inner = src.slice(pos + 2, close);
    if (/[[\]\n]/.test(inner)) return false;
    const parts = md.splitWikiLink(inner);
    if (!silent) {
      const label =
        parts.alias ??
        (parts.heading && parts.target
          ? `${parts.target} › ${parts.heading}`
          : (parts.heading ?? parts.target));
      if (parts.target === '') {
        // `[[#heading]]` is not a link (PLAN.md section 5); show its text.
        const t = state.push('text', '', 0);
        t.content = label;
      } else {
        const info = options.resolveLink(parts.target);
        const href = parts.heading ? `${info.href}#${headingId(parts.heading)}` : info.href;
        const open = state.push('link_open', 'a', 1);
        open.attrSet('href', info.exists ? href : info.href);
        open.attrSet(
          'class',
          `wikilink${info.exists ? '' : ' wikilink-missing'}${embed ? ' wikilink-embed' : ''}`,
        );
        open.attrSet('data-target', parts.target);
        if (!info.exists) open.attrSet('title', 'Not written yet: opens a new note');
        const t = state.push('text', '', 0);
        t.content = label;
        state.push('link_close', 'a', -1);
      }
    }
    state.pos = close + 2;
    return true;
  };
}

/** `- [ ] task` and `- [x] done` list items, rendered as read-only checkboxes. */
function taskListRule(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i] as Token;
    if (inline.type !== 'inline') continue;
    if (tokens[i - 1]?.type !== 'paragraph_open' || tokens[i - 2]?.type !== 'list_item_open')
      continue;
    const m = /^\[([ xX])\][ \t]/.exec(inline.content);
    const first = inline.children?.[0];
    if (!m || !first || first.type !== 'text' || !first.content.startsWith(m[0])) continue;
    first.content = first.content.slice(m[0].length);
    inline.content = inline.content.slice(m[0].length);
    const box = new state.Token('html_inline', '', 0);
    const checked = m[1] !== ' ';
    box.content = `<input type="checkbox" disabled${checked ? ' checked' : ''} aria-label="${checked ? 'Done' : 'Not done'}"> `;
    inline.children?.unshift(box);
    (tokens[i - 2] as Token).attrJoin('class', 'task-list-item');
  }
}

/** Gives headings ids, for `[[note#heading]]` links. */
function headingIdRule(state: StateCore): void {
  const seen = new Map<string, number>();
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i] as Token;
    if (t.type !== 'heading_open') continue;
    const text = (tokens[i + 1] as Token).content;
    let id = headingId(md.stripInlineMarkdown(text));
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n > 0) id = `${id}-${n + 1}`;
    t.attrSet('id', id);
  }
}

function createRenderer(options: RenderOptions): Renderer {
  const it = new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: false });
  it.inline.ruler.before('link', 'wikilink', wikiLinkRule(options));
  it.core.ruler.after('inline', 'task-list', taskListRule);
  it.core.ruler.after('inline', 'heading-ids', headingIdRule);
  // Tables scroll inside their own box instead of widening the page.
  it.renderer.rules.table_open = () =>
    '<div class="table-scroll" tabindex="0" role="region" aria-label="Table"><table>\n';
  it.renderer.rules.table_close = () => '</table></div>\n';
  return it;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The note rendered to HTML, NOT sanitized. Front matter is shown as a properties block. */
export function renderMarkdownUnsafe(text: string, options: RenderOptions): string {
  const { frontMatter, body } = splitFrontMatter(text);
  let html = createRenderer(options).render(body);
  if (frontMatter !== null && frontMatter.trim() !== '') {
    html = `<details class="front-matter"><summary>Properties</summary><pre>${escapeHtml(frontMatter)}</pre></details>\n${html}`;
  }
  return html;
}

/** The note rendered to sanitized HTML, safe to insert into the page. Browser only. */
export function renderMarkdown(text: string, options: RenderOptions): string {
  return DOMPurify.sanitize(renderMarkdownUnsafe(text, options), {
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['style', 'form'],
  });
}
