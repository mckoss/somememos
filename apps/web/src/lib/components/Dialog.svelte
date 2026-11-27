<script lang="ts">
  // A modal dialog on the native <dialog> element: focus is trapped and
  // restored by the browser, Escape closes it, and the page behind is inert.
  import type { Snippet } from 'svelte';

  let {
    open = $bindable(false),
    title,
    children,
    actions,
    onclose,
    wide = false,
  }: {
    open?: boolean;
    title: string;
    children: Snippet;
    /** The buttons; a `close` function is passed in. */
    actions?: Snippet<[() => void]>;
    onclose?: () => void;
    wide?: boolean;
  } = $props();

  let dialog = $state<HTMLDialogElement>();

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  });

  const close = () => (open = false);
  const titleId = `dialog-${Math.random().toString(36).slice(2)}`;
</script>

<dialog
  bind:this={dialog}
  class:wide
  aria-labelledby={titleId}
  onclose={() => {
    open = false;
    onclose?.();
  }}
>
  <h2 id={titleId}>{title}</h2>
  <div class="body">{@render children()}</div>
  {#if actions}
    <div class="actions">{@render actions(close)}</div>
  {/if}
</dialog>

<style>
  dialog {
    inline-size: min(32rem, calc(100vw - 2rem));
    max-block-size: calc(var(--app-height) - 2rem);
    padding: var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow);
    overflow: auto;
  }

  dialog.wide {
    inline-size: min(64rem, calc(100vw - 2rem));
  }

  dialog::backdrop {
    background: rgb(0 0 0 / 0.45);
  }

  h2 {
    margin: 0 0 var(--space-3);
    font-size: 1.2rem;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-4);
  }

  @media (max-width: 30rem) {
    dialog {
      padding: var(--space-4);
    }

    .actions > :global(button) {
      flex: 1 1 100%;
    }
  }
</style>
