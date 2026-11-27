<script lang="ts">
  import '../app.css';
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { APP_VERSION } from '#lib/version.ts';
  import Icon, { type IconName } from '#lib/components/Icon.svelte';
  import { applyUpdate, updateAvailable } from '#lib/brain/updates.ts';
  import { brain, host, retry } from '#lib/ui/brain.svelte.ts';
  import { shownScheme, startTheme, toggleTheme } from '#lib/ui/theme.svelte.ts';
  import { startViewportTracking } from '#lib/ui/viewport.ts';

  let { children }: { children: Snippet } = $props();

  interface NavItem {
    href: string;
    label: string;
    icon: IconName;
    /** Shown in the desktop sidebar only. */
    wide?: boolean;
  }

  const nav: NavItem[] = [
    { href: resolve('/'), label: 'Search', icon: 'search' },
    { href: resolve('/hot'), label: 'Hot', icon: 'hot' },
    { href: resolve('/trending'), label: 'Trending', icon: 'trending' },
    { href: resolve('/neglected'), label: 'Neglected', icon: 'neglected' },
    { href: resolve('/dangling'), label: 'Not written yet', icon: 'link', wide: true },
    { href: resolve('/new'), label: 'New', icon: 'new' },
    { href: resolve('/more'), label: 'More', icon: 'more' },
  ];

  const editing = $derived(page.route.id?.startsWith('/edit/') ?? false);
  const memoryOnly = $derived(brain.storage?.kind === 'memory');

  // A new version of the app installed in the background and waiting.
  let updateReady = $state(false);
  let updating = $state(false);

  async function reloadForUpdate() {
    updating = true;
    // The page reloads once the new version takes over (see updates.ts).
    await applyUpdate();
  }

  function isCurrent(href: string): boolean {
    const path = page.url.pathname;
    return href === resolve('/') ? path === href : path === href || path.startsWith(`${href}/`);
  }

  function typingIn(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }

  async function focusSearch() {
    if (page.url.pathname !== resolve('/')) await goto(resolve('/'));
    document.getElementById('search-input')?.focus();
  }

  function onKeydown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      void focusSearch();
      return;
    }
    if (mod || e.altKey || typingIn(e.target) || document.querySelector('dialog[open]')) return;
    if (e.key === '/') {
      e.preventDefault();
      void focusSearch();
    } else if (e.key === 'n') {
      e.preventDefault();
      void goto(resolve('/new'));
    }
  }

  onMount(() => {
    const stopTheme = startTheme();
    const stopViewport = startViewportTracking();
    void host().catch(() => {});
    const stopUpdates = updateAvailable.subscribe((ready) => (updateReady = ready));
    return () => {
      stopTheme();
      stopViewport();
      stopUpdates();
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />

<a class="skip-link" href="#main">Skip to content</a>

<div class="shell" class:editing>
  <header class="topbar">
    <a class="brand" href={resolve('/')}>
      <span class="name">somememos</span>
    </a>
    <small class="version">v{APP_VERSION}</small>
    <span class="spacer"></span>
    <button
      class="ghost icon theme-toggle"
      type="button"
      onclick={toggleTheme}
      aria-label={shownScheme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      title={shownScheme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      <Icon name={shownScheme() === 'dark' ? 'sun' : 'moon'} />
    </button>
  </header>

  <nav class="mainnav" aria-label="Main">
    <ul>
      {#each nav as item (item.href)}
        <li class:wide={item.wide}>
          <a href={item.href} aria-current={isCurrent(item.href) ? 'page' : undefined}>
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </a>
        </li>
      {/each}
    </ul>
    <div class="shortcuts">
      <p><kbd>/</kbd> or <kbd>Ctrl</kbd> <kbd>K</kbd> search</p>
      <p><kbd>N</kbd> new note</p>
      <p><kbd>Ctrl</kbd> <kbd>S</kbd> save</p>
    </div>
  </nav>

  <main id="main" tabindex="-1">
    {#if updateReady}
      <div class="notice update" role="status" data-testid="update-prompt">
        <span>A new version is ready.</span>
        <button type="button" class="primary" onclick={reloadForUpdate} disabled={updating}>
          {updating ? 'Reloading…' : 'Reload'}
        </button>
      </div>
    {/if}
    {#if memoryOnly}
      <div class="notice memory-warning" role="status" data-testid="memory-warning">
        <strong>Your notes are not being saved on this device.</strong>
        <p>
          They are kept only while this tab is open, and are lost when you reload or close it.
          {#if brain.storage?.reason}{brain.storage.reason}{/if}
        </p>
      </div>
    {/if}
    {#if brain.error}
      <div class="notice error open-error" role="alert">
        {#if brain.busy}
          <strong>Your notes are open in another window.</strong>
          <p>
            Another tab or window of somememos is holding your notes and couldn’t share them. Close
            the other one (or switch to it), then try again.
          </p>
        {:else}
          <strong>Your notes could not be opened.</strong>
          <p>{brain.error}</p>
        {/if}
        <button type="button" onclick={() => void retry()}>Try again</button>
      </div>
    {:else}
      {@render children()}
    {/if}
  </main>
</div>

<style>
  .skip-link {
    position: absolute;
    inset-inline-start: var(--space-2);
    inset-block-start: -4rem;
    z-index: 100;
    padding: var(--space-2) var(--space-3);
    background: var(--surface);
    border-radius: var(--radius-sm);
  }

  .skip-link:focus {
    inset-block-start: var(--space-2);
  }

  .shell {
    min-block-size: 100dvh;
    display: grid;
    grid-template-rows: auto 1fr;
    grid-template-areas: 'top' 'main';
  }

  .topbar {
    grid-area: top;
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-block-size: var(--topbar-h);
    padding: 0 var(--space-3);
    padding-top: env(safe-area-inset-top, 0px);
    padding-inline: max(var(--space-3), env(safe-area-inset-left, 0px))
      max(var(--space-3), env(safe-area-inset-right, 0px));
    background: color-mix(in srgb, var(--bg) 92%, transparent);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--border);
  }

  .brand {
    display: inline-flex;
    align-items: center;
    min-block-size: var(--target);
    color: var(--text);
    text-decoration: none;
  }

  .name {
    font-weight: 700;
    letter-spacing: -0.01em;
    font-size: 1.1rem;
  }

  .version {
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .spacer {
    flex: 1;
  }

  main {
    grid-area: main;
    min-inline-size: 0;
    padding: var(--space-4);
    padding-bottom: calc(var(--bottomnav-h) + env(safe-area-inset-bottom, 0px) + var(--space-5));
    outline: none;
  }

  .memory-warning,
  .open-error,
  .update {
    margin: 0 0 var(--space-4);
    font-size: 0.9rem;
  }

  .memory-warning p,
  .open-error p {
    margin: var(--space-1) 0 0;
  }

  .open-error button {
    margin-top: var(--space-3);
  }

  .update {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2) var(--space-3);
    background: var(--accent-soft);
    color: var(--text);
  }

  /* Phone: navigation is a bar at the bottom. */
  .mainnav {
    position: fixed;
    inset-inline: 0;
    bottom: 0;
    z-index: 20;
    background: var(--surface);
    border-top: 1px solid var(--border);
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }

  .mainnav ul {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .mainnav li.wide,
  .shortcuts {
    display: none;
  }

  .mainnav a {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    min-block-size: var(--bottomnav-h);
    min-inline-size: 44px;
    padding: var(--space-1) 2px;
    color: var(--text-muted);
    font-size: 0.7rem;
    text-decoration: none;
    text-align: center;
  }

  .mainnav a[aria-current='page'] {
    color: var(--accent);
    font-weight: 700;
  }

  /* While editing on a phone, the editor gets the whole screen. */
  .shell.editing .mainnav {
    display: none;
  }

  .shell.editing main {
    padding-bottom: var(--space-4);
  }

  :global(html[data-keyboard]) .mainnav {
    display: none;
  }

  /* Desktop: navigation is a sidebar. */
  @media (min-width: 60rem) {
    .shell {
      grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
      grid-template-areas: 'top top' 'nav main';
    }

    .mainnav,
    .shell.editing .mainnav {
      grid-area: nav;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      position: sticky;
      top: var(--topbar-h);
      align-self: start;
      block-size: calc(100dvh - var(--topbar-h));
      padding: var(--space-3);
      border-top: 0;
      border-inline-end: 1px solid var(--border);
      background: transparent;
    }

    :global(html[data-keyboard]) .mainnav {
      display: flex;
    }

    .mainnav ul {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .mainnav li.wide {
      display: block;
    }

    .mainnav a {
      flex-direction: row;
      justify-content: flex-start;
      gap: var(--space-3);
      min-block-size: 2.5rem;
      padding: var(--space-2) var(--space-3);
      border-radius: var(--radius-sm);
      font-size: 0.95rem;
      color: var(--text);
    }

    .mainnav a:hover {
      background: var(--surface-2);
    }

    .mainnav a[aria-current='page'] {
      background: var(--accent-soft);
      color: var(--accent-strong);
    }

    .shortcuts {
      display: block;
      color: var(--text-muted);
      font-size: 0.78rem;
    }

    .shortcuts p {
      margin: var(--space-1) 0;
    }

    main,
    .shell.editing main {
      padding: var(--space-5) var(--space-6);
      max-inline-size: 72rem;
    }
  }
</style>
