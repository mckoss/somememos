// The harness page: starts harness workers and exposes `window.harness` for
// the Playwright tests (apps/web/e2e-storage/conformance.spec.ts).

import type { HarnessRequest } from './worker.ts';

type Call = (request: HarnessRequest) => Promise<unknown>;

function start(role: 'suites' | 'probe'): { call: Call; stop(): void } {
  // The role travels in the worker's name (Vite needs the URL literal).
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: role,
  });
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

let suites: ReturnType<typeof start> | undefined;
const probes: ReturnType<typeof start>[] = [];

const harness = {
  list: () => (suites ??= start('suites')).call({ cmd: 'list' }),
  run: (id: number) => (suites ??= start('suites')).call({ cmd: 'run', id }),
  info: () => (suites ??= start('suites')).call({ cmd: 'info' }),
  /** Starts a probe worker; returns its index. */
  probe: () => probes.push(start('probe')) - 1,
  probeCall: (i: number, request: HarnessRequest) =>
    (probes[i] as ReturnType<typeof start>).call(request),
  stopProbe: (i: number) => probes[i]?.stop(),
};

(globalThis as { harness?: typeof harness }).harness = harness;
const status = document.getElementById('status');
if (status) status.textContent = 'ready';
