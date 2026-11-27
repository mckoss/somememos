<script lang="ts">
  import type { engine } from '@somememos/core';
  import ResultCard from './ResultCard.svelte';

  let {
    results,
    mode,
    hasMore = false,
    loading = false,
    onmore,
    label,
  }: {
    results: engine.ResultView[];
    mode: engine.RankMode;
    hasMore?: boolean;
    loading?: boolean;
    onmore?: () => void;
    label: string;
  } = $props();

  const best = $derived(
    results.reduce<number | null>((m, r) => {
      const v = r.components.relevance;
      return v !== null && (m === null || v > m) ? v : m;
    }, null),
  );
</script>

<ol class="results" aria-label={label} aria-busy={loading}>
  {#each results as result (result.item)}
    <li><ResultCard {result} {mode} bestRelevance={best} /></li>
  {/each}
</ol>
{#if hasMore}
  <div class="more">
    <button type="button" onclick={() => onmore?.()} disabled={loading}>Show more</button>
  </div>
{/if}

<style>
  .results {
    display: grid;
    gap: var(--space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .more {
    display: flex;
    justify-content: center;
    margin-top: var(--space-4);
  }
</style>
