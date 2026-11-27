// The page's side of the worker messages (./protocol.ts): a `Transport` that
// sends requests to a worker and matches its responses.

import {
  fromWireError,
  type RequestMessage,
  type Target,
  type WorkerEventMessage,
  type WorkerMessage,
} from './protocol.ts';

/** Sends a request and resolves with its response's value (or rejects with its error). */
export interface Transport {
  call(target: Target, method: string, args: readonly unknown[]): Promise<unknown>;
  close(): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export function workerTransport(
  worker: Worker,
  onEvent: (event: WorkerEventMessage) => void = () => undefined,
): Transport {
  let nextId = 1;
  let closed: Error | undefined;
  const pending = new Map<number, Pending>();

  const failAll = (error: Error): void => {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };

  worker.addEventListener('message', (event: MessageEvent<WorkerMessage>) => {
    const message = event.data;
    if (message?.type === 'event') {
      onEvent(message);
      return;
    }
    if (message?.type !== 'response') return;
    const p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id);
    if (message.ok) p.resolve(message.value);
    else p.reject(fromWireError(message.error));
  });
  worker.addEventListener('error', (event: ErrorEvent) => {
    // The worker script failed to load, or threw outside any request.
    event.preventDefault();
    closed = new Error(`the brain worker failed: ${event.message || 'it could not start'}`);
    failAll(closed);
  });
  worker.addEventListener('messageerror', () => {
    failAll(new Error('a message from the brain worker could not be read'));
  });

  return {
    call(target, method, args) {
      if (closed) return Promise.reject(closed);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const message: RequestMessage = { type: 'request', id, target, method, args };
        try {
          worker.postMessage(message);
        } catch (error) {
          // Arguments that can't be cloned (a function, a DOM object).
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    close() {
      closed = new Error('the brain was closed');
      failAll(closed);
      worker.terminate();
    },
  };
}
