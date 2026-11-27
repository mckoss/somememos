<script lang="ts">
  import type { ImportFile, ImportResult } from '#lib/brain/host.ts';
  import Icon from './Icon.svelte';
  import RolesEditor, { rolesToText, type RolesText } from './RolesEditor.svelte';
  import { brain, changed, host } from '#lib/ui/brain.svelte.ts';
  import { errorMessage } from '#lib/ui/errors.ts';
  import { plural } from '#lib/ui/format.ts';
  import {
    canPickDirectory,
    classifyForImport,
    filesFromDirectoryPicker,
    filesFromDrop,
    filesFromInput,
    roleProblems,
    rolesFromText,
    type ImportRole,
    type PickedFile,
  } from '#lib/ui/import.ts';

  type Phase = 'choose' | 'review' | 'working' | 'done';

  let phase = $state<Phase>('choose');
  let picked = $state<PickedFile[]>([]);
  let rolesText = $state<RolesText>(rolesToText(brain.roles));
  let progress = $state({ done: 0, total: 0, stage: '' });
  let result = $state<(ImportResult & { excluded: number }) | null>(null);
  let error = $state<string | null>(null);
  let dragging = $state(false);
  let input = $state<HTMLInputElement>();
  const pickerAvailable = canPickDirectory();

  const roles = $derived(rolesFromText(rolesText));
  const problems = $derived(roleProblems(roles));
  const valid = $derived(Object.keys(problems).length === 0);
  const classified = $derived.by(() => {
    if (!valid) return null;
    try {
      return classifyForImport(
        picked.map((f) => f.path),
        roles,
      );
    } catch {
      return null;
    }
  });
  const counts = $derived.by(() => {
    const c: Record<ImportRole, number> = {
      memo: 0,
      dated: 0,
      source: 0,
      blog: 0,
      excluded: 0,
      none: 0,
    };
    for (const role of classified?.values() ?? []) c[role] += 1;
    return c;
  });
  const toImport = $derived(counts.memo + counts.dated + counts.source + counts.blog);

  function choose(files: PickedFile[]) {
    error = null;
    result = null;
    if (files.length === 0) {
      error = 'That folder has no files in it.';
      return;
    }
    picked = files;
    rolesText = rolesToText(brain.roles);
    phase = 'review';
  }

  async function pickWithApi() {
    const files = await filesFromDirectoryPicker();
    if (files) choose(files);
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    if (!e.dataTransfer) return;
    try {
      choose(await filesFromDrop(e.dataTransfer.items));
    } catch (err) {
      error = errorMessage(err);
    }
  }

  async function runImport() {
    if (!classified || !valid) return;
    phase = 'working';
    error = null;
    try {
      const h = await host();
      const current = JSON.stringify(h.engine.config.roles);
      if (JSON.stringify(roles) !== current) {
        progress = { done: 0, total: 0, stage: 'Applying folder roles…' };
        await h.updateConfig({ ...h.engine.config, roles } as typeof h.engine.config);
      }
      // Excluded and unassigned files are never read, let alone stored.
      const wanted = picked.filter((f) => {
        const role = classified.get(f.path);
        return role !== undefined && role !== 'excluded' && role !== 'none';
      });
      const now = Math.floor(Date.now() / 1000);
      // Read lazily, so a large folder never sits in memory all at once.
      async function* read(): AsyncGenerator<ImportFile> {
        for (const f of wanted) {
          yield {
            path: f.path,
            text: await f.file.text(),
            mtime: Math.min(now, Math.floor(f.file.lastModified / 1000)),
          };
        }
      }
      progress = { done: 0, total: wanted.length, stage: 'Importing' };
      const r = await h.importFiles(read(), {
        onProgress: (p) => {
          progress =
            p.phase === 'writing'
              ? { done: p.done, total: p.total ?? wanted.length, stage: 'Importing' }
              : {
                  done: 0,
                  total: 0,
                  stage: p.phase === 'indexing' ? 'Indexing notes…' : 'Finishing…',
                };
        },
      });
      result = { ...r, excluded: counts.excluded };
      phase = 'done';
      await changed();
    } catch (err) {
      error = errorMessage(err);
      phase = 'review';
    }
  }

  function reset() {
    picked = [];
    result = null;
    phase = 'choose';
    if (input) input.value = '';
  }
</script>

<div class="import">
  {#if phase === 'choose'}
    <div
      class="drop"
      class:dragging
      role="group"
      aria-label="Choose a folder to import"
      ondragover={(e) => {
        e.preventDefault();
        dragging = true;
      }}
      ondragleave={() => (dragging = false)}
      ondrop={onDrop}
    >
      <Icon name="folder" size={32} />
      <p>Choose the folder that holds your markdown notes, or drop it here.</p>
      <div class="row">
        <label class="button primary picker">
          <input
            bind:this={input}
            class="visually-hidden"
            type="file"
            webkitdirectory
            multiple
            data-testid="import-folder"
            onchange={(e) => {
              const list = e.currentTarget.files;
              if (list) choose(filesFromInput(list));
            }}
          />
          Choose a folder
        </label>
        {#if pickerAvailable}
          <button type="button" onclick={pickWithApi}>Open folder…</button>
        {/if}
      </div>
      <p class="hint">
        Files are read on this device and nothing is uploaded. Next, you can mark private folders as
        excluded before anything is read.
      </p>
    </div>
  {:else if phase === 'review'}
    <div class="review">
      <p>
        <strong>{plural(picked.length, 'file')} found.</strong>
        Check which folders hold what before importing. Excluded folders are not read at all.
      </p>
      <RolesEditor bind:value={rolesText} {counts} />
      <p class="summary" role="status">
        {plural(toImport, 'note')} will be imported{counts.excluded
          ? `, ${counts.excluded} excluded`
          : ''}{counts.none
          ? `, ${counts.none} left out (not markdown, or in no folder above)`
          : ''}.
      </p>
      <div class="row">
        <button
          type="button"
          class="primary"
          onclick={runImport}
          disabled={!valid || toImport === 0}
        >
          Import {plural(toImport, 'note')}
        </button>
        <button type="button" onclick={reset}>Choose another folder</button>
      </div>
    </div>
  {:else if phase === 'working'}
    <div class="working" role="status" aria-live="polite">
      <p>{progress.stage}{progress.total ? ` ${progress.done} of ${progress.total}` : ''}</p>
      <progress max={progress.total || undefined} value={progress.total ? progress.done : undefined}
      ></progress>
    </div>
  {:else if result}
    <div class="done" role="status">
      <p>
        <Icon name="check" />
        <strong>Imported {plural(result.imported, 'note')}.</strong>
        {#if result.skipped}{plural(result.skipped, 'file')} skipped.{/if}
        {#if result.excluded}{result.excluded} excluded files were never read.{/if}
      </p>
      <p class="hint">
        A first import is the starting point: it adds no activity. Notes gain activity as you read,
        edit and link them.
      </p>
      <button type="button" onclick={reset}>Import another folder</button>
    </div>
  {/if}
  {#if error}<p class="notice error" role="alert">{error}</p>{/if}
</div>

<style>
  .import {
    display: grid;
    gap: var(--space-3);
  }

  .drop {
    display: grid;
    justify-items: center;
    gap: var(--space-2);
    padding: var(--space-5) var(--space-4);
    border: 2px dashed var(--border-strong);
    border-radius: var(--radius);
    text-align: center;
    color: var(--text-muted);
  }

  .drop.dragging {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .drop p {
    margin: 0;
  }

  .drop .row {
    justify-content: center;
  }

  .picker:has(input:focus-visible) {
    outline: 3px solid var(--focus);
    outline-offset: 2px;
  }

  .review,
  .done,
  .working {
    display: grid;
    gap: var(--space-3);
  }

  .review p,
  .done p,
  .working p {
    margin: 0;
  }

  .summary {
    font-weight: 600;
  }

  .done button {
    justify-self: start;
  }

  progress {
    inline-size: 100%;
    block-size: 0.75rem;
    accent-color: var(--accent);
  }

  .done p :global(svg) {
    vertical-align: -0.25em;
    color: var(--up);
  }
</style>
