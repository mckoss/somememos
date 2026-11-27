<script lang="ts">
  // Sync settings (More → Sync): connecting this device to the server the
  // app came from, and, once connected, where it stands. Not connected is a
  // normal state: the app works fully without a server, and this panel is the
  // only place that mentions sync until the person connects.
  //
  // The token is typed into a password field and handed to the brain's
  // worker, which keeps it; the field is cleared once connected and only its
  // last four characters are ever shown again.
  import type { ConnectPlan, RemoteBrain, ServerAvailability, SyncView } from '#lib/brain/host.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';
  import SyncConflicts from './SyncConflicts.svelte';
  import { changed, host } from '#lib/ui/brain.svelte.ts';
  import { plural, relativeTime } from '#lib/ui/format.ts';
  import { INDICATOR_LABEL, syncState } from '#lib/ui/sync.svelte.ts';
  import { brainIdFromName, describePlan, maskToken } from '#lib/sync/connect-plan.ts';

  const view = $derived(syncState.view);

  // --- Not connected: the connect flow ------------------------------------------

  type Step = 'token' | 'choose' | 'confirm';
  let availability = $state<ServerAvailability | null>(null);
  let step = $state<Step>('token');
  let token = $state('');
  let brains = $state<RemoteBrain[]>([]);
  /** The chosen brain id, or '' for a new one. */
  let choice = $state('');
  let newName = $state('');
  let plan = $state<ConnectPlan | null>(null);
  let working = $state(false);
  let error = $state<string | null>(null);

  const newId = $derived(brainIdFromName(newName));
  const described = $derived(plan ? describePlan(plan) : null);

  let probed = false;
  $effect(() => {
    if (!view || view.connected || probed) return;
    probed = true;
    void (async () => {
      try {
        availability = await (await host()).sync.probe();
      } catch (e) {
        availability = {
          available: false,
          reason: 'unreachable',
          message: e instanceof Error ? e.message : String(e),
        };
      }
    })();
  });

  function message(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  async function listBrains() {
    error = null;
    working = true;
    try {
      brains = await (await host()).sync.listBrains(token.trim());
      choice = brains[0]?.id ?? '';
      if (brains.length === 0 && newName === '') newName = 'main';
      step = 'choose';
    } catch (e) {
      error = message(e);
    } finally {
      working = false;
    }
  }

  const request = () => ({
    token: token.trim(),
    brainId: choice === '' ? newId : choice,
    create: choice === '',
  });

  async function makePlan() {
    error = null;
    working = true;
    try {
      plan = await (await host()).sync.plan(request());
      step = 'confirm';
    } catch (e) {
      error = message(e);
    } finally {
      working = false;
    }
  }

  async function connect() {
    if (!plan) return;
    error = null;
    working = true;
    try {
      const h = await host();
      syncState.view = await h.sync.connect(request(), plan.needsConfirmation);
      syncState.revision += 1;
      token = '';
      plan = null;
      step = 'token';
      await changed();
    } catch (e) {
      error = message(e);
    } finally {
      working = false;
    }
  }

  function back() {
    error = null;
    if (step === 'confirm') step = 'choose';
    else if (step === 'choose') step = 'token';
  }

  // --- Connected -----------------------------------------------------------------

  let syncing = $state(false);
  let actionError = $state<string | null>(null);

  async function syncNow() {
    syncing = true;
    actionError = null;
    try {
      syncState.view = await (await host()).sync.syncNow();
      syncState.revision += 1;
    } catch (e) {
      actionError = message(e);
    } finally {
      syncing = false;
    }
  }

  let newToken = $state('');
  async function saveToken() {
    actionError = null;
    working = true;
    try {
      syncState.view = await (await host()).sync.setToken(newToken.trim());
      syncState.revision += 1;
      newToken = '';
    } catch (e) {
      actionError = message(e);
    } finally {
      working = false;
    }
  }

  let disconnectOpen = $state(false);
  async function disconnect(close: () => void) {
    try {
      syncState.view = await (await host()).sync.disconnect();
      syncState.revision += 1;
      probed = false;
      close();
    } catch (e) {
      actionError = message(e);
      close();
    }
  }

  let startOverOpen = $state(false);
  async function startOver(close: () => void) {
    close();
    syncing = true;
    try {
      syncState.view = await (await host()).sync.startOver();
      syncState.revision += 1;
      await changed();
    } catch (e) {
      actionError = message(e);
    } finally {
      syncing = false;
    }
  }

  function pendingText(v: SyncView): string {
    const parts: string[] = [];
    if (v.pending.notes > 0) parts.push(plural(v.pending.notes, 'note'));
    if (v.pending.changes > 0) parts.push(plural(v.pending.changes, 'change record'));
    if (v.pending.events > 0) parts.push(plural(v.pending.events, 'activity event'));
    return parts.length === 0 ? 'Nothing' : parts.join(', ');
  }

  function progressText(v: SyncView): string {
    const p = v.progress;
    if (!p) return 'Syncing…';
    if (p.toSend > 0 && p.sent < p.toSend) return `Sending notes: ${p.sent} of ${p.toSend}`;
    if (p.toReceive !== null && p.toReceive > 0)
      return `Receiving changes: ${Math.min(p.received, p.toReceive)} of ${p.toReceive}`;
    if (p.received > 0) return `Receiving changes: ${p.received} so far`;
    return 'Talking to the server…';
  }

  function progressValue(v: SyncView): { value: number; max: number } | null {
    const p = v.progress;
    if (!p) return null;
    if (p.toSend > 0 && p.sent < p.toSend) return { value: p.sent, max: p.toSend };
    if (p.toReceive !== null && p.toReceive > 0)
      return { value: Math.min(p.received, p.toReceive), max: p.toReceive };
    return null;
  }

  // Refresh "x min ago" now and then.
  let clock = $state(Date.now() / 1000);
  $effect(() => {
    const t = setInterval(() => (clock = Date.now() / 1000), 30_000);
    return () => clearInterval(t);
  });
</script>

{#if !view}
  <p class="hint">Checking…</p>
{:else if view.connected}
  <div class="status" data-testid="sync-status" data-state={view.indicator}>
    <p class="headline {view.indicator}">
      <strong data-testid="sync-headline">{INDICATOR_LABEL[view.indicator]}</strong>
      <span class="hint">
        with <span class="mono">{view.brainId}</span> on this server
      </span>
    </p>

    {#if view.running}
      {@const pv = progressValue(view)}
      <div class="progress" data-testid="sync-progress">
        <span>{progressText(view)}</span>
        {#if pv}
          <progress value={pv.value} max={pv.max}></progress>
        {:else}
          <progress></progress>
        {/if}
      </div>
    {/if}

    {#if view.problem}
      <p class="notice {view.problem.kind === 'offline' ? '' : 'error'}" data-testid="sync-problem">
        {view.problem.message}
      </p>
    {/if}

    {#if view.problem?.kind === 'auth'}
      <form
        class="token-fix"
        onsubmit={(e) => {
          e.preventDefault();
          void saveToken();
        }}
      >
        <div class="field">
          <label for="sync-new-token">New access token</label>
          <input
            id="sync-new-token"
            type="password"
            autocomplete="off"
            spellcheck="false"
            bind:value={newToken}
            data-testid="sync-new-token"
          />
        </div>
        <button type="submit" class="primary" disabled={working || newToken.trim() === ''}>
          Save token
        </button>
      </form>
    {/if}

    {#if view.problem?.kind === 'reset'}
      <div class="row">
        <button type="button" onclick={() => (startOverOpen = true)}>Compare again…</button>
      </div>
    {/if}

    <dl class="facts">
      <div>
        <dt>Last synced</dt>
        <dd data-testid="sync-last">
          {view.lastSyncAt ? relativeTime(view.lastSyncAt, clock) : 'not yet'}
        </dd>
      </div>
      <div>
        <dt>Waiting to be sent</dt>
        <dd data-testid="sync-pending">{pendingText(view)}</dd>
      </div>
      <div>
        <dt>Access token</dt>
        <dd class="mono" data-testid="sync-token-hint">{maskToken(view.tokenHint)}</dd>
      </div>
      <div>
        <dt>Automatic sync</dt>
        <dd>
          {#if !view.autoSync}
            Stopped until the problem above is fixed
          {:else if view.offline}
            Waiting for the connection
          {:else if view.nextAttemptAt && view.failures > 0}
            Trying again {view.nextAttemptAt - clock * 1000 < 60_000
              ? 'in a moment'
              : `in about ${Math.round((view.nextAttemptAt - clock * 1000) / 60_000)} min`}
          {:else}
            On: after each change, and every few minutes
          {/if}
        </dd>
      </div>
    </dl>
    {#if view.lastRun && view.lastRun.pushed.edits > 0}
      <p class="hint" data-testid="sync-last-run">
        The last sync sent {plural(view.lastRun.pushed.edits, 'note change')}.
      </p>
    {/if}

    <div class="row">
      <button
        type="button"
        class="primary"
        onclick={syncNow}
        disabled={syncing || view.running}
        data-testid="sync-now"
      >
        <span class:spin={view.running}><Icon name="sync" size={18} /></span>
        {view.running ? 'Syncing…' : 'Sync now'}
      </button>
      <button type="button" onclick={() => (disconnectOpen = true)}>Disconnect…</button>
    </div>
    {#if actionError}<p class="notice error" role="alert">{actionError}</p>{/if}
  </div>

  <SyncConflicts />
{:else}
  <p>
    Sync keeps this device and the server in step: your notes, and the activity behind Hot, Trending
    and Neglected. It is optional. Without it, everything works on this device alone.
  </p>
  {#if view.previousBrainId}
    <p class="hint">
      This device last synced with <span class="mono">{view.previousBrainId}</span>. Its notes are
      still here.
    </p>
  {/if}

  {#if !availability}
    <p class="hint">Checking whether this server offers sync…</p>
  {:else if !availability.available}
    <p class="notice" data-testid="sync-unavailable">{availability.message}</p>
  {:else if step === 'token'}
    <form
      class="connect"
      onsubmit={(e) => {
        e.preventDefault();
        void listBrains();
      }}
    >
      <div class="field">
        <label for="sync-token">Access token</label>
        <input
          id="sync-token"
          type="password"
          autocomplete="off"
          spellcheck="false"
          bind:value={token}
          data-testid="sync-token"
        />
        <span class="hint">
          From whoever runs this server. It stays on this device, in the app’s own storage.
        </span>
      </div>
      <div class="row">
        <button type="submit" class="primary" disabled={working || token.trim() === ''}>
          {working ? 'Checking…' : 'Continue'}
        </button>
      </div>
    </form>
  {:else if step === 'choose'}
    <form
      class="connect"
      onsubmit={(e) => {
        e.preventDefault();
        void makePlan();
      }}
    >
      <fieldset class="brains">
        <legend>Which brain should this device sync with?</legend>
        {#each brains as b (b.id)}
          <label class="brain">
            <input type="radio" name="brain" value={b.id} bind:group={choice} />
            <span>
              <span class="mono">{b.id}</span>
              <span class="hint">
                {b.mutation === 0 ? 'empty' : plural(b.mutation, 'change')} · created {relativeTime(
                  b.createdAt,
                )}
              </span>
            </span>
          </label>
        {/each}
        <label class="brain">
          <input type="radio" name="brain" value="" bind:group={choice} />
          <span>A new brain on the server</span>
        </label>
        {#if choice === ''}
          <div class="field new-name">
            <label for="sync-new-name">Name</label>
            <input
              id="sync-new-name"
              type="text"
              autocomplete="off"
              bind:value={newName}
              data-testid="sync-new-name"
            />
            <span class="hint">
              {newId ? `Saved as “${newId}”.` : 'Letters and digits; spaces become dashes.'}
            </span>
          </div>
        {/if}
      </fieldset>
      <div class="row">
        <button type="button" onclick={back}>Back</button>
        <button type="submit" class="primary" disabled={working || (choice === '' && !newId)}>
          {working ? 'Checking…' : 'Next'}
        </button>
      </div>
    </form>
  {:else if step === 'confirm' && plan && described}
    <div class="plan" data-testid="sync-plan" data-kind={plan.kind}>
      <p class="plan-title"><strong>{described.title}</strong></p>
      {#if described.details.length > 0}
        <ul>
          {#each described.details as d (d)}<li>{d}</li>{/each}
        </ul>
      {/if}
      {#if plan.needsConfirmation}
        <p class="hint">Nothing changes until you confirm.</p>
      {/if}
      <div class="row">
        <button type="button" onclick={back} disabled={working}>Back</button>
        <button
          type="button"
          class="primary"
          onclick={connect}
          disabled={working}
          data-testid="sync-confirm"
        >
          {working
            ? 'Connecting…'
            : plan.kind === 'merge'
              ? 'Combine and sync'
              : plan.needsConfirmation
                ? 'Yes, connect'
                : 'Connect'}
        </button>
      </div>
    </div>
  {/if}
  {#if error}<p class="notice error" role="alert" data-testid="sync-error">{error}</p>{/if}
{/if}

<Dialog bind:open={disconnectOpen} title="Disconnect this device?">
  <p>
    This device stops syncing and forgets its access token. Your notes and activity stay here, and
    nothing is deleted from the server.
  </p>
  {#if view && view.pending.notes + view.pending.changes > 0}
    <p class="notice">
      {pendingText(view)} haven’t reached the server yet. They stay on this device and are sent if you
      connect to the same brain again.
    </p>
  {/if}
  {#snippet actions(close)}
    <button type="button" onclick={close}>Cancel</button>
    <button type="button" class="danger" onclick={() => disconnect(close)}>Disconnect</button>
  {/snippet}
</Dialog>

<Dialog bind:open={startOverOpen} title="Compare this device with the server again?">
  <p>
    The server no longer has everything this device synced. This sends every note on this device
    again and takes the server’s notes. Nothing is deleted: a note that differs is kept twice, as a
    conflict copy for you to review.
  </p>
  {#snippet actions(close)}
    <button type="button" onclick={close}>Cancel</button>
    <button type="button" class="primary" onclick={() => startOver(close)}>Compare again</button>
  {/snippet}
</Dialog>

<style>
  .mono {
    font-family: var(--font-mono);
    font-size: 0.9em;
    overflow-wrap: anywhere;
  }

  .headline {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 var(--space-2);
    margin: 0 0 var(--space-3);
    font-size: 1.05rem;
  }

  .headline.attention strong {
    color: var(--danger);
  }

  .headline.synced strong {
    color: var(--up);
  }

  .progress {
    display: grid;
    gap: var(--space-1);
    margin: 0 0 var(--space-3);
    font-size: 0.9rem;
  }

  progress {
    inline-size: 100%;
    block-size: 0.6rem;
    accent-color: var(--accent);
  }

  .notice {
    margin: 0 0 var(--space-3);
    font-size: 0.9rem;
  }

  .token-fix {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: var(--space-2);
    margin: 0 0 var(--space-3);
  }

  .token-fix .field {
    flex: 1 1 14rem;
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
    gap: var(--space-2);
    margin: 0 0 var(--space-3);
  }

  .facts div {
    padding: var(--space-2) var(--space-3);
    background: var(--surface-2);
    border-radius: var(--radius-sm);
  }

  .facts dt {
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  .facts dd {
    margin: 0;
    font-size: 0.92rem;
  }

  .connect {
    display: grid;
    gap: var(--space-3);
    max-inline-size: 30rem;
  }

  .brains {
    border: 0;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-1);
  }

  .brains legend {
    font-weight: 600;
    margin-bottom: var(--space-2);
  }

  .brain {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-block-size: var(--target);
    font-weight: 400;
  }

  .brain > span {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--space-2);
    align-items: baseline;
  }

  .new-name {
    margin: var(--space-1) 0 0 1.6rem;
  }

  .plan {
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--surface-2);
  }

  .plan-title {
    margin: 0 0 var(--space-2);
  }

  .plan ul {
    margin: 0 0 var(--space-3);
    padding-inline-start: 1.2rem;
    font-size: 0.92rem;
  }

  .plan li + li {
    margin-top: var(--space-1);
  }

  .spin {
    display: inline-flex;
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
</style>
