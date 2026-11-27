<script lang="ts">
  // Conflict copies a sync left (PLAN.md section 7, "Edits and conflicts"):
  // each with this device's version beside the server's, and a choice of
  // which to keep. Resolving saves the chosen text and removes the copy, as
  // ordinary changes that then sync. Nothing is lost before the person
  // chooses; "Keep both" keeps this device's text as a note of its own.
  import type { ConflictChoice, SyncConflictView } from '#lib/brain/host.ts';
  import { resolve } from '$app/paths';
  import { brain, changed, host } from '#lib/ui/brain.svelte.ts';
  import { errorMessage } from '#lib/ui/errors.ts';
  import { encodeNotePath } from '#lib/ui/paths.ts';
  import { syncState } from '#lib/ui/sync.svelte.ts';
  import { compareVersions } from '#lib/sync/connect-plan.ts';

  let list = $state<SyncConflictView[] | null>(null);
  let busy = $state<string | null>(null);
  let message = $state<{ ok: boolean; text: string } | null>(null);

  $effect(() => {
    void brain.revision;
    void syncState.view?.conflicts;
    void (async () => {
      try {
        list = await (await host()).sync.conflicts();
      } catch (e) {
        message = { ok: false, text: errorMessage(e) };
      }
    })();
  });

  async function choose(conflict: SyncConflictView, choice: ConflictChoice) {
    busy = conflict.path;
    message = null;
    try {
      const r = await (await host()).sync.resolveConflict(conflict.path, choice);
      await changed();
      message = {
        ok: true,
        text:
          choice === 'mine'
            ? `Kept this device’s version of ${conflict.original}.`
            : choice === 'theirs'
              ? `Kept the server’s version of ${conflict.original}.`
              : `Kept both: this device’s version is now ${r.kept}.`,
      };
    } catch (e) {
      message = { ok: false, text: errorMessage(e) };
    } finally {
      busy = null;
    }
  }
</script>

{#if list && list.length > 0}
  <div class="conflicts" id="sync-conflicts" data-testid="sync-conflicts">
    <h3>
      {list.length === 1 ? 'A note to resolve' : `${list.length} notes to resolve`}
    </h3>
    <p class="hint">
      These notes were changed on this device and elsewhere before they synced, so both versions
      were kept. Choose which to keep; nothing is removed until you do.
    </p>
    <ul>
      {#each list as conflict (conflict.path)}
        {@const cmp = compareVersions(conflict.mine, conflict.theirs)}
        <li class="conflict" data-testid="sync-conflict" data-path={conflict.original}>
          <p class="which">
            <a href={resolve('/note/[...path]', { path: encodeNotePath(conflict.original) })}>
              {conflict.original}
            </a>
            <span class="hint">· kept {conflict.date}</span>
          </p>
          {#if cmp.same > 0}
            <p class="hint same">
              The first {cmp.same === 1 ? 'line is' : `${cmp.same} lines are`} the same in both; shown
              from where they differ.
            </p>
          {/if}
          <div class="versions">
            <section>
              <h4>This device’s version</h4>
              <pre data-testid="conflict-mine">{cmp.mine}</pre>
            </section>
            <section>
              <h4>The server’s version</h4>
              <pre data-testid="conflict-theirs">{cmp.theirs ??
                  '(The note was deleted on the server.)'}</pre>
            </section>
          </div>
          <div class="row actions">
            <button
              type="button"
              class="primary"
              disabled={busy !== null}
              onclick={() => choose(conflict, 'mine')}
            >
              Keep this device’s
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onclick={() => choose(conflict, 'theirs')}
            >
              Keep the server’s
            </button>
            <button type="button" disabled={busy !== null} onclick={() => choose(conflict, 'both')}>
              Keep both
            </button>
          </div>
        </li>
      {/each}
    </ul>
  </div>
{/if}
{#if message}
  <p class="notice {message.ok ? 'ok' : 'error'}" role="status" data-testid="conflict-message">
    {message.text}
  </p>
{/if}

<style>
  .conflicts {
    margin-top: var(--space-4);
    scroll-margin-top: calc(var(--topbar-h) + var(--space-3));
  }

  h3 {
    margin: 0 0 var(--space-1);
    font-size: 1rem;
  }

  ul {
    list-style: none;
    margin: var(--space-3) 0 0;
    padding: 0;
    display: grid;
    gap: var(--space-4);
  }

  .conflict {
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }

  .which {
    margin: 0 0 var(--space-2);
    overflow-wrap: anywhere;
    font-family: var(--font-mono);
    font-size: 0.88rem;
  }

  .same {
    margin: 0 0 var(--space-2);
  }

  .versions {
    display: grid;
    gap: var(--space-3);
  }

  @media (min-width: 45rem) {
    .versions {
      grid-template-columns: 1fr 1fr;
    }
  }

  h4 {
    margin: 0 0 var(--space-1);
    font-size: 0.9rem;
  }

  pre {
    margin: 0;
    max-block-size: 16rem;
    overflow: auto;
    padding: var(--space-2) var(--space-3);
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 0.8rem;
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
</style>
