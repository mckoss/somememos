<script lang="ts">
  import type { engine } from '@somememos/core';
  import { resolve } from '$app/paths';
  import type { ConfigConflictView } from '#lib/brain/host.ts';
  import BlogSettings from '#lib/components/BlogSettings.svelte';
  import ConfigConflict from '#lib/components/ConfigConflict.svelte';
  import Dialog from '#lib/components/Dialog.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import ImportPanel from '#lib/components/ImportPanel.svelte';
  import RolesEditor, { rolesToText, type RolesText } from '#lib/components/RolesEditor.svelte';
  import SyncPanel from '#lib/components/SyncPanel.svelte';
  import { brain, changed, host } from '#lib/ui/brain.svelte.ts';
  import { errorMessage } from '#lib/ui/errors.ts';
  import { formatBytes, plural, relativeTime } from '#lib/ui/format.ts';
  import { roleProblems, rolesFromText } from '#lib/ui/import.ts';
  import { syncState } from '#lib/ui/sync.svelte.ts';
  import { setTheme, theme, type ThemeChoice } from '#lib/ui/theme.svelte.ts';
  import { APP_VERSION } from '#lib/version.ts';

  let status = $state<engine.EngineStatus | null>(null);
  let statusError = $state<string | null>(null);

  $effect(() => {
    void brain.revision;
    void (async () => {
      try {
        status = await (await host()).engine.status();
        statusError = null;
      } catch (e) {
        statusError = errorMessage(e);
      }
    })();
  });

  // Folder roles (outside an import).
  let rolesText = $state<RolesText>(rolesToText({}));
  let rolesLoadedAt = -1;
  $effect(() => {
    if (brain.revision !== rolesLoadedAt && brain.ready) {
      rolesLoadedAt = brain.revision;
      rolesText = rolesToText(brain.roles);
    }
  });
  const rolesChanged = $derived(
    JSON.stringify(rolesFromText(rolesText)) !==
      JSON.stringify(rolesFromText(rolesToText(brain.roles))),
  );
  const rolesValid = $derived(Object.keys(roleProblems(rolesFromText(rolesText))).length === 0);
  let rolesMessage = $state<{ ok: boolean; text: string } | null>(null);

  async function saveRoles() {
    rolesMessage = null;
    try {
      const h = await host();
      await h.updateConfig({
        ...h.engine.config,
        roles: rolesFromText(rolesText),
      } as typeof h.engine.config);
      await changed();
      if (!syncState.view?.connected) {
        rolesMessage = { ok: true, text: 'Folder roles saved and notes re-indexed.' };
        return;
      }
      rolesMessage = { ok: true, text: 'Folder roles saved here; sending them to the server…' };
      const view = await h.sync.syncNow();
      if (view.problem?.kind === 'config-conflict') {
        configConflict = await h.sync.configConflict();
        rolesMessage = {
          ok: false,
          text: 'Saved on this device, but another device changed the folder roles too. Choose which to keep above.',
        };
      } else if (view.problem) {
        rolesMessage = {
          ok: true,
          text: 'Folder roles saved on this device. They go to the server and your other devices on the next sync.',
        };
      } else {
        rolesMessage = {
          ok: true,
          text: 'Folder roles saved and sent to the server. Your other devices take them on their next sync.',
        };
      }
    } catch (e) {
      rolesMessage = { ok: false, text: errorMessage(e) };
    }
  }

  // A shared-config conflict (the roles changed here and on another device).
  let configConflict = $state<ConfigConflictView | null>(null);
  let resolvingConfig = $state(false);
  $effect(() => {
    const kind = syncState.view?.problem?.kind;
    if (kind !== 'config-conflict') {
      configConflict = null;
      return;
    }
    void host()
      .then((h) => h.sync.configConflict())
      .then((c) => (configConflict = c))
      .catch(() => undefined);
  });

  async function chooseConfig(choice: 'mine' | 'theirs') {
    resolvingConfig = true;
    rolesMessage = null;
    try {
      const h = await host();
      await h.sync.resolveConfigConflict(choice);
      configConflict = null;
      await changed();
      rolesText = rolesToText(h.engine.config.roles);
      rolesMessage = {
        ok: true,
        text:
          choice === 'mine'
            ? 'Kept this device’s folder roles; the server and your other devices now use them.'
            : 'Now using the server’s folder roles on this device.',
      };
    } catch (e) {
      rolesMessage = { ok: false, text: errorMessage(e) };
      configConflict = await (await host()).sync.configConflict().catch(() => null);
    } finally {
      resolvingConfig = false;
    }
  }

  // Storage.
  let persistMessage = $state<string | null>(null);
  async function keepData() {
    const h = await host();
    const ok = await h.requestPersistence();
    brain.storage = await h.storageInfo();
    persistMessage = ok
      ? 'The browser agreed to keep this app’s data.'
      : 'The browser didn’t agree. Installing the app, or using it more often, usually helps.';
  }

  // Export everything: every note plus the event log, as a zip built in the worker.
  let exportMessage = $state<{ ok: boolean; text: string } | null>(null);
  let exporting = $state(false);

  interface SaveFileHandle {
    createWritable(): Promise<WritableStream<Uint8Array>>;
  }
  type SavePicker = (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<SaveFileHandle>;

  async function exportEverything() {
    exporting = true;
    exportMessage = null;
    const name = `somememos-${new Date().toISOString().slice(0, 10)}.zip`;
    // Ask where to save first: the picker needs the click that started this.
    const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    let handle: SaveFileHandle | null = null;
    if (typeof picker === 'function') {
      try {
        handle = await picker({
          suggestedName: name,
          types: [{ description: 'Zip archive', accept: { 'application/zip': ['.zip'] } }],
        });
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') {
          exporting = false;
          return;
        }
        handle = null; // Not allowed here: fall back to a download.
      }
    }
    try {
      const { archive, notes, records } = await (await host()).exportArchive();
      if (handle) {
        // Streams the Blob into the file; pipeTo closes it when done.
        await archive.stream().pipeTo(await handle.createWritable());
      } else {
        const url = URL.createObjectURL(archive);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      exportMessage = {
        ok: true,
        text: `Exported ${plural(notes, 'note')} and ${plural(records, 'log record')}.`,
      };
    } catch (e) {
      exportMessage = { ok: false, text: errorMessage(e) };
    } finally {
      exporting = false;
    }
  }

  // Event log export and import.
  let logMessage = $state<{ ok: boolean; text: string } | null>(null);
  let logInput = $state<HTMLInputElement>();

  async function exportLog() {
    try {
      const text = await (await host()).engine.exportLog();
      const url = URL.createObjectURL(new Blob([text], { type: 'application/jsonl' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'events.jsonl';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      const lines = text.split('\n').filter((l) => l.trim() !== '').length;
      logMessage = { ok: true, text: `Exported ${plural(lines, 'record')}.` };
    } catch (e) {
      logMessage = { ok: false, text: errorMessage(e) };
    }
  }

  async function importLog(file: File) {
    try {
      const r = await (await host()).engine.importLog(await file.text());
      await changed();
      const added = r.log.appended + r.changes.appended;
      const dupes = r.log.duplicates + r.changes.duplicates;
      logMessage = {
        ok: true,
        text: `Added ${plural(r.log.appended, 'event')} and ${plural(r.changes.appended, 'change')}${
          dupes ? `; ${dupes} were already here` : ''
        }.${added === 0 ? ' Nothing new.' : ''}`,
      };
    } catch (e) {
      logMessage = { ok: false, text: errorMessage(e) };
    } finally {
      if (logInput) logInput.value = '';
    }
  }

  // Reset.
  const RESET_PHRASE = 'delete my notes';
  let resetOpen = $state(false);
  let resetTyped = $state('');
  let resetError = $state<string | null>(null);

  async function doReset(close: () => void) {
    try {
      await (await host()).reset();
      await changed();
      close();
    } catch (e) {
      resetError = errorMessage(e);
    }
  }

  const themes: { value: ThemeChoice; label: string }[] = [
    { value: 'system', label: 'Same as this device' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];
</script>

<svelte:head>
  <title>More · somememos</title>
</svelte:head>

<h1 class="page-title">More</h1>
<p class="page-intro">Bring notes in, decide which folders hold what, and look after your data.</p>

<nav class="jump" aria-label="On this page">
  <a href="#import">Import</a>
  <a href="#sync">Sync</a>
  {#if syncState.view?.connected}<a href="#blog">Blog</a>{/if}
  <a href="#roles">Folder roles</a>
  <a href="#storage">Storage</a>
  <a href="#log">Event log</a>
  <a href="#status">Status</a>
  <a href="#appearance">Appearance</a>
  <a href={resolve('/dangling')}>Not written yet</a>
</nav>

<div class="sections">
  <section id="import" class="card" aria-labelledby="import-h">
    <h2 id="import-h">Import notes</h2>
    <ImportPanel />
  </section>

  <section id="sync" class="card" aria-labelledby="sync-h">
    <h2 id="sync-h">Sync</h2>
    <SyncPanel />
  </section>

  {#if syncState.view?.connected}
    <section id="blog" class="card" aria-labelledby="blog-h">
      <h2 id="blog-h">Public blog</h2>
      <BlogSettings />
    </section>
  {/if}

  <section id="roles" class="card" aria-labelledby="roles-h">
    <h2 id="roles-h">Folder roles</h2>
    {#if configConflict}
      <ConfigConflict conflict={configConflict} busy={resolvingConfig} onchoose={chooseConfig} />
    {/if}
    {#if syncState.view?.connected}
      <p class="hint" data-testid="roles-synced">
        Every device that syncs with <strong>{syncState.view.brainId}</strong> shares these folder roles.
        Saving here changes them on the server too, and your other devices take them on their next sync.
        Notes in a folder you exclude stay where they are, on every device and on the server, but are
        no longer searched, scored or synced.
      </p>
    {/if}
    <RolesEditor bind:value={rolesText} />
    <div class="row actions">
      <button
        type="button"
        class="primary"
        disabled={!rolesChanged || !rolesValid}
        onclick={saveRoles}
      >
        Save roles
      </button>
      {#if rolesChanged}
        <button type="button" onclick={() => (rolesText = rolesToText(brain.roles))}>
          Undo changes
        </button>
      {/if}
    </div>
    {#if rolesMessage}
      <p class="notice {rolesMessage.ok ? 'ok' : 'error'}" role="status">{rolesMessage.text}</p>
    {/if}
  </section>

  <section id="storage" class="card" aria-labelledby="storage-h">
    <h2 id="storage-h">Storage on this device</h2>
    {#if brain.storage}
      {#if brain.storage.kind === 'memory'}
        <p class="notice">
          Your notes are only in this tab’s memory right now. They are lost when you reload or close
          the tab. Export everything to keep a copy.
          {#if brain.storage.reason}<br />{brain.storage.reason}{/if}
        </p>
      {:else}
        <p>
          Your notes are stored in this browser on this device.
          {#if brain.storage.persisted}
            <strong>The browser has promised to keep them.</strong>
          {:else}
            The browser may clear them if the device runs low on space.
          {/if}
        </p>
      {/if}
      {#if brain.storage.runsIn === 'other-tab'}
        <p class="hint" data-testid="runs-in-other-tab">
          The app is also open in another tab or window, which looks after your notes while it is
          open. Changes you make here go through it, and both stay up to date.
        </p>
      {/if}
      {#if brain.storage.usage !== undefined}
        <p class="hint">
          Using {formatBytes(brain.storage.usage)}{brain.storage.quota !== undefined
            ? ` of ${formatBytes(brain.storage.quota)} available`
            : ''}.
        </p>
      {/if}
      {#if !brain.storage.persisted}
        <button type="button" onclick={keepData}>Keep my data</button>
      {/if}
      {#if persistMessage}<p class="hint" role="status">{persistMessage}</p>{/if}
    {:else}
      <p class="hint">Checking…</p>
    {/if}
  </section>

  <section id="export" class="card" aria-labelledby="export-h">
    <h2 id="export-h">Export everything</h2>
    <p>
      One <code>.zip</code> with every note stored on this device at its path (including notes in
      excluded folders) and the event log as <code>events.jsonl</code>. It is your whole brain:
      unzip it into a folder to use it anywhere, or import it here again.
    </p>
    <div class="row">
      <button
        type="button"
        onclick={exportEverything}
        disabled={exporting}
        data-testid="export-everything"
      >
        <Icon name="download" size={18} />
        {exporting ? 'Exporting…' : 'Export everything'}
      </button>
    </div>
    {#if exportMessage}
      <p
        class="notice {exportMessage.ok ? 'ok' : 'error'}"
        role="status"
        data-testid="export-message"
      >
        {exportMessage.text}
      </p>
    {/if}
  </section>

  <section id="log" class="card" aria-labelledby="log-h">
    <h2 id="log-h">Event log</h2>
    <p>
      The event log is every read, edit and mention, with the change history. It is the one part of
      your brain that can’t be rebuilt from the notes, so keep a copy. The file holds note paths but
      no note text.
    </p>
    <div class="row">
      <button type="button" onclick={exportLog}>
        <Icon name="download" size={18} /> Export events.jsonl
      </button>
      <label class="button">
        <Icon name="upload" size={18} /> Import a log…
        <input
          bind:this={logInput}
          class="visually-hidden"
          type="file"
          accept=".jsonl,.json,.txt,application/jsonl,application/json,text/plain"
          data-testid="import-log"
          onchange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f) void importLog(f);
          }}
        />
      </label>
    </div>
    <p class="hint">
      Importing skips records already here, so it is safe to import the same file twice.
    </p>
    {#if logMessage}
      <p class="notice {logMessage.ok ? 'ok' : 'error'}" role="status" data-testid="log-message">
        {logMessage.text}
      </p>
    {/if}
  </section>

  <section id="status" class="card" aria-labelledby="status-h">
    <h2 id="status-h">Brain status</h2>
    {#if statusError}
      <p class="notice error">{statusError}</p>
    {:else if status}
      <dl class="stats" data-testid="status">
        <div>
          <dt>Notes</dt>
          <dd data-stat="notes">{status.notes.total}</dd>
        </div>
        <div>
          <dt>Memos</dt>
          <dd>{status.notes.memo ?? 0}</dd>
        </div>
        <div>
          <dt>Diary entries</dt>
          <dd>{status.notes.dated ?? 0}</dd>
        </div>
        <div>
          <dt>Sources</dt>
          <dd>{status.notes.source ?? 0}</dd>
        </div>
        {#if (status.notes as Record<string, number>).blog !== undefined}
          <div>
            <dt>Blog posts</dt>
            <dd>{(status.notes as Record<string, number>).blog}</dd>
          </div>
        {/if}
        <div>
          <dt>Sections</dt>
          <dd>{status.sections}</dd>
        </div>
        <div>
          <dt>Not written yet</dt>
          <dd>{status.dangling}</dd>
        </div>
        <div>
          <dt>Reads</dt>
          <dd data-stat="read">{status.events.read ?? 0}</dd>
        </div>
        <div>
          <dt>Edits</dt>
          <dd data-stat="edit">{status.events.edit ?? 0}</dd>
        </div>
        <div>
          <dt>Mentions</dt>
          <dd data-stat="mention">{status.events.mention ?? 0}</dd>
        </div>
        <div>
          <dt>Changes</dt>
          <dd>{status.changes}</dd>
        </div>
        <div>
          <dt>First indexed</dt>
          <dd>{status.firstIndexedAt ? relativeTime(status.firstIndexedAt) : 'never'}</dd>
        </div>
      </dl>
      <p class="hint">App version v{APP_VERSION}.</p>
    {:else}
      <p class="hint">Loading…</p>
    {/if}
  </section>

  <section id="appearance" class="card" aria-labelledby="appearance-h">
    <h2 id="appearance-h">Appearance</h2>
    <fieldset class="themes">
      <legend>Theme</legend>
      {#each themes as t (t.value)}
        <label>
          <input
            type="radio"
            name="theme"
            value={t.value}
            checked={theme.choice === t.value}
            onchange={() => setTheme(t.value)}
          />
          {t.label}{t.value === 'system' ? ` (now ${theme.systemDark ? 'dark' : 'light'})` : ''}
        </label>
      {/each}
    </fieldset>
  </section>

  <section id="reset" class="card danger-zone" aria-labelledby="reset-h">
    <h2 id="reset-h">Start over</h2>
    <p>
      Delete every note and all activity from this device. Export everything first if you want a
      copy.
    </p>
    <button
      type="button"
      class="danger"
      onclick={() => {
        resetTyped = '';
        resetError = null;
        resetOpen = true;
      }}
    >
      Delete everything…
    </button>
  </section>
</div>

<Dialog bind:open={resetOpen} title="Delete everything on this device?">
  <p>
    This removes all {status ? plural(status.notes.total, 'note') : 'notes'} and their activity from this
    browser. It can’t be undone.
  </p>
  {#if syncState.view?.connected}
    <p>
      It also disconnects this device from the server and forgets its access token. Nothing is
      deleted from the server.
    </p>
  {/if}
  <div class="field">
    <label for="reset-confirm">Type <strong>{RESET_PHRASE}</strong> to confirm</label>
    <input
      id="reset-confirm"
      type="text"
      bind:value={resetTyped}
      autocomplete="off"
      spellcheck="false"
    />
  </div>
  {#if resetError}<p class="notice error" role="alert">{resetError}</p>{/if}
  {#snippet actions(close)}
    <button type="button" onclick={close}>Cancel</button>
    <button
      type="button"
      class="danger solid"
      disabled={resetTyped.trim().toLowerCase() !== RESET_PHRASE}
      onclick={() => doReset(close)}
    >
      Delete everything
    </button>
  {/snippet}
</Dialog>

<style>
  .jump {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    margin-bottom: var(--space-4);
    font-size: 0.9rem;
  }

  .jump a {
    display: inline-flex;
    align-items: center;
    min-block-size: var(--target);
  }

  .sections {
    display: grid;
    gap: var(--space-4);
    max-inline-size: 48rem;
  }

  section {
    scroll-margin-top: calc(var(--topbar-h) + var(--space-3));
  }

  h2 {
    margin: 0 0 var(--space-3);
    font-size: 1.15rem;
  }

  section > p {
    margin: 0 0 var(--space-3);
  }

  .actions {
    margin-top: var(--space-3);
  }

  .notice {
    margin: var(--space-3) 0 0;
  }

  .notice.ok {
    background: var(--accent-soft);
    color: var(--text);
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr));
    gap: var(--space-2);
    margin: 0 0 var(--space-3);
  }

  .stats div {
    padding: var(--space-2) var(--space-3);
    background: var(--surface-2);
    border-radius: var(--radius-sm);
  }

  .stats dt {
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  .stats dd {
    margin: 0;
    font-size: 1.2rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .themes {
    border: 0;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-1);
  }

  .themes legend {
    font-weight: 600;
    margin-bottom: var(--space-1);
  }

  .themes label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-weight: 400;
    min-block-size: var(--target);
  }

  .danger-zone {
    border-color: var(--danger);
  }

  .field {
    margin-top: var(--space-3);
  }
</style>
