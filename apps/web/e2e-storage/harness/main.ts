// The harness page: starts probe workers and exposes `window.harness` for
// the Playwright test of the SAH pool's exclusive access
// (apps/web/e2e-storage/sah-pool.spec.ts).

import type { ProbeRequest } from './worker.ts';

type Call = (request: ProbeRequest) => Promise<unknown>;

function start(): { call: Call; stop(): void } {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  let next = 1;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  worker.onmessage = (
    event: MessageEvent<{ id: number; ok: boolean; value?: unknown; error?: string }>,
  ) => {
    const p = pending.get(event.data.id);
    if (!p) return;
    pending.delete(event.data.id);
    if (event.data.ok) p.resolve(event.data.value);
    else p.reject(new Error(event.data.error));
  };
  worker.onerror = (event) => {
    for (const p of pending.values()) p.reject(new Error(`worker error: ${event.message}`));
    pending.clear();
  };
  return {
    call: (request) =>
      new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, request });
      }),
    stop: () => worker.terminate(),
  };
}

const probes: ReturnType<typeof start>[] = [];

const harness = {
  /** Starts a probe worker; returns its index. */
  probe: () => probes.push(start()) - 1,
  probeCall: (i: number, request: ProbeRequest) =>
    (probes[i] as ReturnType<typeof start>).call(request),
  stopProbe: (i: number) => probes[i]?.stop(),
};

(globalThis as { harness?: typeof harness }).harness = harness;
const status = document.getElementById('status');
if (status) status.textContent = 'ready';
