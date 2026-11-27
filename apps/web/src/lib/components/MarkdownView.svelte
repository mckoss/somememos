<script lang="ts">
  import { resolve } from '$app/paths';
  import { brain } from '#lib/ui/brain.svelte.ts';
  import { createResolver } from '#lib/ui/links.ts';
  import { renderMarkdown } from '#lib/ui/markdown.ts';
  import { danglingNotePath, encodeNotePath } from '#lib/ui/paths.ts';

  let { text, path, label }: { text: string; path: string; label?: string } = $props();

  const resolveTarget = $derived(
    createResolver(
      brain.titles.map((t) => t.path),
      path,
    ),
  );

  const html = $derived(
    renderMarkdown(text, {
      resolveLink: (target) => {
        const r = resolveTarget(target);
        if (r.kind === 'note') {
          return {
            href: resolve('/note/[...path]', { path: encodeNotePath(r.path) }),
            exists: true,
          };
        }
        const create = danglingNotePath(target, brain.roles);
        return {
          href: create ? resolve('/edit/[...path]', { path: encodeNotePath(create) }) : '#',
          exists: false,
        };
      },
    }),
  );
</script>

<div class="prose" role={label ? 'region' : undefined} aria-label={label}>
  <!-- renderMarkdown sanitizes its output with DOMPurify. -->
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  {@html html}
</div>
