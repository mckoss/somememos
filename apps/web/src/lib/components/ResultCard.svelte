<script lang="ts">
  import type { engine } from '@somememos/core';
  import { resolve } from '$app/paths';
  import RankBreakdown from './RankBreakdown.svelte';
  import { paceRows, scoreSummary } from '#lib/ui/format.ts';
  import { danglingNotePath, encodeNotePath } from '#lib/ui/paths.ts';
  import { brain } from '#lib/ui/brain.svelte.ts';

  let {
    result,
    mode,
    bestRelevance = null,
  }: {
    result: engine.ResultView;
    mode: engine.RankMode;
    bestRelevance?: number | null;
  } = $props();

  const rows = $derived(paceRows(result, brain.halfLives));
  const summary = $derived(scoreSummary(result, mode, brain.halfLives));
  const createPath = $derived(result.dangling ? danglingNotePath(result.title, brain.roles) : null);

  /** The snippet split into plain and highlighted pieces. */
  const pieces = $derived.by(() => {
    const s = result.snippet;
    if (!s) return [];
    const out: { text: string; mark: boolean }[] = [];
    let at = 0;
    for (const h of [...s.highlights].sort((a, b) => a.start - b.start)) {
      if (h.start < at) continue;
      if (h.start > at) out.push({ text: s.text.slice(at, h.start), mark: false });
      out.push({ text: s.text.slice(h.start, h.end), mark: true });
      at = h.end;
    }
    if (at < s.text.length) out.push({ text: s.text.slice(at), mark: false });
    return out;
  });
</script>

<article class="result" class:dangling={result.dangling}>
  <div class="head">
    {#if result.path}
      <h3 class="title">
        <a href={resolve('/note/[...path]', { path: encodeNotePath(result.path) })}>
          {result.title}
        </a>
      </h3>
    {:else}
      <h3 class="title missing">{result.title}</h3>
    {/if}
    <span class="spark" aria-hidden="true" title="Pace today, this week, this month, this year">
      {#each rows as row (row.name)}
        <span
          class="tick"
          style:block-size="{Math.max(row.fraction * 100, row.perWeek > 0 ? 12 : 4)}%"
        ></span>
      {/each}
    </span>
  </div>

  {#if result.dangling}
    <p class="meta">
      <span class="badge draft">Not written yet</span>
      <span>Linked from other notes, but there’s no note for it.</span>
    </p>
  {:else}
    <p class="meta">
      <span class="path">{result.path}</span>
      {#if result.heading}<span class="heading">› {result.heading}</span>{/if}
      {#if result.date}<span class="date">{result.date}</span>{/if}
    </p>
  {/if}

  {#if pieces.length}
    <p class="snippet">
      {#each pieces as p, i (i)}{#if p.mark}<mark>{p.text}</mark>{:else}{p.text}{/if}{/each}
    </p>
  {/if}

  <div class="foot">
    <span class="summary">{summary}</span>
    {#if result.dangling && createPath}
      <a
        class="button create"
        href={resolve('/edit/[...path]', { path: encodeNotePath(createPath) })}
      >
        Write it
      </a>
    {/if}
  </div>

  <details class="why">
    <summary>Why this rank</summary>
    <RankBreakdown {result} {mode} {bestRelevance} halfLives={brain.halfLives} />
  </details>
</article>

<style>
  .result {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-3) var(--space-4);
    display: grid;
    gap: var(--space-1);
    content-visibility: auto;
    contain-intrinsic-size: auto 9rem;
  }

  .result.dangling {
    border-style: dashed;
  }

  .head {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
  }

  .title {
    flex: 1;
    min-inline-size: 0;
    margin: 0;
    font-size: 1.05rem;
  }

  .title a {
    display: inline-block;
    padding-block: 0.15rem;
    text-decoration: none;
  }

  .title a:hover {
    text-decoration: underline;
  }

  .title.missing {
    color: var(--missing);
  }

  .spark {
    display: inline-flex;
    align-items: flex-end;
    gap: 2px;
    block-size: 1.3rem;
    inline-size: 1.6rem;
    flex: none;
    margin-top: 0.2rem;
  }

  .tick {
    flex: 1;
    background: var(--hot);
    border-radius: 1px;
    opacity: 0.85;
  }

  .meta {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.6rem;
    color: var(--text-muted);
    font-size: 0.83rem;
  }

  .path {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    overflow-wrap: anywhere;
  }

  .snippet {
    margin: 0;
    font-size: 0.92rem;
  }

  .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .summary {
    font-size: 0.83rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .why summary {
    display: inline-flex;
    align-items: center;
    min-block-size: var(--target);
    cursor: pointer;
    color: var(--accent);
    font-size: 0.88rem;
    font-weight: 600;
  }

  .why[open] summary {
    margin-bottom: var(--space-2);
  }
</style>
