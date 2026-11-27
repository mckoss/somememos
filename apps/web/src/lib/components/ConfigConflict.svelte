<script lang="ts">
  // The shared config changed on this device and on another one: both sides,
  // and the choice of which to keep. Nothing is overwritten until the person
  // chooses.
  import type { ConfigConflictView } from '#lib/brain/host.ts';
  import { ROLE_INFO } from './RolesEditor.svelte';

  let {
    conflict,
    busy = false,
    onchoose,
  }: {
    conflict: ConfigConflictView;
    busy?: boolean;
    onchoose: (choice: 'mine' | 'theirs') => void;
  } = $props();

  const lines = (roles: Record<string, string[]>, role: string) => roles[role] ?? [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const otherSettingsDiffer = $derived.by(() => {
    const { roles: _a, ...mine } = conflict.local;
    const { roles: _b, ...theirs } = conflict.server;
    const keys = new Set([...Object.keys(mine), ...Object.keys(theirs)]);
    return [...keys].some(
      (k) => !same((mine as Record<string, unknown>)[k], (theirs as Record<string, unknown>)[k]),
    );
  });
  // Only the roles that differ; the rest are the same on both sides.
  const rows = $derived(
    ROLE_INFO.filter(
      (r) => !same(lines(conflict.local.roles, r.role), lines(conflict.server.roles, r.role)),
    ),
  );
</script>

<div
  class="conflict"
  role="group"
  aria-labelledby="config-conflict-h"
  data-testid="config-conflict"
>
  <h3 id="config-conflict-h">The folder roles were changed on two devices</h3>
  <p>
    This device and another one both changed how this brain’s folders are sorted, so sync is
    stopped. Choose which to keep; every device then uses it. Notes are never deleted either way.
  </p>
  <div class="table" role="table" aria-label="Folder roles on each side">
    <div class="head" role="row">
      <span role="columnheader">Role</span>
      <span role="columnheader">This device</span>
      <span role="columnheader">The server</span>
    </div>
    {#each rows as r (r.role)}
      {@const mine = lines(conflict.local.roles, r.role)}
      {@const theirs = lines(conflict.server.roles, r.role)}
      <div class="row" role="row">
        <span class="label" role="rowheader">{r.label}</span>
        <span class="side" role="cell" data-label="This device">
          {#each mine as p (p)}<code>{p}</code>{:else}<em>none</em>{/each}
        </span>
        <span class="side" role="cell" data-label="The server">
          {#each theirs as p (p)}<code>{p}</code>{:else}<em>none</em>{/each}
        </span>
      </div>
    {/each}
  </div>
  <p class="hint">
    {#if rows.length > 0}The other folder roles are the same on both.{/if}
    {#if otherSettingsDiffer}Other brain settings (half-lives, weights or search settings) differ
      too.{/if}
  </p>
  <div class="actions">
    <button type="button" class="primary" disabled={busy} onclick={() => onchoose('mine')}>
      Keep this device’s
    </button>
    <button type="button" disabled={busy} onclick={() => onchoose('theirs')}>
      Use the server’s
    </button>
  </div>
</div>

<style>
  .conflict {
    border: 1px solid var(--danger);
    border-radius: var(--radius-sm);
    padding: var(--space-3);
    margin-bottom: var(--space-3);
  }

  h3 {
    margin: 0 0 var(--space-2);
    font-size: 1rem;
  }

  p {
    margin: 0 0 var(--space-3);
  }

  .table {
    display: grid;
    gap: var(--space-1);
    margin-bottom: var(--space-3);
  }

  .head,
  .row {
    display: grid;
    grid-template-columns: 8rem 1fr 1fr;
    gap: var(--space-2);
    align-items: start;
  }

  .head {
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  .row {
    padding: var(--space-1) 0;
    border-top: 1px solid var(--border);
  }

  .row .side {
    background: var(--accent-soft);
    border-radius: var(--radius-sm);
  }

  .side {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 2px var(--space-1);
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }

  .label {
    font-weight: 600;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  @media (max-width: 32rem) {
    .head {
      display: none;
    }

    .row {
      grid-template-columns: 1fr 1fr;
    }

    .label {
      grid-column: 1 / -1;
    }

    .side::before {
      content: attr(data-label);
      font-size: 0.75rem;
      color: var(--text-muted);
    }
  }
</style>
