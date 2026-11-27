<script lang="ts">
  import type { engine } from '@somememos/core';
  import {
    describePace,
    formatNumber,
    kindSplit,
    neglectedSignal,
    paceRows,
    relevanceWords,
    splitHalfLife,
    trendingSignal,
    HALF_LIFE_LABELS,
  } from '#lib/ui/format.ts';

  let {
    result,
    mode,
    bestRelevance = null,
    halfLives,
  }: {
    result: engine.ResultView;
    mode: engine.RankMode;
    bestRelevance?: number | null;
    halfLives: Readonly<Record<string, number>>;
  } = $props();

  const c = $derived(result.components);
  const rows = $derived(paceRows(result, halfLives));
  const splitAt = $derived(splitHalfLife(mode));
  const split = $derived(kindSplit(result, splitAt));
  const splitLabel = $derived(HALF_LIFE_LABELS.find((h) => h.name === splitAt)?.window ?? splitAt);
  const hasActivity = $derived(rows.some((r) => r.perWeek > 0));
  const trend = $derived(trendingSignal(result));
  const neglect = $derived(neglectedSignal(result, halfLives));
  const searched = $derived(c.relevance !== null);

  const intro = $derived.by(() => {
    const kw = searched ? 'how well it matches your words, then ' : '';
    switch (mode) {
      case 'hot':
        return `Ranked by ${kw}how much you have used it lately.`;
      case 'trending':
        return `Ranked by ${kw}whether it is getting more attention than usual.`;
      case 'neglected':
        return `Ranked by ${kw}whether it mattered over the year but has gone quiet.`;
      default:
        return 'Ranked by how well it matches your words only; activity is shown but not used.';
    }
  });
</script>

<div class="breakdown">
  <p class="intro">{intro}</p>

  {#if searched}
    <section aria-label="Keyword match">
      <h4>Keyword match</h4>
      <p>
        <strong>{relevanceWords(c.relevance, bestRelevance)}</strong>
        <span class="detail">relevance {formatNumber(c.relevance)} (higher is a closer match)</span>
      </p>
    </section>
  {/if}

  <section aria-label="Activity">
    <h4>Activity</h4>
    {#if hasActivity}
      <p class="explain">
        Every read, edit and mention counts, and fades with time. Each bar is the average pace over
        a window; longer windows remember longer.
      </p>
      <ul class="bars">
        {#each rows as row (row.name)}
          <li>
            <span class="bar-label">{row.label}</span>
            <span class="bar" aria-hidden="true">
              <span
                class="fill"
                style:inline-size="{Math.max(row.fraction * 100, row.perWeek > 0 ? 2 : 0)}%"
              ></span>
            </span>
            <span class="bar-value">
              {describePace(row.perWeek)}
              <span class="detail">score {formatNumber(row.score)}</span>
            </span>
          </li>
        {/each}
      </ul>

      <h4>What kind of use</h4>
      <p class="explain">Over {splitLabel}:</p>
      <div class="split" aria-hidden="true">
        {#each split as s (s.kind)}
          {#if s.share > 0}
            <span class="seg {s.kind}" style:flex-grow={s.share}></span>
          {/if}
        {/each}
      </div>
      <ul class="legend">
        {#each split as s (s.kind)}
          <li>
            <span class="swatch {s.kind}" aria-hidden="true"></span>
            {s.label}
            <strong>{Math.round(s.share * 100)}%</strong>
            <span class="detail">score {formatNumber(s.score)}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="explain">No reads, edits or mentions recorded yet.</p>
    {/if}
    {#if c.floored}
      <p class="explain">
        With no activity of its own, it was ranked just below the least active match.
      </p>
    {/if}
  </section>

  <section aria-label="Trend">
    <h4>Trend: <span class="tone {trend.tone}">{trend.label}</span></h4>
    <p>{trend.sentence}</p>
    <p class="explain">
      Compares this week with this month. 1.0 means its usual pace; above 1 it is heating up, below
      1 it is cooling.
      {#if trend.value !== null}<span class="detail">pace {formatNumber(trend.value)}×</span>{/if}
    </p>
  </section>

  <section aria-label="Gone quiet">
    <h4>Gone quiet? <span class="tone {neglect.tone}">{neglect.label}</span></h4>
    <p>{neglect.sentence}</p>
    {#if neglect.value !== null}
      <p class="explain">
        Compares this month with the year. 1.0 means as busy as usual; higher means quieter.
        <span class="detail">{formatNumber(neglect.value)}×</span>
      </p>
    {/if}
  </section>

  {#if c.reranked}
    <p class="detail key">Reordered by activity among the closest keyword matches.</p>
  {/if}
</div>

<style>
  .breakdown {
    display: grid;
    gap: var(--space-3);
    font-size: 0.9rem;
  }

  .intro {
    margin: 0;
    font-weight: 600;
  }

  section {
    border-top: 1px solid var(--border);
    padding-top: var(--space-2);
  }

  h4 {
    margin: 0 0 var(--space-1);
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }

  h4 .tone {
    text-transform: none;
    letter-spacing: 0;
    font-size: 0.9rem;
  }

  p {
    margin: 0 0 var(--space-1);
  }

  .explain {
    color: var(--text-muted);
  }

  .detail {
    color: var(--text-muted);
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
    margin-inline-start: 0.35em;
  }

  .tone.up {
    color: var(--up);
  }

  .tone.down {
    color: var(--down);
  }

  .bars,
  .legend {
    margin: var(--space-1) 0 var(--space-2);
    padding: 0;
    list-style: none;
  }

  .bars li {
    display: grid;
    grid-template-columns: auto 1fr;
    grid-template-areas: 'label value' 'bar bar';
    align-items: center;
    gap: 2px var(--space-2);
    padding: 3px 0;
  }

  .bar-value {
    text-align: end;
  }

  @media (min-width: 40rem) {
    .bars li {
      grid-template-columns: 5.5rem minmax(4rem, 1fr) 15rem;
      grid-template-areas: 'label bar value';
    }
  }

  .bar-label {
    grid-area: label;
  }

  .bar {
    grid-area: bar;
    block-size: 0.6rem;
    border-radius: 999px;
    background: var(--surface-2);
    overflow: hidden;
  }

  .fill {
    display: block;
    block-size: 100%;
    background: var(--hot);
    border-radius: inherit;
  }

  .bar-value {
    grid-area: value;
    font-variant-numeric: tabular-nums;
  }

  .split {
    display: flex;
    block-size: 0.6rem;
    border-radius: 999px;
    overflow: hidden;
    background: var(--surface-2);
    gap: 2px;
  }

  .seg {
    flex-basis: 0;
  }

  .read {
    background: var(--kind-read);
  }

  .edit {
    background: var(--kind-edit);
  }

  .mention {
    background: var(--kind-mention);
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
  }

  .legend li {
    display: inline-flex;
    align-items: center;
    gap: 0.35em;
  }

  .swatch {
    inline-size: 0.7rem;
    block-size: 0.7rem;
    border-radius: 2px;
  }

  .key {
    margin: 0;
  }
</style>
