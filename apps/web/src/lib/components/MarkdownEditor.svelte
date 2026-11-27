<script lang="ts">
  // A markdown *source* editor on CodeMirror 6. It highlights markdown but
  // never rewrites it: the text that comes out is exactly what was typed,
  // line endings included (see editor-text.ts).
  import { onMount } from 'svelte';
  import { EditorView, keymap, highlightSpecialChars } from '@codemirror/view';
  import { EditorState, type Extension } from '@codemirror/state';
  import { defaultKeymap, history, historyKeymap, redo, undo } from '@codemirror/commands';
  import { markdown } from '@codemirror/lang-markdown';
  import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
  import {
    autocompletion,
    completionKeymap,
    type Completion,
    type CompletionContext,
    type CompletionResult,
  } from '@codemirror/autocomplete';
  import { tags } from '@lezer/highlight';
  import type { engine } from '@somememos/core';
  import { lineSeparatorExtension, lineSeparatorFor, stateText } from '#lib/ui/editor-text.ts';
  import { linkCompletions, openLinkBefore } from '#lib/ui/links.ts';

  let {
    text,
    titles,
    onchange,
    onsave,
    label = 'Note text',
  }: {
    /** The text to start with. Later changes come from typing or `setText`. */
    text: string;
    /** Notes for `[[` completion; read when completing, so it may change. */
    titles: () => readonly engine.NoteTitle[];
    onchange: (text: string) => void;
    onsave?: () => void;
    label?: string;
  } = $props();

  let host = $state<HTMLDivElement>();
  let view: EditorView | undefined;

  const highlight = HighlightStyle.define([
    { tag: tags.heading, fontWeight: '700', color: 'var(--accent-strong)' },
    { tag: tags.heading1, fontSize: '1.2em' },
    { tag: tags.heading2, fontSize: '1.1em' },
    { tag: tags.strong, fontWeight: '700' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
    { tag: tags.link, color: 'var(--accent)' },
    { tag: tags.url, color: 'var(--accent)', textDecoration: 'underline' },
    { tag: tags.monospace, fontFamily: 'var(--font-mono)', color: 'var(--hot)' },
    { tag: tags.quote, color: 'var(--text-muted)', fontStyle: 'italic' },
    {
      tag: [tags.processingInstruction, tags.meta, tags.contentSeparator],
      color: 'var(--text-muted)',
    },
    { tag: tags.list, color: 'var(--kind-mention)' },
  ]);

  const theme = EditorView.theme({
    '&': {
      height: '100%',
      backgroundColor: 'var(--surface)',
      color: 'var(--text)',
      fontSize: '1rem',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.6',
      overflow: 'auto',
    },
    '.cm-content': {
      padding: 'var(--space-3) var(--space-4) 40vh',
      caretColor: 'var(--accent)',
    },
    '.cm-line': { padding: '0' },
    '.cm-tooltip': {
      border: '1px solid var(--border-strong)',
      backgroundColor: 'var(--surface)',
      color: 'var(--text)',
      borderRadius: 'var(--radius-sm)',
      boxShadow: 'var(--shadow)',
    },
    '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-sans)', maxHeight: '16em' },
    '.cm-tooltip-autocomplete > ul > li': {
      padding: '0.45em 0.7em !important',
      minHeight: 'var(--target)',
      display: 'flex',
      alignItems: 'center',
      gap: '0.6em',
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'var(--accent)',
      color: 'var(--on-accent)',
    },
    '.cm-completionDetail': { fontStyle: 'normal', opacity: '0.75', fontSize: '0.85em' },
    '.cm-specialChar': { color: 'var(--danger)' },
  });

  function linkSource(ctx: CompletionContext): CompletionResult | null {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const open = openLinkBefore(line.text.slice(0, ctx.pos - line.from));
    if (!open) return null;
    const from = line.from + open.from;
    const options: Completion[] = linkCompletions(open.typed, titles()).map((c) => ({
      label: c.label,
      detail: c.detail,
      type: 'text',
      apply: (v, _completion, start, end) => {
        const closed = v.state.sliceDoc(end, end + 2) === ']]';
        const insert = closed ? c.insert : `${c.insert}]]`;
        v.dispatch({
          changes: { from: start, to: end, insert },
          selection: { anchor: start + insert.length + (closed ? 2 : 0) },
          userEvent: 'input.complete',
        });
      },
    }));
    return { from, options, filter: false };
  }

  function extensions(initial: string): Extension[] {
    return [
      lineSeparatorExtension(initial),
      history(),
      highlightSpecialChars(),
      // No markdown keymap: it would insert list markers the person didn't type.
      markdown({ addKeymap: false }),
      syntaxHighlighting(highlight),
      EditorView.lineWrapping,
      autocompletion({ override: [linkSource], icons: false }),
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onsave?.();
            return true;
          },
        },
        ...completionKeymap,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.contentAttributes.of({
        'aria-label': label,
        'aria-multiline': 'true',
        spellcheck: 'true',
        autocorrect: 'on',
        autocapitalize: 'sentences',
      }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onchange(stateText(u.state));
      }),
      theme,
    ];
  }

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: text, extensions: extensions(text) }),
    });
    return () => view?.destroy();
  });

  /** Replaces the whole text (undoable). */
  export function setText(next: string): void {
    if (!view) return;
    if (lineSeparatorFor(next) !== view.state.lineBreak) {
      // Different line endings need a different separator to stay exact.
      view.setState(EditorState.create({ doc: next, extensions: extensions(next) }));
      onchange(stateText(view.state));
      return;
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
      userEvent: 'input.replace',
    });
  }

  /** The text exactly as it is now. */
  export function getText(): string {
    return view ? stateText(view.state) : text;
  }

  export function focus(): void {
    view?.focus();
  }

  export function runUndo(): void {
    if (view) undo(view);
  }

  export function runRedo(): void {
    if (view) redo(view);
  }
</script>

<div class="editor" bind:this={host} data-testid="editor"></div>

<style>
  .editor {
    block-size: 100%;
    min-block-size: 0;
    overflow: hidden;
  }

  .editor :global(.cm-editor) {
    block-size: 100%;
  }
</style>
