// The shared conformance suites and the driver tests on the browser SQLite
// driver on OPFS, under Vitest's browser mode (vitest.storage.config.ts).
//
// The SAH pool's sync access handles exist only in dedicated workers, so the
// suites run in one (./suites.worker.ts) with Vitest's own runner and
// `expect`. This file, in the page, mirrors each of the worker's tests as a
// test of its own and passes on how it ended; nothing is asserted here that
// the worker's real Vitest did not decide.

import { describe, expect, it } from 'vitest';
import { server } from 'vitest/browser';
import type {
  Collected,
  Info,
  Listed,
  Outcome,
  Ran,
  WorkerReply,
  WorkerRequest,
} from './protocol.ts';

/** Only a guard: each test's own timeout applies in the worker. */
const WAIT_MS = 600_000;

const worker = new Worker(new URL('./suites.worker.ts', import.meta.url), {
  type: 'module',
  name: 'conformance',
});
let nextId = 1;
const calls = new Map<
  number,
  { resolve(v: unknown): void; reject(e: Error): void; onResult?(o: Outcome): void }
>();
worker.onmessage = ({ data }: MessageEvent<WorkerReply & { id: number }>) => {
  const call = calls.get(data.id);
  if (!call) return;
  if ('result' in data) return call.onResult?.(data.result);
  calls.delete(data.id);
  if (data.error) call.reject(new Error(data.error));
  else call.resolve(data.value);
};
worker.onerror = (event) => {
  for (const call of calls.values()) call.reject(new Error(`the worker failed: ${event.message}`));
  calls.clear();
};
function call<T>(request: WorkerRequest, onResult?: (o: Outcome) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextId++;
    calls.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
      ...(onResult ? { onResult } : {}),
    });
    worker.postMessage({ id, request });
  });
}

const collected = await call<Collected>({ cmd: 'collect', config: server.config });

// Each mirrored test waits for its outcome; the worker runs all of them once.
interface Pending {
  readonly promise: Promise<Outcome>;
  resolve(o: Outcome): void;
  reject(e: Error): void;
}
const outcomes = new Map<string, Pending>();
const outcome = (id: string): Pending => {
  let entry = outcomes.get(id);
  if (!entry) {
    const parts: Partial<Pending> = {};
    const promise = new Promise<Outcome>((resolve, reject) =>
      Object.assign(parts, { resolve, reject }),
    );
    entry = { ...(parts as Pending), promise };
    outcomes.set(id, entry);
  }
  return entry;
};
let run: Promise<Ran> | undefined;
const startRun = (): Promise<Ran> =>
  (run ??= call<Ran>({ cmd: 'run' }, (o) => outcome(o.id).resolve(o)).then(
    (ran) => {
      for (const t of collected.tests) {
        outcome(t.id).resolve({ id: t.id, state: 'missing', ms: 0, errors: ran.errors });
      }
      return ran;
    },
    (error: Error) => {
      for (const t of collected.tests) outcome(t.id).reject(error);
      throw error;
    },
  ));

/** The worker's error for a failed test, as this side's failure. */
function failure(o: Outcome): Error {
  const [first] = o.errors;
  const text = o.errors.length
    ? o.errors.map((e) => `${e.name ?? 'Error'}: ${e.message}${e.diff ? `\n\n${e.diff}` : ''}`)
    : [`the test ended as "${o.state}" in the worker`];
  const error = new Error(text.join('\n\n'));
  if (first?.stack)
    error.stack = `${error.message}\n${first.stack.split('\n').slice(1).join('\n')}`;
  return error;
}

function mirror(test: Listed): void {
  const define = test.mode === 'skip' || test.mode === 'todo' ? it.skip : it;
  define(
    test.name,
    async ({ skip }) => {
      void startRun();
      const o = await outcome(test.id).promise;
      if (o.state === 'skip') skip();
      if (o.state !== 'pass') throw failure(o);
    },
    WAIT_MS,
  );
}

/** Recreates the worker's suites around their tests, in run order. */
function mirrorAll(tests: readonly Listed[], depth = 0): void {
  for (let i = 0; i < tests.length;) {
    const name = tests[i]?.path[depth];
    if (name === undefined) {
      mirror(tests[i] as Listed);
      i++;
      continue;
    }
    let j = i;
    while (j < tests.length && tests[j]?.path[depth] === name) j++;
    const group = tests.slice(i, j);
    describe(name, () => mirrorAll(group, depth + 1));
    i = j;
  }
}

it('runs in a dedicated worker, on OPFS through opfs-sahpool', async () => {
  const info = await call<Info>({ cmd: 'info' });
  console.log(`SQLite ${info.sqlite}, VFS ${info.vfs}`);
  expect(info).toMatchObject({ dedicatedWorker: true, vfs: 'opfs-sahpool' });
});

it('collects the driver, storage and engine suites', () => {
  expect(collected.errors.map((e) => e.message)).toEqual([]);
  const top = new Set(collected.tests.map((t) => t.path[0]));
  expect([...top].sort()).toEqual([
    'engine conformance: sqlite-wasm on OPFS, content table',
    'sqlite driver: oo1 on OPFS (opfs-sahpool)',
    'storage conformance: sqlite-wasm on OPFS (opfs-sahpool)',
  ]);
});

mirrorAll(collected.tests);

it(
  'finishes the run with no errors outside the tests',
  async () => {
    const ran = await startRun();
    expect(ran.errors.map((e) => e.message)).toEqual([]);
  },
  WAIT_MS,
);
