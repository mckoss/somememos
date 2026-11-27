// A small stand-in for the parts of Vitest that the shared conformance suites
// use (`describe`, `describe.each`, `it`, `beforeEach`, `afterEach`,
// `expect`), so the suites run unchanged inside a browser worker. The harness
// build aliases `vitest` to this module. Tests register as they would under
// Vitest; `listTests()` names them and `runTest(id)` runs one with its hooks.
//
// The matchers follow Vitest's semantics closely enough for the suites:
// `toEqual` ignores undefined properties and object types, `toStrictEqual`
// doesn't, `toMatchObject` matches a subset, numbers compare with Object.is.

type Awaitable<T> = T | Promise<T>;
type Hook = () => Awaitable<unknown>;

interface Suite {
  readonly name: string;
  readonly parent: Suite | null;
  readonly beforeEach: Hook[];
  readonly afterEach: Hook[];
}

interface TestCase {
  readonly id: number;
  readonly name: string;
  readonly suite: Suite;
  readonly fn: () => Awaitable<unknown>;
  readonly timeout: number;
}

export interface TestResult {
  readonly id: number;
  readonly name: string;
  readonly status: 'passed' | 'failed';
  readonly ms: number;
  readonly error?: string;
}

const DEFAULT_TIMEOUT = 60_000;
const root: Suite = { name: '', parent: null, beforeEach: [], afterEach: [] };
let current: Suite = root;
const tests: TestCase[] = [];

function fullName(suite: Suite, name: string): string {
  const parts = [name];
  for (let s: Suite | null = suite; s && s !== root; s = s.parent) parts.unshift(s.name);
  return parts.join(' > ');
}

function format(template: string, args: readonly unknown[]): string {
  let i = 0;
  return template.replace(/%[sdijo%]/g, (m) => {
    if (m === '%%') return '%';
    const v = args[i++];
    return m === '%j' || m === '%o' ? JSON.stringify(v) : String(v);
  });
}

type DescribeFn = ((name: string, fn: () => void) => void) & {
  each<T>(table: readonly T[]): (name: string, fn: (row: T) => void) => void;
};

export const describe: DescribeFn = Object.assign(
  (name: string, fn: () => void): void => {
    const suite: Suite = { name, parent: current, beforeEach: [], afterEach: [] };
    const outer = current;
    current = suite;
    try {
      fn();
    } finally {
      current = outer;
    }
  },
  {
    each<T>(table: readonly T[]) {
      return (name: string, fn: (row: T) => void): void => {
        for (const row of table) {
          const args = Array.isArray(row) ? row : [row];
          describe(format(name, args), () => fn(row));
        }
      };
    },
  },
);

type TestFn = () => Awaitable<unknown>;
type TestOptions = { timeout?: number } | number;

export function it(name: string, a: TestFn | TestOptions, b?: TestFn | TestOptions): void {
  const fn = (typeof a === 'function' ? a : b) as TestFn;
  const opts = typeof a === 'function' ? b : a;
  const timeout =
    typeof opts === 'number' ? opts : (opts as { timeout?: number } | undefined)?.timeout;
  tests.push({
    id: tests.length,
    name: fullName(current, name),
    suite: current,
    fn,
    timeout: timeout ?? DEFAULT_TIMEOUT,
  });
}
export const test = it;

export function beforeEach(fn: Hook): void {
  current.beforeEach.push(fn);
}
export function afterEach(fn: Hook): void {
  current.afterEach.push(fn);
}

export function listTests(): { id: number; name: string }[] {
  return tests.map((t) => ({ id: t.id, name: t.name }));
}

function chain(suite: Suite): Suite[] {
  const out: Suite[] = [];
  for (let s: Suite | null = suite; s; s = s.parent) out.unshift(s);
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]);
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}${error.stack ? `\n${error.stack.split('\n').slice(1, 6).join('\n')}` : ''}`;
  }
  return String(error);
}

export async function runTest(id: number): Promise<TestResult> {
  const t = tests[id];
  if (!t) throw new Error(`no test ${id}`);
  const suites = chain(t.suite);
  const started = performance.now();
  let failure: unknown;
  const ran: Suite[] = [];
  try {
    for (const s of suites) {
      ran.push(s);
      for (const hook of s.beforeEach)
        await withTimeout(Promise.resolve(hook()), t.timeout, 'beforeEach');
    }
    await withTimeout(Promise.resolve().then(t.fn), t.timeout, 'test');
  } catch (error) {
    failure = error;
  }
  for (const s of ran.reverse()) {
    for (const hook of s.afterEach) {
      try {
        await withTimeout(Promise.resolve(hook()), t.timeout, 'afterEach');
      } catch (error) {
        failure ??= error;
      }
    }
  }
  const ms = Math.round(performance.now() - started);
  return failure === undefined
    ? { id, name: t.name, status: 'passed', ms }
    : { id, name: t.name, status: 'failed', ms, error: describeError(failure) };
}

// ---------------------------------------------------------------------------
// expect

export class AssertionError extends Error {
  override name = 'AssertionError';
}

function show(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v: unknown) =>
      typeof v === 'bigint'
        ? `${v}n`
        : v instanceof Map
          ? { Map: [...v] }
          : v instanceof Set
            ? { Set: [...v] }
            : v === undefined
              ? '<undefined>'
              : v,
    ).slice(0, 2000);
  } catch {
    return String(value);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object';
}

function equals(
  a: unknown,
  b: unknown,
  strict: boolean,
  seen = new WeakMap<object, unknown>(),
): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a === 'bigint' || typeof b === 'bigint') return a === b;
  if (!isObject(a) || !isObject(b)) return false;
  if (seen.get(a) === b) return true;
  seen.set(a, b);
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (a instanceof RegExp || b instanceof RegExp) return String(a) === String(b);
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return false;
    const x = a as unknown as ArrayLike<unknown>;
    const y = b as unknown as ArrayLike<unknown>;
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) return false;
    return true;
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !equals(v, b.get(k), strict, seen)) return false;
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false;
    for (const v of a) {
      if (b.has(v)) continue;
      if (![...b].some((w) => equals(v, w, strict, seen))) return false;
    }
    return true;
  }
  if (a instanceof Error && b instanceof Error) {
    if (a.message !== b.message || a.name !== b.name) return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (strict && i in a !== i in b) return false;
      if (!equals(a[i], b[i], strict, seen)) return false;
    }
    return true;
  }
  const keys = (o: Record<string, unknown>) =>
    Object.keys(o).filter((k) => strict || o[k] !== undefined);
  const ka = keys(a);
  const kb = keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!equals(a[k], b[k], strict, seen)) return false;
  }
  return true;
}

function matchesObject(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((e, i) => matchesObject(actual[i], e))
    );
  }
  if (isObject(expected) && Object.getPrototypeOf(expected) === Object.prototype) {
    if (!isObject(actual)) return false;
    return Object.keys(expected).every(
      (k) => k in actual && matchesObject((actual as Record<string, unknown>)[k], expected[k]),
    );
  }
  return equals(actual, expected, false);
}

type Ctor = abstract new (...args: never[]) => unknown;

function thrownMatches(error: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof expected === 'string') return message.includes(expected);
  if (expected instanceof RegExp) return expected.test(message);
  if (typeof expected === 'function') return error instanceof (expected as Ctor);
  if (expected instanceof Error) return message === expected.message;
  return matchesObject(error, expected);
}

interface Matchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toStrictEqual(expected: unknown): void;
  toMatchObject(expected: unknown): void;
  toContain(expected: unknown): void;
  toContainEqual(expected: unknown): void;
  toHaveLength(n: number): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeTypeOf(type: string): void;
  toBeInstanceOf(ctor: Ctor): void;
  toBeGreaterThan(n: number | bigint): void;
  toBeGreaterThanOrEqual(n: number | bigint): void;
  toBeLessThan(n: number | bigint): void;
  toBeLessThanOrEqual(n: number | bigint): void;
  toBeCloseTo(n: number, digits?: number): void;
  toMatch(expected: string | RegExp): void;
  toThrow(expected?: unknown): void;
}

type Check = [pass: boolean, message: string];

function checks(actual: unknown): Record<keyof Matchers, (...args: never[]) => Check> {
  return {
    toBe: (e: unknown) => [Object.is(actual, e), `expected ${show(actual)} to be ${show(e)}`],
    toEqual: (e: unknown) => [
      equals(actual, e, false),
      `expected ${show(actual)} to equal ${show(e)}`,
    ],
    toStrictEqual: (e: unknown) => [
      equals(actual, e, true),
      `expected ${show(actual)} to strictly equal ${show(e)}`,
    ],
    toMatchObject: (e: unknown) => [
      matchesObject(actual, e),
      `expected ${show(actual)} to match object ${show(e)}`,
    ],
    toContain: (e: unknown) => [
      typeof actual === 'string'
        ? actual.includes(String(e))
        : Array.isArray(actual) || actual instanceof Set
          ? [...(actual as Iterable<unknown>)].includes(e)
          : false,
      `expected ${show(actual)} to contain ${show(e)}`,
    ],
    toContainEqual: (e: unknown) => [
      Array.isArray(actual) && actual.some((a) => equals(a, e, false)),
      `expected ${show(actual)} to contain an item equal to ${show(e)}`,
    ],
    toHaveLength: (n: number) => [
      (actual as { length?: unknown } | null)?.length === n,
      `expected length ${n}, got ${show((actual as { length?: unknown } | null)?.length)}`,
    ],
    toBeNull: () => [actual === null, `expected ${show(actual)} to be null`],
    toBeUndefined: () => [actual === undefined, `expected ${show(actual)} to be undefined`],
    toBeDefined: () => [actual !== undefined, `expected a defined value`],
    toBeTruthy: () => [Boolean(actual), `expected ${show(actual)} to be truthy`],
    toBeFalsy: () => [!actual, `expected ${show(actual)} to be falsy`],
    toBeTypeOf: (type: string) => [
      typeof actual === type,
      `expected ${show(actual)} to be a ${type}`,
    ],
    toBeInstanceOf: (ctor: Ctor) => [
      actual instanceof ctor,
      `expected ${show(actual)} (${(actual as { name?: string } | null)?.name ?? typeof actual}) to be an instance of ${ctor.name}`,
    ],
    toBeGreaterThan: (n: number | bigint) => [
      (actual as number) > n,
      `expected ${show(actual)} > ${n}`,
    ],
    toBeGreaterThanOrEqual: (n: number | bigint) => [
      (actual as number) >= n,
      `expected ${show(actual)} >= ${n}`,
    ],
    toBeLessThan: (n: number | bigint) => [
      (actual as number) < n,
      `expected ${show(actual)} < ${n}`,
    ],
    toBeLessThanOrEqual: (n: number | bigint) => [
      (actual as number) <= n,
      `expected ${show(actual)} <= ${n}`,
    ],
    toBeCloseTo: (n: number, digits = 2) => [
      Math.abs((actual as number) - n) < 10 ** -digits / 2,
      `expected ${show(actual)} to be close to ${n} (${digits} digits)`,
    ],
    toMatch: (e: string | RegExp) => [
      typeof actual === 'string' && (typeof e === 'string' ? actual.includes(e) : e.test(actual)),
      `expected ${show(actual)} to match ${String(e)}`,
    ],
    toThrow: (e?: unknown) => {
      if (typeof actual !== 'function') return [false, 'toThrow needs a function'];
      try {
        (actual as () => unknown)();
      } catch (error) {
        return [
          thrownMatches(error, e),
          `expected the thrown ${describeError(error)} to match ${show(e)}`,
        ];
      }
      return [false, 'expected the function to throw'];
    },
  };
}

function build(actual: unknown, label: string | undefined, negate: boolean): Matchers {
  const prefix = label ? `${label}: ` : '';
  const table = checks(actual);
  const out = {} as Record<string, (...args: unknown[]) => void>;
  for (const name of Object.keys(table)) {
    out[name] = (...args: unknown[]) => {
      const [pass, message] = (table[name as keyof Matchers] as (...a: unknown[]) => Check)(
        ...args,
      );
      if (pass === negate) throw new AssertionError(`${prefix}${negate ? 'not: ' : ''}${message}`);
    };
  }
  return out as unknown as Matchers;
}

type AsyncMatchers = { [K in keyof Matchers]: (...args: Parameters<Matchers[K]>) => Promise<void> };

interface Assertion extends Matchers {
  readonly not: Matchers;
  readonly resolves: AsyncMatchers;
  readonly rejects: AsyncMatchers;
}

function settle(actual: unknown, label: string | undefined, wantReject: boolean): AsyncMatchers {
  const out = {} as Record<string, (...args: unknown[]) => Promise<void>>;
  for (const name of Object.keys(checks(undefined))) {
    out[name] = async (...args: unknown[]) => {
      let value: unknown;
      let rejected = false;
      try {
        value = await actual;
      } catch (error) {
        value = error;
        rejected = true;
      }
      if (rejected !== wantReject) {
        throw new AssertionError(
          `${label ? `${label}: ` : ''}expected the promise to ${wantReject ? 'reject' : 'resolve'}, but it ${rejected ? `rejected with ${describeError(value)}` : `resolved with ${show(value)}`}`,
        );
      }
      // `rejects.toThrow(x)` checks the rejection reason itself.
      const subject =
        name === 'toThrow'
          ? () => {
              throw value;
            }
          : value;
      (build(subject, label, false) as unknown as Record<string, (...a: unknown[]) => void>)[
        name
      ]?.(...args);
    };
  }
  return out as unknown as AsyncMatchers;
}

export const expect = Object.assign(
  (actual: unknown, label?: string): Assertion =>
    Object.assign(build(actual, label, false), {
      not: build(actual, label, true),
      resolves: settle(actual, label, false),
      rejects: settle(actual, label, true),
    }),
  {
    fail(message?: string): never {
      throw new AssertionError(message ?? 'expect.fail');
    },
  },
);
