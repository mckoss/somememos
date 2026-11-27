<script lang="ts">
  // The blog post publish control (PLAN.md section 8). It only asks for
  // `published: true` to be written or removed; the note's text stays the one
  // record of whether the post is public.
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  let {
    published,
    onchange,
    compact = false,
  }: {
    published: boolean;
    onchange: (published: boolean) => void | Promise<void>;
    compact?: boolean;
  } = $props();

  let confirmOpen = $state(false);
</script>

<div class="publish" class:compact class:live={published}>
  <div class="state">
    <span class="badge {published ? 'published' : 'draft'}" data-testid="publish-badge">
      {published ? 'Published' : 'Draft'}
    </span>
    {#if !compact}
      <span class="explain">
        {#if published}
          Waiting to be published: the post goes public when this brain syncs with the server. Sync
          isn’t available yet, so for now it stays on this device.
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
    Sync isn’t available yet, so nothing leaves this device until it is. You can unpublish at any
    time.
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

  .explain {
    color: var(--text-muted);
    font-size: 0.88rem;
  }
</style>
