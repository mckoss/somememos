<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { brain, changed, host } from '#lib/ui/brain.svelte.ts';
  import { errorMessage } from '#lib/ui/errors.ts';
  import {
    encodeNotePath,
    hasBlog,
    localDateString,
    memoFolder,
    newBlogPath,
    newMemoPath,
    uniquePath,
  } from '#lib/ui/paths.ts';

  type Kind = 'memo' | 'diary' | 'blog';

  let kind = $state<Kind>('memo');
  let title = $state('');
  let customPath = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);

  const canMemo = $derived(memoFolder(brain.roles) !== null);
  const canDiary = $derived((brain.roles.dated?.length ?? 0) > 0);
  const canBlog = $derived(hasBlog(brain.roles));
  const taken = $derived(new Set(brain.titles.map((t) => t.path)));

  const suggested = $derived.by(() => {
    const t = title.trim();
    if (kind === 'diary' || !t) return null;
    const p =
      kind === 'blog'
        ? newBlogPath(t, localDateString(), brain.roles)
        : newMemoPath(t, brain.roles);
    return p === null ? null : uniquePath(p, taken);
  });
  const finalPath = $derived(customPath.trim() || suggested);

  async function create(e: SubmitEvent) {
    e.preventDefault();
    error = null;
    busy = true;
    try {
      if (kind === 'diary') {
        const entry = await (await host()).engine.ensureDiary();
        if (entry.created) await changed();
        await goto(resolve('/edit/[...path]', { path: encodeNotePath(entry.path) }));
        return;
      }
      if (!title.trim()) {
        error = 'Give the note a title.';
        return;
      }
      if (!finalPath) {
        error =
          'This brain has no folder for that kind of note. Set one up in More → Folder roles.';
        return;
      }
      const path = finalPath.endsWith('.md') ? finalPath : `${finalPath}.md`;
      await goto(resolve(`edit/${encodeNotePath(path)}?title=${encodeURIComponent(title.trim())}`));
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head>
  <title>New note · somememos</title>
</svelte:head>

<h1 class="page-title">New note</h1>
<p class="page-intro">Choose what kind of note, give it a title, and start writing.</p>

<form class="new card" onsubmit={create}>
  <fieldset>
    <legend>Kind of note</legend>
    <label class="choice">
      <input type="radio" name="kind" value="memo" bind:group={kind} disabled={!canMemo} />
      <span>
        <strong>Memo</strong>
        <span class="hint">A lasting note. Shows up in Hot, Trending and Neglected.</span>
      </span>
    </label>
    <label class="choice">
      <input type="radio" name="kind" value="diary" bind:group={kind} disabled={!canDiary} />
      <span>
        <strong>Today’s diary entry</strong>
        <span class="hint">{localDateString()}: opens today’s entry, creating it if needed.</span>
      </span>
    </label>
    <label class="choice">
      <input type="radio" name="kind" value="blog" bind:group={kind} disabled={!canBlog} />
      <span>
        <strong>Blog post</strong>
        <span class="hint">
          {canBlog
            ? 'A dated post. It stays a private draft until you publish it.'
            : 'Add a blog folder in More → Folder roles to write posts.'}
        </span>
      </span>
    </label>
  </fieldset>

  {#if kind !== 'diary'}
    <div class="field">
      <label for="new-title">Title</label>
      <input id="new-title" type="text" bind:value={title} autocomplete="off" required />
    </div>
    <details>
      <summary>File name: <code>{finalPath ?? '…'}</code></summary>
      <div class="field">
        <label for="new-path">Path in the brain</label>
        <input
          id="new-path"
          type="text"
          bind:value={customPath}
          placeholder={suggested ?? ''}
          autocomplete="off"
          spellcheck="false"
        />
        <span class="hint">Leave empty to use the suggested name.</span>
      </div>
    </details>
  {/if}

  {#if error}<p class="notice error" role="alert">{error}</p>{/if}

  <div class="row">
    <button type="submit" class="primary" disabled={busy}>
      {kind === 'diary' ? 'Open today’s entry' : 'Start writing'}
    </button>
  </div>
</form>

<style>
  .new {
    display: grid;
    gap: var(--space-4);
    max-inline-size: 40rem;
  }

  fieldset {
    margin: 0;
    padding: 0;
    border: 0;
    display: grid;
    gap: var(--space-2);
  }

  legend {
    font-weight: 600;
    margin-bottom: var(--space-2);
  }

  .choice {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-weight: 400;
    cursor: pointer;
    min-block-size: var(--target);
  }

  .choice:has(input:checked) {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .choice:has(input:disabled) {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .choice input {
    margin-top: 0.25rem;
    inline-size: 1.1rem;
    block-size: 1.1rem;
    flex: none;
  }

  .choice .hint {
    display: block;
  }

  details summary {
    cursor: pointer;
    color: var(--text-muted);
    font-size: 0.9rem;
    min-block-size: var(--target);
    display: flex;
    align-items: center;
    gap: 0.4em;
    flex-wrap: wrap;
  }

  details .field {
    margin-top: var(--space-2);
  }
</style>
