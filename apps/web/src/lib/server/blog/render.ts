// Renders a published post's markdown to HTML for its public page, on the
// server. Safe without a sanitizer: markdown-it runs with raw HTML off (and
// any HTML token is escaped anyway), links are kept only for http(s),
// mailto and in-page anchors, images are shown as their alt text, and
// `[[links]]` become links only to other published posts of the same blog
// (`BlogSnapshot.link`, packages/server/src/blog.ts). Everything else a post
// links to or embeds is shown as the link's visible text, exposing no path.
//
// The app's renderer (#lib/ui/markdown.ts) allows raw HTML and sanitizes in
// the browser with DOMPurify, which needs a DOM; this one never produces
// HTML from the post that it did not build itself.

import MarkdownIt from 'markdown-it';
import type { MarkdownIt as Renderer, StateCore, StateInline, Token } from 'markdown-it';
import { markdown as md } from '@somememos/core';
import type { BlogSnapshot, PublicPost } from '@somememos/server';

export interface RenderContext {
  readonly snapshot: BlogSnapshot;
  readonly post: PublicPost;
  /** The public address of a published post (root-relative). */
  readonly urlOf: (post: PublicPost) => string;
}

/** Escapes text for HTML content and attribute values, dropping characters HTML cannot carry. */
export function escapeHtml(s: string): string {
  return s
    .replace(/[^\t\n\r\u0020-\u007e\u00a0-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '')
    .replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** An anchor id for a heading: `h-` and a slug, as the app makes them. */
export function headingId(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `h-${slug || 'section'}`;
}

const SAFE_HREF = /^(?:https?:\/\/|mailto:|#)/i;

/** The text a `[[link]]` shows: its alias, else the target's last segment without its extension. */
export function linkLabel(parts: md.WikiLinkParts): string {
  if (parts.alias !== undefined) return parts.alias;
  const last =
    parts.target
      .split('/')
      .filter((s) => s !== '')
      .at(-1) ?? parts.target;
  const name = last.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  return parts.heading ? `${name} › ${parts.heading}` : name;
}

function pushText(state: StateInline, content: string): void {
  const t = state.push('text', '', 0);
  t.content = content;
}

/**
 * Where the `]]` closing a `[[` whose inside starts at `from` is, or -1. The
 * inside has no bracket or line break, so the scan stops at the first one:
 * searching the rest of the text for `]]` instead would make a note full of
 * `[[` take time quadratic in its length.
 */
function wikiLinkEnd(src: string, from: number): number {
  for (let i = from; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 0x5d /* ] */) return src.charCodeAt(i + 1) === 0x5d ? i : -1;
    if (c === 0x5b /* [ */ || c === 0x0a /* \n */) return -1;
  }
  return -1;
}

function wikiLinkRule(ctx: RenderContext) {
  return (state: StateInline, silent: boolean): boolean => {
    const src = state.src;
    let pos = state.pos;
    const embed = src.charCodeAt(pos) === 0x21; /* ! */
    if (embed) pos += 1;
    if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
    const close = wikiLinkEnd(src, pos + 2);
    if (close < 0) return false;
    const inner = src.slice(pos + 2, close);
    if (!silent) {
      const parts = md.splitWikiLink(inner);
      if (parts.target === '') {
        // `[[#heading]]` is not a link (PLAN.md section 5): its text.
        pushText(state, parts.alias ?? parts.heading ?? '');
      } else {
        const target = ctx.snapshot.link(parts.target, ctx.post);
        if (target) {
          const href = ctx.urlOf(target) + (parts.heading ? `#${headingId(parts.heading)}` : '');
          const open = state.push('link_open', 'a', 1);
          open.attrSet('href', href);
          open.meta = { wiki: true };
          if (embed) open.attrSet('class', 'embed');
          pushText(state, parts.alias ?? (embed ? target.title : linkLabel(parts)));
          state.push('link_close', 'a', -1);
        } else if (embed && md.hasNonMarkdownExtension(parts.target)) {
          // An attachment: not served in this version. Its alias, if any, stands in.
          if (parts.alias !== undefined) pushText(state, parts.alias);
        } else {
          // Private, a draft, or missing: the text the author wrote, nothing more.
          pushText(state, linkLabel(parts));
        }
      }
    }
    state.pos = close + 2;
    return true;
  };
}

/**
 * Keeps a markdown link only when it goes to an http(s) or mailto address or
 * an anchor in the page: a relative address could name a private note. A
 * dropped link leaves its text. `[[links]]` were already decided above.
 */
function safeLinksRule(state: StateCore): void {
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue;
    const out: Token[] = [];
    const kept: boolean[] = [];
    for (const t of block.children) {
      if (t.type === 'link_open') {
        const href = String(t.attrGet('href') ?? '');
        const wiki = (t.meta as { wiki?: boolean } | null)?.wiki === true;
        const keep = wiki || SAFE_HREF.test(href);
        kept.push(keep);
        if (!keep) continue;
        if (!wiki && /^https?:/i.test(href)) t.attrSet('rel', 'noopener');
      } else if (t.type === 'link_close' && !kept.pop()) {
        continue;
      }
      out.push(t);
    }
    block.children = out;
  }
}

/** `- [ ] task` / `- [x] done`: a ballot box character, no form control. */
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
    first.content = `${m[1] === ' ' ? '☐' : '☑'} ${first.content.slice(m[0].length)}`;
    (tokens[i - 2] as Token).attrJoin('class', 'task');
  }
}

/** Heading ids; the first `#` heading is dropped when it repeats the post's title. */
function headingRule(title: string) {
  return (state: StateCore): void => {
    const seen = new Map<string, number>();
    const tokens = state.tokens;
    let first = true;
    for (let i = 0; i < tokens.length - 1; i++) {
      const t = tokens[i] as Token;
      if (t.type !== 'heading_open') continue;
      const text = md.stripInlineMarkdown((tokens[i + 1] as Token).content);
      if (first && t.tag === 'h1' && text === title) {
        tokens.splice(i, 3);
        i--;
        first = false;
        continue;
      }
      first = false;
      let id = headingId(text);
      const n = seen.get(id) ?? 0;
      seen.set(id, n + 1);
      if (n > 0) id = `${id}-${n + 1}`;
      t.attrSet('id', id);
    }
  };
}

/** Table alignment as classes, not `style` attributes (the page's CSP allows no inline style). */
function alignRule(state: StateCore): void {
  for (const t of state.tokens) {
    if (t.type !== 'th_open' && t.type !== 'td_open') continue;
    const style = String(t.attrGet('style') ?? '');
    if (!style) continue;
    const m = /text-align:(left|right|center)/.exec(style);
    t.attrs = (t.attrs ?? []).filter(([k]) => k !== 'style');
    if (m) t.attrSet('class', `align-${m[1]}`);
  }
}

function createRenderer(ctx: RenderContext): Renderer {
  const it = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });
  it.inline.ruler.before('link', 'wikilink', wikiLinkRule(ctx));
  it.core.ruler.after('inline', 'safe-links', safeLinksRule);
  it.core.ruler.after('inline', 'task-list', taskListRule);
  it.core.ruler.after('inline', 'headings', headingRule(ctx.post.title));
  it.core.ruler.after('inline', 'align', alignRule);
  const rules = it.renderer.rules;
  // Never emitted with `html: false`; escaped all the same, should that change.
  rules.html_block = (tokens, i) => `<p>${escapeHtml((tokens[i] as Token).content)}</p>\n`;
  rules.html_inline = (tokens, i) => escapeHtml((tokens[i] as Token).content);
  // Images and attachments are not served: the alt text stands in.
  rules.image = (tokens, i, options, env, self) => {
    const alt = self.renderInlineAsText((tokens[i] as Token).children ?? [], options, env);
    return alt === '' ? '' : `<span class="image-alt">${escapeHtml(alt)}</span>`;
  };
  // Code blocks and tables scroll inside their own box.
  const fence = rules.fence?.bind(rules);
  rules.fence = (tokens, i, options, env, self) =>
    `<div class="scroll code">${fence ? fence(tokens, i, options, env, self) : ''}</div>`;
  const code = rules.code_block?.bind(rules);
  rules.code_block = (tokens, i, options, env, self) =>
    `<div class="scroll code">${code ? code(tokens, i, options, env, self) : ''}</div>`;
  rules.table_open = () => '<div class="scroll"><table>\n';
  rules.table_close = () => '</table></div>\n';
  return it;
}

/** The post's body as HTML: safe to put in the page as it is. */
export function renderPost(ctx: RenderContext): string {
  return createRenderer(ctx).render(ctx.post.body);
}
