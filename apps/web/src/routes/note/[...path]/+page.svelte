<script lang="ts">
  import type { engine } from '@somememos/core';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import Dialog from '#lib/components/Dialog.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import MarkdownView from '#lib/components/MarkdownView.svelte';
  import PublishControl from '#lib/components/PublishControl.svelte';
  import { brain, changed, host, skipNextRead } from '#lib/ui/brain.svelte.ts';
  import { errorCode, errorMessage } from '#lib/ui/errors.ts';
  import { relativeTime } from '#lib/ui/format.ts';
  import { isPublished, setPublished } from '#lib/ui/frontmatter.ts';
  import { encodeNotePath } from '#lib/ui/paths.ts';

  type ChangeRecord = Awaited<ReturnType<engine.Engine['log']>>[number];

  const path = $derived(page.params.path ?? '');

  let note = $state<engine.NoteView | null>(null);
  let history = $state<ChangeRecord[]>([]);
  let error = $state<string | null>(null);
  let missing = $state(false);
  let actionError = $state<string | null>(null);

  let loadedPath: string | null = null;
  let request = 0;

  $effect(() => {
    const p = path;
    void brain.revision;
    // Opening a note logs a read; refreshing it in the background must not.
    const fresh = p !== loadedPath;
    const record = fresh && !skipNextRead.has(p);
    skipNextRead.delete(p);
    loadedPath = p;
    const id = ++request;
    if (fresh) {
      note = null;
      missing = false;
      error = null;
      actionError = null;
    }
    void (async () => {
      try {
        const h = await host();
        const view = await h.engine.readNote(p, { record });
        const log = await h.engine.log({ path: p, all: true, limit: 50 });
        if (id !== request) return;
        note = view;
        history = log;
        error = null;
      } catch (e) {
        if (id !== request) return;
        if (errorCode(e) === 'not-found') missing = true;
        else error = errorMessage(e);
      }
    })();
  });

  const titleOf = (p: string) => brain.titles.find((t) => t.path === p)?.title ?? p;
  const isBlog = $derived((note?.role as string | undefined) === 'blog');
  const published = $derived(note ? isPublished(note.text) : false);

  // Rename
  let renameOpen = $state(false);
  let renameTo = $state('');
  let renameMessage = $state('');
  let renameError = $state<string | null>(null);
  let busy = $state(false);

  function openRename() {
    renameTo = path;
    renameMessage = '';
    renameError = null;
    renameOpen = true;
  }

  async function doRename(close: () => void) {
    const to = renameTo.trim();
    if (!to || to === path) return close();
    busy = true;
    try {
      const h = await host();
      const r = await h.engine.renameNote(path, to, { message: renameMessage.trim() || null });
      skipNextRead.add(r.to);
      close();
      await changed();
      await goto(resolve('/note/[...path]', { path: encodeNotePath(r.to) }), {
        replaceState: true,
      });
    } catch (e) {
      renameError = errorMessage(e);
    } finally {
      busy = false;
    }
  }

  // Delete
  let deleteOpen = $state(false);

  async function doDelete(close: () => void) {
    busy = true;
    try {
      const h = await host();
      await h.engine.deleteNote(path, { message: null });
      close();
      await changed();
      await goto(resolve('/'), { replaceState: true });
    } catch (e) {
      actionError = errorMessage(e);
      close();
    } finally {
      busy = false;
    }
  }

  // Publish (blog posts): writes or removes `published: true` and saves.
  async function setPublishedAndSave(value: boolean) {
    if (!note) return;
    actionError = null;
    try {
      const h = await host();
      const next = setPublished(note.text, value);
      const r = await h.engine.saveNote(note.path, next, {
        baseHash: note.hash,
        message: value ? 'Publish post' : 'Unpublish post',
      });
      if (r.status === 'conflict') {
        actionError = 'This post changed since it was opened. Reload it and try again.';
        return;
      }
      await changed();
    } catch (e) {
      actionError = errorMessage(e);
    }
  }
</script>

<svelte:head>
  <title>{note?.title ?? 'Note'} · somememos</title>
</svelte:head>

{#if missing}
  <h1 class="page-title">No note here yet</h1>
  <p class="page-intro"><code>{path}</code> doesn’t exist. It may have been renamed or deleted.</p>
  <a class="button primary" href={resolve('/edit/[...path]', { path: encodeNotePath(path) })}>
    Write it
  </a>
{:else if error}
  <p class="notice error" role="alert">{error}</p>
{:else if note}
  <article class="note">
    <header class="note-head">
      <div class="titles">
        <h1 class="page-title">{note.title}</h1>
        <p class="meta">
          <span class="path">{note.path}</span>
          <span class="badge">{note.role}</span>
          {#if note.date}<span>{note.date}</span>{/if}
        </p>
      </div>
      <div class="actions">
        <a
          class="button primary"
          href={resolve('/edit/[...path]', { path: encodeNotePath(note.path) })}
        >
          <Icon name="edit" size={18} /> Edit
        </a>
        <button type="button" onclick={openRename}><Icon name="rename" size={18} /> Rename</button>
        <button type="button" class="danger" onclick={() => (deleteOpen = true)}>
          <Icon name="trash" size={18} /> Delete
        </button>
      </div>
    </header>

    {#if actionError}<p class="notice error" role="alert">{actionError}</p>{/if}

    {#if isBlog}
      <PublishControl {published} onchange={setPublishedAndSave} />
    {/if}

    <div class="layout">
      <div class="body card">
        {#if note.text.trim() === ''}
          <p class="hint">This note is empty.</p>
        {:else}
          <MarkdownView text={note.text} path={note.path} />
        {/if}
      </div>

      <aside class="side">
        <section>
          <h2>Linked from</h2>
          {#if note.backlinks.length}
            <ul class="links">
              {#each note.backlinks as b (b)}
                <li>
                  <a href={resolve('/note/[...path]', { path: encodeNotePath(b) })}>{titleOf(b)}</a>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="hint">No other note links here yet.</p>
          {/if}
        </section>

        <section>
          <h2>History</h2>
          {#if history.length}
            <ol class="history">
              {#each history as c (c.id)}
                <li>
                  <span class="when" title={new Date(c.time * 1000).toLocaleString()}>
                    {relativeTime(c.time)}
                  </span>
                  {#if c.op}<span class="badge">{c.op}</span>{/if}
                  <span class="msg" class:none={!c.message}>
                    {c.message ?? 'Saved without a note of what changed'}
                  </span>
                </li>
              {/each}
            </ol>
          {:else}
            <p class="hint">No changes recorded since this note came in.</p>
          {/if}
        </section>
      </aside>
    </div>
  </article>
{:else}
  <p class="hint" role="status">Opening…</p>
{/if}

<Dialog bind:open={renameOpen} title="Rename or move this note">
  <form id="rename-form" onsubmit={(e) => e.preventDefault()}>
    <div class="field">
      <label for="rename-to">New path</label>
      <input
        id="rename-to"
        type="text"
        bind:value={renameTo}
        autocomplete="off"
        spellcheck="false"
      />
      <span class="hint">Folders and a file name ending in .md. Links to it keep its history.</span>
    </div>
    <div class="field">
      <label for="rename-msg">What changed <span class="hint">(optional)</span></label>
      <input id="rename-msg" type="text" bind:value={renameMessage} />
    </div>
    {#if renameError}<p class="notice error" role="alert">{renameError}</p>{/if}
  </form>
  {#snippet actions(close)}
    <button type="button" onclick={close}>Cancel</button>
    <button
      type="submit"
      form="rename-form"
      class="primary"
      disabled={busy}
      onclick={() => doRename(close)}
    >
      Rename
    </button>
  {/snippet}
</Dialog>

<Dialog bind:open={deleteOpen} title="Delete this note?">
  <p>
    <strong>{note?.title}</strong> will be removed from this device. Its history stays in the change log.
    This can’t be undone here.
  </p>
  {#snippet actions(close)}
    <button type="button" onclick={close}>Cancel</button>
    <button type="button" class="danger solid" disabled={busy} onclick={() => doDelete(close)}>
      Delete note
    </button>
  {/snippet}
</Dialog>

<style>
  .note-head {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }

  .titles {
    min-inline-size: 0;
    flex: 1 1 16rem;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
    margin: 0;
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .path {
    font-family: var(--font-mono);
    font-size: 0.8rem;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .layout {
    display: grid;
    gap: var(--space-4);
  }

  @media (min-width: 75rem) {
    .layout {
      grid-template-columns: minmax(0, 1fr) 17rem;
      align-items: start;
    }
  }

  .body {
    min-inline-size: 0;
    padding: var(--space-4) var(--space-5);
  }

  @media (max-width: 30rem) {
    .body {
      padding: var(--space-3);
    }
  }

  .side section + section {
    margin-top: var(--space-4);
  }

  .side h2 {
    margin: 0 0 var(--space-2);
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }

  .links,
  .history {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: var(--space-1);
  }

  .links a {
    display: inline-flex;
    align-items: center;
    min-block-size: var(--target);
  }

  .history li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.2rem 0.5rem;
    font-size: 0.88rem;
    padding: var(--space-1) 0;
    border-bottom: 1px solid var(--border);
  }

  .when {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .msg {
    flex-basis: 100%;
  }

  .msg.none {
    color: var(--text-muted);
    font-style: italic;
  }

  form {
    display: grid;
    gap: var(--space-3);
  }
</style>
