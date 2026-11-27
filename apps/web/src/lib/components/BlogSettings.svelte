<script lang="ts">
  // The public blog's settings on the server (PLAN.md section 8): on or off,
  // its public name with a live check, title, description and author.
  // Shown in More while this device is connected.
  import type { BlogSettingsView, BlogSlugCheck } from '#lib/brain/host.ts';
  import { host } from '#lib/ui/brain.svelte.ts';
  import { errorMessage } from '#lib/ui/errors.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  let saved = $state<BlogSettingsView | null>(null);
  let loadError = $state<string | null>(null);
  let enabled = $state(false);
  let slug = $state('');
  let title = $state('');
  let description = $state('');
  let author = $state('');
  let saving = $state(false);
  let message = $state<{ ok: boolean; text: string } | null>(null);
  let confirmOpen = $state(false);
  let offOpen = $state(false);

  const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,39}$/;

  function fill(v: BlogSettingsView) {
    saved = v;
    enabled = v.enabled;
    slug = v.slug ?? '';
    title = v.title ?? '';
    description = v.description ?? '';
    author = v.author ?? '';
  }

  $effect(() => {
    void (async () => {
      try {
        fill(await (await host()).sync.blogSettings());
        loadError = null;
      } catch (e) {
        loadError = errorMessage(e);
      }
    })();
  });

  // The public name: checked as you type (format here, availability on the server).
  let check = $state<BlogSlugCheck | null>(null);
  let checking = $state(false);
  const localProblem = $derived.by(() => {
    const s = slug.trim();
    if (s === '') return null;
    if (/[A-Z]/.test(s)) return 'Use lower-case letters only.';
    if (s.length < 2) return 'At least 2 characters.';
    if (s.length > 40) return 'At most 40 characters.';
    if (!SLUG.test(s))
      return 'Only letters, digits and single hyphens, starting and ending with a letter or digit.';
    return null;
  });
  $effect(() => {
    const s = slug.trim();
    check = null;
    if (s === '' || localProblem !== null || s === saved?.slug) return;
    checking = true;
    const timer = setTimeout(async () => {
      try {
        const result = await (await host()).sync.checkBlogSlug(s);
        if (slug.trim() === s) check = result;
      } catch {
        check = null;
      } finally {
        checking = false;
      }
    }, 300);
    return () => clearTimeout(timer);
  });
  const slugProblem = $derived(
    localProblem ?? (check && !check.available ? (check.problem ?? 'Not available.') : null),
  );
  const slugOk = $derived(
    slug.trim() !== '' && slugProblem === null && (slug.trim() === saved?.slug || !!check),
  );

  const dirty = $derived(
    !!saved &&
      (enabled !== saved.enabled ||
        slug.trim() !== (saved.slug ?? '') ||
        title.trim() !== (saved.title ?? '') ||
        description.trim() !== (saved.description ?? '') ||
        author.trim() !== (saved.author ?? '')),
  );
  const missing = $derived(
    enabled && (slug.trim() === '' || title.trim() === '')
      ? 'A blog needs a public name and a title to be turned on.'
      : null,
  );
  const canSave = $derived(dirty && !saving && !missing && slugProblem === null && !checking);
  const publicUrl = $derived(saved?.url ? new URL(saved.url, location.origin).href : null);

  function onSave() {
    if (enabled && !saved?.enabled) confirmOpen = true;
    else if (!enabled && saved?.enabled) offOpen = true;
    else void save();
  }

  async function save() {
    saving = true;
    message = null;
    try {
      const wasOn = saved?.enabled ?? false;
      fill(
        await (
          await host()
        ).sync.saveBlogSettings({
          enabled,
          slug: slug.trim() || null,
          title: title.trim() || null,
          description: description.trim() || null,
          author: author.trim() || null,
        }),
      );
      message = {
        ok: true,
        text:
          enabled && !wasOn
            ? 'Your blog is on. Published posts are public now.'
            : !enabled && wasOn
              ? 'Your blog is off. Every public page is gone.'
              : 'Blog settings saved.',
      };
    } catch (e) {
      message = { ok: false, text: errorMessage(e) };
    } finally {
      saving = false;
    }
  }
</script>

<div class="blog" data-testid="blog-settings">
  <p>
    Your blog is the one public part of this brain. Only posts in the blog folder whose front matter
    says <code>published: true</code> are shown; everything else stays private. Turning the blog off takes
    every page down at once.
  </p>

  {#if loadError}
    <p class="notice error" role="alert">{loadError}</p>
  {:else if !saved}
    <p class="hint">Loading…</p>
  {:else}
    {#if publicUrl}
      <p class="address" data-testid="blog-address">
        <Icon name="globe" size={18} />
        <span>Public at <a href={publicUrl} target="_blank" rel="noopener">{publicUrl}</a></span>
      </p>
    {/if}

    <label class="toggle">
      <input type="checkbox" bind:checked={enabled} data-testid="blog-enabled" />
      <span>Blog is on (public)</span>
    </label>

    <div class="field">
      <label for="blog-slug">Public name</label>
      <div class="slug-row">
        <span class="prefix" aria-hidden="true">/blog/</span>
        <input
          id="blog-slug"
          type="text"
          bind:value={slug}
          autocomplete="off"
          autocapitalize="none"
          spellcheck="false"
          maxlength="40"
          aria-invalid={slugProblem !== null}
          aria-describedby="blog-slug-state"
          placeholder="my-notes"
        />
      </div>
      <p id="blog-slug-state" class="slug-state" aria-live="polite" data-testid="blog-slug-state">
        {#if slugProblem}
          <span class="bad">{slugProblem}</span>
        {:else if checking}
          Checking…
        {:else if slugOk && slug.trim() !== saved.slug}
          <span class="good">Available.</span>
        {:else}
          Lower-case letters, digits and hyphens. It becomes part of every public address.
        {/if}
      </p>
    </div>

    <div class="field">
      <label for="blog-title">Title</label>
      <input id="blog-title" type="text" bind:value={title} maxlength="120" />
    </div>
    <div class="field">
      <label for="blog-description">Description <span class="optional">(optional)</span></label>
      <input id="blog-description" type="text" bind:value={description} maxlength="300" />
    </div>
    <div class="field">
      <label for="blog-author">Author <span class="optional">(optional)</span></label>
      <input id="blog-author" type="text" bind:value={author} maxlength="100" />
    </div>

    {#if missing}<p class="hint">{missing}</p>{/if}
    <div class="row actions">
      <button type="button" class="primary" disabled={!canSave} onclick={onSave}>
        Save blog settings
      </button>
      {#if dirty}
        <button type="button" onclick={() => saved && fill(saved)}>Undo changes</button>
      {/if}
    </div>
  {/if}
  {#if message}
    <p class="notice {message.ok ? 'ok' : 'error'}" role="status" data-testid="blog-message">
      {message.text}
    </p>
  {/if}
</div>

<Dialog bind:open={confirmOpen} title="Turn your blog on?">
  <p>
    Anyone will be able to read the posts in your blog folder that say <code>published: true</code>,
    at <strong>/blog/{slug.trim()}/</strong>. Nothing else in your brain becomes public.
  </p>
  {#snippet actions(close)}
    <button type="button" onclick={close}>Cancel</button>
    <button
      type="button"
      class="primary"
      onclick={() => {
        close();
        void save();
      }}
    >
      Turn it on
    </button>
  {/snippet}
</Dialog>

<Dialog bind:open={offOpen} title="Turn your blog off?">
  <p>
    Every public page of your blog goes away at once. Your posts stay in your brain, and you can
    turn the blog on again later.
  </p>
  {#snippet actions(close)}
    <button type="button" onclick={close}>Cancel</button>
    <button
      type="button"
      class="danger solid"
      onclick={() => {
        close();
        void save();
      }}
    >
      Turn it off
    </button>
  {/snippet}
</Dialog>

<style>
  .blog > p {
    margin: 0 0 var(--space-3);
  }

  .address {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--accent-soft);
    border-radius: var(--radius-sm);
    overflow-wrap: anywhere;
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-block-size: var(--target);
    font-weight: 600;
    margin-bottom: var(--space-2);
  }

  .field {
    display: grid;
    gap: var(--space-1);
    margin-bottom: var(--space-3);
  }

  .field input[type='text'] {
    inline-size: 100%;
    min-inline-size: 0;
  }

  .slug-row {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .prefix {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 0.9rem;
  }

  .slug-state {
    margin: 0;
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .bad {
    color: var(--danger);
  }

  .good {
    color: var(--accent-strong);
    font-weight: 600;
  }

  .optional {
    font-weight: 400;
    color: var(--text-muted);
  }

  .notice {
    margin: var(--space-3) 0 0;
  }

  .notice.ok {
    background: var(--accent-soft);
    color: var(--text);
  }
</style>
