<script lang="ts">
  // The small sync status in the header. Nothing at all when this device
  // isn't connected to a server: not syncing is a normal way to use the app.
  import { resolve } from '$app/paths';
  import Icon, { type IconName } from './Icon.svelte';
  import { INDICATOR_LABEL, syncState } from '#lib/ui/sync.svelte.ts';

  const view = $derived(syncState.view);
  const indicator = $derived(view?.indicator ?? 'off');

  const ICONS: Record<string, IconName> = {
    synced: 'cloud-check',
    syncing: 'sync',
    waiting: 'cloud-up',
    offline: 'cloud-off',
    attention: 'alert',
  };

  const detail = $derived.by(() => {
    if (!view || indicator === 'off') return '';
    if (indicator === 'attention') {
      if (view.conflicts > 0)
        return `${view.conflicts} ${view.conflicts === 1 ? 'conflict' : 'conflicts'} to resolve`;
      return view.problem?.message ?? 'Sync needs attention';
    }
    if (indicator === 'waiting') {
      const n = view.pending.notes;
      return n > 0
        ? `${n} ${n === 1 ? 'note' : 'notes'} waiting to sync`
        : 'Changes waiting to sync';
    }
    return `${INDICATOR_LABEL[indicator]}${view.brainId ? ` with ${view.brainId}` : ''}`;
  });
</script>

{#if view && indicator !== 'off'}
  <a
    class="sync-indicator {indicator}"
    href="{resolve('/more')}#sync"
    data-testid="sync-indicator"
    data-state={indicator}
    title={detail}
    aria-label="Sync: {INDICATOR_LABEL[indicator]}. {detail}"
  >
    <span class="icon" class:spin={indicator === 'syncing'}>
      <Icon name={ICONS[indicator] ?? 'cloud'} size={18} />
    </span>
    <span class="label">{INDICATOR_LABEL[indicator]}</span>
  </a>
{/if}

<style>
  .sync-indicator {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    min-block-size: var(--target);
    min-inline-size: var(--target);
    justify-content: center;
    padding: 0 var(--space-2);
    border-radius: 999px;
    color: var(--text-muted);
    font-size: 0.8rem;
    text-decoration: none;
    white-space: nowrap;
  }

  .sync-indicator:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  .icon {
    display: inline-flex;
  }

  .spin {
    animation: spin 1.2s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spin {
      animation: none;
    }
  }

  .waiting {
    color: var(--down);
  }

  .offline {
    color: var(--text-muted);
  }

  .attention {
    color: var(--danger);
    background: var(--danger-soft);
    font-weight: 600;
  }

  /* On a phone the quiet states are just the icon; the ones that need a look keep their words. */
  @media (max-width: 40rem) {
    .synced .label,
    .syncing .label,
    .offline .label,
    .waiting .label {
      position: absolute;
      inline-size: 1px;
      block-size: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  }
</style>
