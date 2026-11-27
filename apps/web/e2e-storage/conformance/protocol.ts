// Messages between ./opfs.test.ts (the page) and ./suites.worker.ts.

import type { SerializedConfig, TestError } from 'vitest';

export type { TestError };

export type WorkerRequest =
  { cmd: 'collect'; config: SerializedConfig } | { cmd: 'run' } | { cmd: 'info' };

/** One test the worker collected, under its suites' names. */
export interface Listed {
  readonly id: string;
  readonly path: readonly string[];
  readonly name: string;
  /** 'run', or 'skip' / 'todo' / 'only' as the suite declared it. */
  readonly mode: string;
}

/** How one test ended in the worker, as Vitest's runner recorded it. */
export interface Outcome {
  readonly id: string;
  readonly state: string;
  readonly ms: number;
  readonly errors: readonly TestError[];
}

export interface Collected {
  readonly tests: Listed[];
  readonly errors: TestError[];
}

export interface Ran {
  readonly errors: TestError[];
}

export interface Info {
  readonly sqlite: string;
  readonly vfs: string;
  readonly dedicatedWorker: boolean;
}

/** A reply to request `id`: an outcome while running, then the final answer. */
export type WorkerReply =
  | { readonly result: Outcome }
  | { readonly done: true; readonly value?: unknown; readonly error?: string };
