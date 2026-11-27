<script lang="ts">
  // The blog post publish control (PLAN.md section 8). It only asks for
  // `published: true` to be written or removed; the note's text stays the one
  // record of whether the post is public. With sync, it also says whether the
  // published version has reached the server yet (`synced`).
  import type { NoteSyncState } from '#lib/brain/host.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  let {
    published,
    onchange,
    compact = false,
    synced = 'off',
    address = null,
  }: {
    /** The post's public address (when the blog is on), shown as a link once it is public. */
    address?: string | null;
    published: boolean;
    onchange: (published: boolean) => void | Promise<void>;
    compact?: boolean;
    /** Whether this version is on the server: 'off' when this device doesn't sync. */
    synced?: NoteSyncState;
  } = $props();

  const waiting = $derived(published && synced === 'waiting');

  let confirmOpen = $state(false);
</script>

<div class="publish" class:compact class:live={published}>
  <div class="state">
    <span
      class="badge {published ? 'published' : 'draft'}"
      class:waiting
      data-testid="publish-badge"
      data-sync={synced}
    >
      {published ? (waiting ? 'Published, waiting to sync' : 'Published') : 'Draft'}
    </span>
    {#if published && synced === 'synced' && address}
      <a
        class="public-link"
        href={address}
        target="_blank"
        rel="noopener"
        data-testid="post-address"
      >
        {compact ? 'Public page' : address}
      </a>
    {/if}
    {#if !compact}
      <span class="explain">
        {#if published && synced === 'synced'}
          Public: the server has this version of the post.
        {:else if published && synced === 'waiting'}
          Waiting to be published: the post goes public when this version reaches the server, at the
          next sync.
        {:else if published}
          Published on this device. It goes public once this device syncs with a server (More →
          Sync).
        {:else}
          A draft is private. Publishing adds <code>published: true</code> to the front matter, which
          you can also type yourself.
        {/if}
      </span>
    {/if}
  </div>
  {#if published}
    <button type="button" onclick={() => onchange(false)}>Unpublish</button>
  {:else}
    <button type="button" class="primary" onclick={() => (confirmOpen = true)}>
      <Icon name="globe" size={18} /> Publish…
    </button>
  {/if}
</div>

<Dialog bind:open={confirmOpen} title="Publish this post?">
  <p>
    This makes the post public once it syncs: anyone will be able to read it on the somememos
    website. Links to your private notes are shown as plain text.
  </p>
  <p class="hint">
    {synced === 'off'
      ? 'This device doesn’t sync with a server yet, so nothing leaves it until it does.'
      : 'It goes public at the next sync.'} You can unpublish at any time.
  </p>
  {#snippet actions(close)}
    <button type="button" onclick={close}>Cancel</button>
    <button
      type="button"
      class="primary"
      onclick={() => {
        close();
        void onchange(true);
      }}
    >
      Publish
    </button>
  {/snippet}
</Dialog>

<style>
  .publish {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2) var(--space-3);
    padding: var(--space-3) var(--space-4);
    margin-bottom: var(--space-4);
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .publish.live {
    border-style: solid;
    border-color: var(--up);
  }

  .publish.compact {
    padding: 0;
    margin: 0;
    border: 0;
    background: none;
    flex-wrap: nowrap;
  }

  .state {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    flex: 1 1 14rem;
    min-inline-size: 0;
  }

  .compact .state {
    flex: none;
  }

  .badge.waiting {
    border-style: dashed;
    color: var(--down);
    border-color: var(--down);
  }

  .public-link {
    overflow-wrap: anywhere;
    font-size: 0.9rem;
  }

  .explain {
    color: var(--text-muted);
    font-size: 0.88rem;
  }
</style>
