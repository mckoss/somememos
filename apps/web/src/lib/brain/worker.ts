// The brain's dedicated worker: SQLite WebAssembly, the stores and the engine
// (./brain-service.ts), behind the request/response messages of
// ./protocol.ts. The page side is ./worker-client.ts. Only the tab that owns
// the brain runs this worker (./open.ts).

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { openBrainService, type BrainService } from './brain-service.ts';
import { StorageBusyError, installSahPool, memoryProvider, opfsProvider } from './databases.ts';
import {
  memoryReason,
  toWireError,
  type OpenRequest,
  type RequestMessage,
  type WorkerMessage,
} from './protocol.ts';

interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: WorkerMessage): void;
}
const scope = self as unknown as WorkerScope;

let service: Promise<BrainService> | undefined;

async function open(request: OpenRequest): Promise<BrainService> {
  const sqlite3 = await sqlite3InitModule();
  if (request.storage === 'memory') {
    return openBrainService(
      memoryProvider(sqlite3, request.reason ?? memoryReason('the page found no OPFS')),
    );
  }
  let provider;
  try {
    provider = opfsProvider(sqlite3, await installSahPool(sqlite3));
  } catch (error) {
    // Held by another tab: an error, never a silent second copy in memory.
    if (error instanceof StorageBusyError) throw error;
    provider = memoryProvider(sqlite3, memoryReason(error));
  }
  return openBrainService(provider);
}

async function respond(message: RequestMessage): Promise<void> {
  const { id } = message;
  try {
    let value: unknown;
    if (message.target === 'host' && message.method === 'open') {
      if (service) throw new Error('the brain is already open in this worker');
      service = open((message.args[0] ?? {}) as OpenRequest);
      service.catch(() => (service = undefined));
      const s = await service;
      value = { storage: s.storage, config: s.config };
    } else {
      if (!service) throw new Error('the brain is not open');
      value = await (await service).handle(message.target, message.method, message.args);
    }
    scope.postMessage({ type: 'response', id, ok: true, value });
  } catch (error) {
    scope.postMessage({ type: 'response', id, ok: false, error: toWireError(error) });
  }
}

scope.onmessage = (event: MessageEvent) => {
  const message = event.data as RequestMessage | null;
  if (message?.type === 'request') void respond(message);
};
