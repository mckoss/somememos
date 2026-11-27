<script lang="ts">
  import type { Snippet } from 'svelte';
  import { APP_VERSION } from '#lib/version.ts';

  let { children }: { children: Snippet } = $props();
</script>

<header>
  <span class="name">somememos</span>
  <small class="version">v{APP_VERSION}</small>
</header>

<main>
  {@render children()}
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: system-ui, sans-serif;
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid #ddd;
  }

  .name {
    font-weight: 600;
  }

  .version {
    font-size: 0.75rem;
    color: #666;
  }

  main {
    padding: 1rem;
  }
</style>
