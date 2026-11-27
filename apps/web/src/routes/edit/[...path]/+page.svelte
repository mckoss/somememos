<script lang="ts">
  import { untrack } from 'svelte';
  import { beforeNavigate, goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import Dialog from '#lib/components/Dialog.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import MarkdownEditor from '#lib/components/MarkdownEditor.svelte';
  import MarkdownView from '#lib/components/MarkdownView.svelte';
  import PublishControl from '#lib/components/PublishControl.svelte';
  import type { NoteSyncState } from '#lib/brain/host.ts';
  import { brain, changed, host, skipNextRead } from '#lib/ui/brain.svelte.ts';
  import { syncState } from '#lib/ui/sync.svelte.ts';
  import { errorCode, errorMessage } from '#lib/ui/errors.ts';
  import { relativeTime } from '#lib/ui/format.ts';
  import { isPublished, setPublished } from '#lib/ui/frontmatter.ts';
  import {
    asidePath,
    encodeNotePath,
    initialNoteText,
    isBlogPath,
    titleFromPath,
  } from '#lib/ui/paths.ts';
  import { clearDraft, loadDraft, saveDraft, writeStorage } from '#lib/ui/storage.ts';

  const path = $derived(page.params.path ?? '');

  /** What is loaded: the stored text the edit is based on, and its hash. */
  let base = $state<{
    path: string;
    text: string;
    hash: string | null;
    role: string | null;
  } | null>(null);
  let loadError = $state<string | null>(null);
  /** The text in the editor, exactly. */
  let text = $state('');
  let startText = $state('');
  /** For a new note: the text it starts with (its title heading). */
  let template = $state('');
  let message = $state('');
  let restoredAt = $state<number | null>(null);
  let pane = $state<'edit' | 'preview'>('edit');
  let saving = $state(false);
  let status = $state<{ kind: 'info' | 'error'; text: string } | null>(null);
  let editorKey = $state(0);
  let editor = $state<ReturnType<typeof MarkdownEditor>>();

  const isNew = $derived(base !== null && base.hash === null);
  /** True when there is typing that isn't saved. A new note's title heading alone doesn't count. */
  const dirty = $derived(base !== null && text !== (base.hash === null ? template : base.text));
  const isBlog = $derived(
    (base?.role ?? null) === 'blog' || (base !== null && isBlogPath(base.path, brain.roles)),
  );
  const published = $derived(isPublished(text));

  // Whether the saved version is on the server (a blog post's badge says so).
  let savedSynced = $state<NoteSyncState>('off');
  $effect(() => {
    const b = base;
    void syncState.revision;
    if (!b || b.hash === null || !isBlog) return;
    const { path: p, hash } = b;
    void (async () => {
      try {
        savedSynced = await (await host()).sync.noteState(p, hash);
      } catch {
        savedSynced = 'off';
      }
    })();
  });
  const noteSynced = $derived<NoteSyncState>(
    !syncState.view?.connected ? 'off' : dirty || isNew ? 'waiting' : savedSynced,
  );

  // Load the note (without logging a read: opening the editor is not reading).
  let request = 0;
  $effect(() => {
    const p = path;
    const id = ++request;
    untrack(() => {
      base = null;
      loadError = null;
      status = null;
      restoredAt = null;
    });
    void (async () => {
      const h = await host();
      let stored: { text: string; hash: string | null; role: string | null };
      try {
        const view = await h.engine.readNote(p, { record: false });
        stored = { text: view.text, hash: view.hash, role: view.role };
      } catch (e) {
        if (errorCode(e) !== 'not-found') {
          if (id === request) loadError = errorMessage(e);
          return;
        }
        const title = page.url.searchParams.get('title') ?? titleFromPath(p);
        stored = { text: '', hash: null, role: null };
        template = initialNoteText(title);
      }
      if (id !== request) return;
      const draft = loadDraft(p);
      if (stored.hash !== null) template = '';
      let initial = stored.hash === null ? template : stored.text;
      let hash = stored.hash;
      let baseText = stored.text;
      if (draft && draft.text !== stored.text && draft.text !== template) {
        // Unsaved changes from before a reload. They keep the hash they were
        // based on, so a save conflicts if the note changed in the meantime.
        initial = draft.text;
        message = draft.message;
        restoredAt = draft.savedAt;
        if (draft.baseHash !== stored.hash) {
          hash = draft.baseHash;
          baseText = stored.text;
        }
      } else {
        message = '';
      }
      base = { path: p, text: baseText, hash, role: stored.role };
      text = initial;
      startText = initial;
      editorKey += 1;
    })();
  });

  // Keep unsaved text on the device, so a reload or a crash doesn't lose it.
  $effect(() => {
    const b = base;
    const t = text;
    const m = message;
    const unsaved = dirty;
    if (!b) return;
    const timer = setTimeout(() => {
      if (unsaved)
        saveDraft(b.path, { text: t, baseHash: b.hash, message: m, savedAt: Date.now() });
      else clearDraft(b.path);
    }, 300);
    return () => clearTimeout(timer);
  });

  // The live preview follows typing, slightly behind.
  let previewText = $state('');
  $effect(() => {
    const t = text;
    const timer = setTimeout(() => (previewText = t), 120);
    return () => clearTimeout(timer);
  });

  beforeNavigate((nav) => {
    if (!dirty || saving) return;
    if (nav.type === 'leave') {
      nav.cancel();
      return;
    }
    if (!confirm('Leave without saving? Your changes stay on this device as a draft.'))
      nav.cancel();
  });

  // Saving -------------------------------------------------------------------

  let conflict = $state<{ currentText: string | null; currentHash: string | null } | null>(null);
  let conflictOpen = $state(false);

  async function save(): Promise<void> {
    if (!base || saving) return;
    saving = true;
    status = null;
    const b = base;
    const t = text;
    try {
      const h = await host();
      const r = await h.engine.saveNote(b.path, t, {
        baseHash: b.hash,
        message: message.trim() || null,
      });
      if (r.status === 'conflict') {
        conflict = { currentText: r.currentText, currentHash: r.currentHash };
        conflictOpen = true;
        return;
      }
      if (r.status === 'unchanged') {
        base = { ...b, text: t, hash: r.hash };
        status = { kind: 'info', text: 'Nothing to save: the note already says this.' };
      } else {
        base = { ...b, text: t, hash: r.hash, role: b.role ?? (await roleOf(b.path)) };
        status = { kind: 'info', text: r.created ? 'Created.' : 'Saved.' };
        message = '';
        await changed();
      }
      clearDraft(b.path);
      restoredAt = null;
    } catch (e) {
      status = { kind: 'error', text: errorMessage(e) };
    } finally {
      saving = false;
    }
  }

  async function roleOf(p: string): Promise<string | null> {
    try {
      return (await (await host()).engine.readNote(p, { record: false })).role;
    } catch {
      return null;
    }
  }

  async function keepMine(close: () => void): Promise<void> {
    if (!base || !conflict) return;
    base = { ...base, hash: conflict.currentHash, text: conflict.currentText ?? '' };
    close();
    await save();
  }

  function takeStored(close: () => void): void {
    if (!base || !conflict) return;
    // Set the typed text aside first; it can also be brought back with Undo.
    writeStorage(
      'local',
      `somememos:aside:${base.path}`,
      JSON.stringify({ text, savedAt: Date.now() }),
    );
    const stored = conflict.currentText ?? '';
    base = { ...base, hash: conflict.currentHash, text: stored };
    editor?.setText(stored);
    text = stored;
    close();
    status = {
      kind: 'info',
      text: 'Now showing the saved version. Your text was set aside on this device; Undo brings it back.',
    };
  }

  let asideLink = $state<string | null>(null);

  async function saveMineAside(close: () => void): Promise<void> {
    if (!base || !conflict) return;
    const target = asidePath(base.path);
    try {
      const h = await host();
      const r = await h.engine.saveNote(target, text, {
        baseHash: null,
        message: message.trim() || 'Copy set aside after a conflict',
      });
      if (r.status === 'conflict') throw new Error('a note with that name already exists');
      await changed();
      asideLink = target;
      takeStored(close);
      status = { kind: 'info', text: 'Your version was saved as a separate note.' };
    } catch (e) {
      status = { kind: 'error', text: errorMessage(e) };
      close();
    }
  }

  async function copyMine(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      status = { kind: 'info', text: 'Your version is on the clipboard.' };
    } catch {
      status = { kind: 'error', text: 'The clipboard isn’t available here.' };
    }
  }

  function discardDraft(): void {
    if (!base) return;
    clearDraft(base.path);
    const original = base.hash === null ? template : base.text;
    editor?.setText(original);
    text = original;
    restoredAt = null;
  }

  async function done(): Promise<void> {
    if (!base) return;
    if (isNew) {
      history.back();
      return;
    }
    // Coming back from editing is not a new read.
    const p = base.path;
    skipNextRead.add(p);
    await goto(resolve('/note/[...path]', { path: encodeNotePath(p) }));
    if (page.route.id?.startsWith('/edit/')) skipNextRead.delete(p);
  }

  function togglePublish(value: boolean): void {
    const next = setPublished(text, value);
    if (next === text) return;
    editor?.setText(next);
    text = next;
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.defaultPrevented) return;
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
    }
  }

  const saveLabel = $derived(saving ? 'Saving…' : isNew ? 'Create' : 'Save');
  const stateText = $derived(
    saving
      ? 'Saving…'
      : dirty
        ? 'Unsaved changes'
        : isNew
          ? 'New note, not saved yet'
          : 'All changes saved',
  );
</script>

<svelte:window onkeydown={onKeydown} />

<svelte:head>
  <title>{dirty ? '• ' : ''}Edit {path} · somememos</title>
</svelte:head>

{#if loadError}
  <p class="notice error" role="alert">{loadError}</p>
{:else if !base}
  <p class="hint" role="status">Opening…</p>
{:else}
  <div class="edit-page" class:show-preview={pane === 'preview'}>
    <header class="edit-head">
      <div class="where">
        <h1 class="path-title" title={base.path}>
          {isNew ? 'New note' : 'Editing'} <span>{base.path}</span>
        </h1>
        <span class="state" class:dirty role="status">{stateText}</span>
      </div>
      <div class="tools" role="toolbar" aria-label="Editor">
        <button
          type="button"
          class="ghost icon"
          onclick={done}
          aria-label="Done"
          title="Done: back to the note"
        >
          <Icon name="back" />
        </button>
        <span class="grow"></span>
        <button
          type="button"
          class="ghost icon"
          onclick={() => editor?.runUndo()}
          aria-label="Undo"
          title="Undo (Ctrl+Z)"
        >
          <Icon name="undo" />
        </button>
        <button
          type="button"
          class="ghost icon"
          onclick={() => editor?.runRedo()}
          aria-label="Redo"
          title="Redo (Ctrl+Shift+Z)"
        >
          <Icon name="redo" />
        </button>
        <button
          type="button"
          class="pane-toggle"
          aria-pressed={pane === 'preview'}
          onclick={() => (pane = pane === 'edit' ? 'preview' : 'edit')}
        >
          {#if pane === 'edit'}<Icon name="eye" size={18} /> Preview{:else}<Icon
              name="edit"
              size={18}
            /> Edit{/if}
        </button>
        <button
          type="button"
          class="primary"
          onclick={save}
          disabled={saving || (!dirty && !isNew)}
        >
          {saveLabel}
        </button>
      </div>
      <div class="message-row">
        <label for="change-message" class="visually-hidden">What changed (optional)</label>
        <input
          id="change-message"
          type="text"
          placeholder="What changed? (optional, for the history)"
          bind:value={message}
          enterkeyhint="done"
          onkeydown={(e) => {
            if (e.key === 'Enter' && !e.isComposing) {
              e.preventDefault();
              void save();
            }
          }}
        />
        {#if isBlog}
          <PublishControl {published} onchange={togglePublish} compact synced={noteSynced} />
        {/if}
      </div>
      {#if restoredAt}
        <p class="notice restored" role="status">
          Restored your unsaved changes from {relativeTime(restoredAt / 1000)}.
          <button type="button" class="ghost" onclick={discardDraft}>Discard them</button>
        </p>
      {/if}
      {#if status}
        <p
          class="notice {status.kind === 'error' ? 'error' : 'ok'}"
          role={status.kind === 'error' ? 'alert' : 'status'}
        >
          {status.text}
          {#if asideLink && status.kind === 'info'}
            <a href={resolve('/note/[...path]', { path: encodeNotePath(asideLink) })}>
              Open your copy
            </a>
          {/if}
        </p>
      {/if}
    </header>

    <div class="panes">
      <section class="pane source" aria-label="Markdown source">
        {#key editorKey}
          <MarkdownEditor
            bind:this={editor}
            text={startText}
            titles={() => brain.titles}
            onchange={(t) => (text = t)}
            onsave={save}
          />
        {/key}
      </section>
      <section class="pane preview" aria-label="Preview">
        <h2 class="visually-hidden">Preview</h2>
        <div class="preview-body" data-testid="preview">
          {#if previewText.trim() === ''}
            <p class="hint">The preview shows here as you type.</p>
          {:else}
            <MarkdownView text={previewText} path={base.path} />
          {/if}
        </div>
      </section>
    </div>
  </div>
{/if}

<Dialog bind:open={conflictOpen} title="This note changed while you were editing" wide>
  <p>
    Someone (or another tab) saved a different version since you opened it. Nothing has been lost:
    choose what to keep.
  </p>
  <div class="versions">
    <section>
      <h3>Your version</h3>
      <pre data-testid="conflict-mine">{text}</pre>
    </section>
    <section>
      <h3>Saved version</h3>
      <pre data-testid="conflict-stored">{conflict?.currentText ?? '(The note was deleted.)'}</pre>
    </section>
  </div>
  {#snippet actions(close)}
    <button type="button" onclick={copyMine}>Copy mine</button>
    <button type="button" onclick={() => saveMineAside(close)}>Save mine as a separate note</button>
    <button type="button" onclick={() => takeStored(close)}>Use the saved version</button>
    <button type="button" class="primary" onclick={() => keepMine(close)}>Keep mine</button>
  {/snippet}
</Dialog>

<style>
  .edit-page {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    /* Fill the visible height (above an on-screen keyboard), under the top bar. */
    block-size: calc(var(--app-height) - var(--topbar-h) - 2 * var(--space-4));
    min-block-size: 18rem;
  }

  .edit-head {
    display: grid;
    gap: var(--space-2);
  }

  .where {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0 var(--space-3);
    min-inline-size: 0;
  }

  .path-title {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }

  .path-title span {
    font-family: var(--font-mono);
    font-size: 0.82rem;
    font-weight: 400;
    color: var(--text-muted);
  }

  .state {
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  .state.dirty {
    color: var(--down);
    font-weight: 600;
  }

  .tools {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .grow {
    flex: 1;
  }

  .message-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
  }

  /* On a phone the publish control wraps under the message box rather than
     squeezing it to a few letters. */
  .message-row input {
    flex: 1 1 16rem;
    min-inline-size: 0;
  }

  .notice {
    margin: 0;
    font-size: 0.88rem;
    padding: var(--space-2) var(--space-3);
  }

  .notice.ok {
    background: var(--accent-soft);
    color: var(--text);
  }

  .restored button {
    min-block-size: auto;
    padding: 0 0.3rem;
    text-decoration: underline;
    color: inherit;
  }

  .panes {
    flex: 1;
    min-block-size: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }

  .pane {
    min-block-size: 0;
    min-inline-size: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    overflow: hidden;
  }

  .preview-body {
    block-size: 100%;
    overflow: auto;
    padding: var(--space-3) var(--space-4);
  }

  /* Phone: one pane at a time. */
  .preview {
    display: none;
  }

  .show-preview .source {
    display: none;
  }

  .show-preview .preview {
    display: block;
  }

  /* While the keyboard is up and the person is typing, give the text the room. */
  :global(html[data-keyboard]) .edit-page:has(:global(.cm-focused)) .message-row,
  :global(html[data-keyboard]) .edit-page:has(:global(.cm-focused)) .notice {
    display: none;
  }

  /* Desktop: source and preview side by side. */
  @media (min-width: 60rem) {
    .edit-page {
      block-size: calc(var(--app-height) - var(--topbar-h) - 2 * var(--space-5));
    }

    .panes {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: var(--space-3);
    }

    .preview,
    .show-preview .preview,
    .show-preview .source {
      display: block;
    }

    .pane-toggle {
      display: none;
    }
  }

  .versions {
    display: grid;
    gap: var(--space-3);
  }

  @media (min-width: 45rem) {
    .versions {
      grid-template-columns: 1fr 1fr;
    }
  }

  .versions h3 {
    margin: 0 0 var(--space-1);
    font-size: 0.95rem;
  }

  .versions pre {
    margin: 0;
    /* Short on a phone, where the two versions stack, so the choices below
       stay in view without scrolling the dialog. */
    max-block-size: 20vh;
    overflow: auto;
    padding: var(--space-2) var(--space-3);
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    white-space: pre-wrap;
    font-size: 0.82rem;
  }

  @media (min-width: 45rem) {
    .versions pre {
      max-block-size: 40vh;
    }
  }
</style>
