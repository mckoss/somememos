<script lang="ts">
  import type { engine } from '@somememos/core';
  import { resolve } from '$app/paths';
  import ResultList from './ResultList.svelte';
  import EmptyBrain from './EmptyBrain.svelte';
  import { brain, host } from '#lib/ui/brain.svelte.ts';
  import { errorMessage } from '#lib/ui/errors.ts';
  import { MODE_DESCRIPTIONS, MODE_LABELS } from '#lib/ui/format.ts';

  let { mode, explain }: { mode: 'hot' | 'trending' | 'neglected'; explain: string } = $props();

  const PAGE = 30;
  let limit = $state(PAGE);
  let response = $state<engine.SearchResponse | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  let request = 0;
  $effect(() => {
    const m = mode;
    const l = limit;
    void brain.revision;
    const id = ++request;
    loading = true;
    void (async () => {
      try {
        const r = await (await host()).engine.list(m, { limit: l });
        if (id !== request) return;
        response = r;
        error = null;
      } catch (e) {
        if (id === request) error = errorMessage(e);
      } finally {
        if (id === request) loading = false;
      }
    })();
  });

  const results = $derived(response?.results ?? []);
</script>

<svelte:head>
  <title>{MODE_LABELS[mode]} · somememos</title>
</svelte:head>

<h1 class="page-title">{MODE_LABELS[mode]}</h1>
<p class="page-intro">{MODE_DESCRIPTIONS[mode]} {explain}</p>

{#if brain.ready && brain.titles.length === 0}
  <EmptyBrain />
{:else if error}
  <p class="notice error" role="alert">{error}</p>
{:else if response && results.length === 0}
  <div class="card">
    <p><strong>Nothing here yet.</strong></p>
    <p class="hint">
      This list fills up as you read, edit and link notes. Notes you only imported have no activity
      until you use them. <a href={resolve('/')}>Search</a> for something to get started.
    </p>
  </div>
{:else if response}
  <ResultList
    {results}
    {mode}
    label={MODE_LABELS[mode]}
    {loading}
    hasMore={results.length >= limit}
    onmore={() => (limit += PAGE)}
  />
{:else}
  <p class="hint" role="status">Loading…</p>
{/if}
