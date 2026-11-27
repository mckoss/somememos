<script lang="ts">
  import type { engine } from '@somememos/core';
  import { untrack } from 'svelte';
  import { replaceState } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import ResultList from '#lib/components/ResultList.svelte';
  import EmptyBrain from '#lib/components/EmptyBrain.svelte';
  import { brain, host } from '#lib/ui/brain.svelte.ts';
  import { errorMessage } from '#lib/ui/errors.ts';
  import { MODE_DESCRIPTIONS, MODE_LABELS, plural } from '#lib/ui/format.ts';

  const MODES: engine.RankMode[] = ['hot', 'trending', 'neglected', 'all'];
  const PAGE = 20;

  const params = page.url.searchParams;
  const initialMode = params.get('mode');
  let query = $state(params.get('q') ?? '');
  let mode = $state<engine.RankMode>(
    MODES.includes(initialMode as engine.RankMode) ? (initialMode as engine.RankMode) : 'hot',
  );
  let since = $state(params.get('since') ?? '');
  let until = $state(params.get('until') ?? '');
  let limit = $state(PAGE);

  let response = $state<engine.SearchResponse | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  /** The query the shown results are for (debounced). */
  let settled = $state(params.get('q') ?? '');

  // Debounce typing; mode and dates apply at once.
  $effect(() => {
    const q = query;
    const t = setTimeout(() => {
      if (untrack(() => settled) !== q) {
        settled = q;
        limit = PAGE;
      }
    }, 180);
    return () => clearTimeout(t);
  });

  let request = 0;
  $effect(() => {
    const q = settled.trim();
    const opts: engine.SearchOptions = {
      mode,
      limit,
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
    };
    void brain.revision;
    const id = ++request;
    loading = true;
    void (async () => {
      try {
        const h = await host();
        const r = await h.engine.search(q, opts);
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

  // Keep the URL in step, so reload and back/forward restore the search.
  $effect(() => {
    const parts: [string, string][] = [];
    if (settled) parts.push(['q', settled]);
    if (mode !== 'hot') parts.push(['mode', mode]);
    if (since) parts.push(['since', since]);
    if (until) parts.push(['until', until]);
    const s = parts.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    if (s === untrack(() => page.url.search.slice(1))) return;
    try {
      replaceState(s ? resolve(`/?${s}`) : resolve('/'), {});
    } catch {
      // The router isn't ready on the very first render; the next change will sync.
    }
  });

  const results = $derived(response?.results ?? []);
  const isEmptyBrain = $derived(brain.ready && brain.titles.length === 0);
  const searching = $derived(settled.trim() !== '');
  const heading = $derived(
    searching
      ? `Results for “${settled.trim()}”`
      : `${MODE_LABELS[mode]}: ${MODE_DESCRIPTIONS[mode]}`,
  );
</script>

<svelte:head>
  <title>Search · somememos</title>
</svelte:head>

<h1 class="visually-hidden">Search</h1>

<form
  class="search"
  role="search"
  onsubmit={(e) => {
    e.preventDefault();
    settled = query;
  }}
>
  <label for="search-input" class="visually-hidden">Search your notes</label>
  <input
    id="search-input"
    type="search"
    placeholder="Search your notes"
    autocomplete="off"
    spellcheck="false"
    enterkeyhint="search"
    bind:value={query}
  />

  <fieldset class="modes">
    <legend class="visually-hidden">Rank results by</legend>
    {#each MODES as m (m)}
      <label class="mode" class:active={mode === m}>
        <input
          type="radio"
          name="mode"
          value={m}
          bind:group={mode}
          onchange={() => (limit = PAGE)}
        />
        {MODE_LABELS[m]}
      </label>
    {/each}
  </fieldset>

  <details class="dates" open={!!(since || until)}>
    <summary>
      Dated notes only{since || until ? ` · ${since || '…'} to ${until || '…'}` : ''}
    </summary>
    <div class="row">
      <div class="field">
        <label for="since">From</label>
        <input id="since" type="date" bind:value={since} />
      </div>
      <div class="field">
        <label for="until">To</label>
        <input id="until" type="date" bind:value={until} />
      </div>
      {#if since || until}
        <button type="button" class="ghost" onclick={() => ((since = ''), (until = ''))}>
          Clear dates
        </button>
      {/if}
    </div>
  </details>
</form>

{#if isEmptyBrain}
  <EmptyBrain />
{:else}
  <div class="status" role="status" aria-live="polite">
    <h2>{heading}</h2>
    {#if response && !loading}
      <span class="count">
        {plural(results.length, 'result')}{results.length >= limit ? '+' : ''}
      </span>
    {:else if loading}
      <span class="count">Searching…</span>
    {/if}
  </div>

  {#if error}
    <p class="notice error" role="alert">{error}</p>
  {:else if response && results.length === 0}
    <div class="empty card">
      {#if searching}
        <p><strong>No notes match “{settled.trim()}”.</strong></p>
        <p class="hint">
          Try fewer or different words{since || until ? ', or clear the date range' : ''}. Search
          matches whole words and their endings (graft finds grafting).
        </p>
      {:else}
        <p><strong>Nothing here yet.</strong></p>
        <p class="hint">
          This list fills up as you read and write notes. Open a few notes, or search for a word
          above.
        </p>
      {/if}
    </div>
  {:else if response}
    <ResultList
      {results}
      mode={response.mode}
      label={heading}
      {loading}
      hasMore={results.length >= limit}
      onmore={() => (limit += PAGE)}
    />
  {/if}
{/if}

<style>
  .search {
    display: grid;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }

  input[type='search'] {
    font-size: 1.1rem;
    padding: 0.65rem 0.9rem;
    border-radius: var(--radius);
    min-block-size: 48px;
  }

  .modes {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    border: 0;
  }

  .mode {
    display: inline-flex;
    align-items: center;
    min-block-size: var(--target);
    padding: 0.3rem 0.85rem;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    background: var(--surface);
    font-weight: 500;
    cursor: pointer;
  }

  .mode input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }

  .mode.active {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
    font-weight: 700;
  }

  .mode:has(input:focus-visible) {
    outline: 3px solid var(--focus);
    outline-offset: 2px;
  }

  .dates summary {
    list-style: none;
    gap: 0.4em;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 0.9rem;
    min-block-size: var(--target);
    display: flex;
    align-items: center;
  }

  .dates summary::before {
    content: '▸';
    font-size: 0.8em;
  }

  .dates[open] summary::before {
    content: '▾';
  }

  .dates summary::-webkit-details-marker {
    display: none;
  }

  .dates .row {
    align-items: end;
    margin-top: var(--space-2);
  }

  .dates .field {
    flex: 1 1 9rem;
  }

  .status {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .status h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }

  .count {
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .empty p {
    margin: 0 0 var(--space-1);
  }
</style>
