<script lang="ts">
  import type { engine } from '@somememos/core';
  import { resolve } from '$app/paths';
  import EmptyBrain from '#lib/components/EmptyBrain.svelte';
  import { brain, host } from '#lib/ui/brain.svelte.ts';
  import { errorMessage } from '#lib/ui/errors.ts';
  import { danglingNotePath, encodeNotePath } from '#lib/ui/paths.ts';
  import { plural } from '#lib/ui/format.ts';

  type DanglingCount = Awaited<ReturnType<engine.Engine['danglingLinks']>>[number];

  const PAGE = 50;
  let shown = $state(PAGE);
  let items = $state<DanglingCount[] | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    void brain.revision;
    void (async () => {
      try {
        items = await (await host()).engine.danglingLinks();
        error = null;
      } catch (e) {
        error = errorMessage(e);
      }
    })();
  });
</script>

<svelte:head>
  <title>Not written yet · somememos</title>
</svelte:head>

<h1 class="page-title">Not written yet</h1>
<p class="page-intro">
  Links to notes that don’t exist yet, most linked first. A topic that keeps getting linked is
  probably worth a note of its own; when you write it, the links’ history carries over.
</p>

{#if brain.ready && brain.titles.length === 0}
  <EmptyBrain />
{:else if error}
  <p class="notice error" role="alert">{error}</p>
{:else if items && items.length === 0}
  <p class="card">Every link points to a note that exists.</p>
{:else if items}
  <ol class="dangling" aria-label="Links to notes not written yet">
    {#each items.slice(0, shown) as item (item.key)}
      {@const path = danglingNotePath(item.key, brain.roles)}
      <li>
        <span class="key">{item.key}</span>
        <span class="count">{plural(item.count, 'note links', 'notes link')} here</span>
        {#if path}
          <a class="button" href={resolve('/edit/[...path]', { path: encodeNotePath(path) })}>
            Write it
          </a>
        {/if}
      </li>
    {/each}
  </ol>
  {#if items.length > shown}
    <div class="more"><button type="button" onclick={() => (shown += PAGE)}>Show more</button></div>
  {/if}
{:else}
  <p class="hint" role="status">Loading…</p>
{/if}

<style>
  .dangling {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: var(--space-2);
  }

  li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    padding: var(--space-2) var(--space-3);
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .key {
    flex: 1 1 10rem;
    font-weight: 600;
    color: var(--missing);
  }

  .count {
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .more {
    display: flex;
    justify-content: center;
    margin-top: var(--space-4);
  }
</style>
