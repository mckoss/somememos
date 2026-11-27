import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCHEDULE,
  SyncScheduler,
  backoffDelay,
  indicatorFor,
  type RunResult,
  type Timers,
} from './schedule.ts';

/** A clock and timers the test moves by hand. */
class FakeTimers implements Timers {
  t = 1_000_000;
  private next = 1;
  private readonly due = new Map<number, { at: number; fn: () => void }>();
  set(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.due.set(id, { at: this.t + ms, fn });
    return id;
  }
  clear(handle: unknown): void {
    this.due.delete(handle as number);
  }
  now(): number {
    return this.t;
  }
  /** Moves the clock forward, firing each timer that comes due (and letting runs settle). */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await settle();
      let first: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.due)
        if (entry[1].at <= end && (!first || entry[1].at < first[1].at)) first = entry;
      if (!first) break;
      this.due.delete(first[0]);
      this.t = Math.max(this.t, first[1].at);
      first[1].fn();
    }
    this.t = end;
    await settle();
  }
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A scheduler whose runs are recorded and answer with the queued results (ok by default). */
function setup(results: RunResult[] = []) {
  const timers = new FakeTimers();
  const runs: number[] = [];
  let release: (() => void) | null = null;
  let hold = false;
  const scheduler = new SyncScheduler(
    async () => {
      runs.push(timers.now());
      if (hold) await new Promise<void>((r) => (release = r));
      return results.shift() ?? { ok: true };
    },
    timers,
    {},
    undefined,
    () => 1, // no jitter: the longest wait
  );
  return {
    timers,
    runs,
    scheduler,
    holdRuns(on: boolean) {
      hold = on;
    },
    finishRun() {
      const r = release;
      release = null;
      r?.();
    },
  };
}

describe('backoffDelay', () => {
  it('doubles from the base up to the cap', () => {
    const d = (n: number) => backoffDelay(n, 5_000, 300_000, () => 1);
    expect([d(1), d(2), d(3), d(4), d(5), d(6), d(7), d(8)]).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
    ]);
    expect(d(0)).toBe(0);
    expect(d(1000)).toBe(300_000);
  });

  it('jitters down to three quarters, never above', () => {
    expect(backoffDelay(3, 5_000, 300_000, () => 0)).toBe(15_000);
    expect(backoffDelay(3, 5_000, 300_000, () => 0.5)).toBe(17_500);
    expect(backoffDelay(3, 5_000, 300_000, () => 7)).toBe(20_000);
  });
});

describe('SyncScheduler', () => {
  it('does nothing until enabled', async () => {
    const { scheduler, timers, runs } = setup();
    scheduler.trigger('now');
    scheduler.trigger('change');
    await timers.advance(DEFAULT_SCHEDULE.intervalMs * 2);
    expect(runs).toEqual([]);
  });

  it('debounces a burst of changes into one sync', async () => {
    const { scheduler, timers, runs } = setup();
    scheduler.enable();
    const t0 = timers.now();
    scheduler.trigger('change');
    await timers.advance(2_000);
    scheduler.trigger('change');
    await timers.advance(2_000);
    scheduler.trigger('change');
    expect(runs).toEqual([]);
    await timers.advance(3_000);
    expect(runs).toEqual([t0 + 7_000]);
  });

  it('caps the wait under steady changes', async () => {
    const { scheduler, timers, runs } = setup();
    scheduler.enable();
    const t0 = timers.now();
    for (let i = 0; i < 20; i++) {
      scheduler.trigger('change');
      await timers.advance(2_000);
    }
    expect(runs[0]).toBe(t0 + DEFAULT_SCHEDULE.changeMaxWaitMs);
  });

  it('syncs reads lazily, but a change brings the sync forward', async () => {
    const { scheduler, timers, runs } = setup();
    scheduler.enable();
    const t0 = timers.now();
    scheduler.trigger('read');
    await timers.advance(5_000);
    expect(runs).toEqual([]);
    scheduler.trigger('change');
    await timers.advance(3_000);
    expect(runs).toEqual([t0 + 8_000]);

    const { scheduler: s2, timers: t2, runs: r2 } = setup();
    s2.enable();
    const start = t2.now();
    s2.trigger('read');
    await t2.advance(DEFAULT_SCHEDULE.readDelayMs);
    expect(r2).toEqual([start + DEFAULT_SCHEDULE.readDelayMs]);
  });

  it('a read does not push back a change that is due sooner', async () => {
    const { scheduler, timers, runs } = setup();
    scheduler.enable();
    const t0 = timers.now();
    scheduler.trigger('change');
    scheduler.trigger('read');
    await timers.advance(3_000);
    expect(runs).toEqual([t0 + 3_000]);
  });

  it('never runs two at once; a trigger during a run is served after it', async () => {
    const env = setup();
    env.holdRuns(true);
    env.scheduler.enable();
    env.scheduler.trigger('now');
    await settle();
    expect(env.runs.length).toBe(1);
    env.scheduler.trigger('now');
    env.scheduler.trigger('now');
    env.scheduler.trigger('change');
    await env.timers.advance(10_000);
    expect(env.runs.length).toBe(1);
    expect(env.scheduler.state.running).toBe(true);
    env.holdRuns(false);
    env.finishRun();
    await settle();
    // One more run for the queued "now"s (the change rides along).
    expect(env.runs.length).toBe(2);
    await env.timers.advance(60_000);
    expect(env.runs.length).toBe(2);
  });

  it('a change during a run syncs again after a quiet period', async () => {
    const env = setup();
    env.holdRuns(true);
    env.scheduler.enable();
    env.scheduler.trigger('now');
    await settle();
    env.scheduler.trigger('change');
    env.holdRuns(false);
    env.finishRun();
    await settle();
    expect(env.runs.length).toBe(1);
    await env.timers.advance(3_000);
    expect(env.runs.length).toBe(2);
  });

  it('backs off exponentially on failures, up to the cap', async () => {
    const failures: RunResult[] = Array.from({ length: 12 }, () => ({
      ok: false as const,
      kind: 'server' as const,
    }));
    const { scheduler, timers, runs } = setup(failures);
    scheduler.enable();
    scheduler.trigger('now');
    await timers.advance(30 * 60_000);
    const gaps = runs.slice(1).map((t, i) => t - (runs[i] as number));
    expect(gaps.slice(0, 7)).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000]);
    expect(Math.max(...gaps)).toBe(300_000);
  });

  it('respects a retry-after longer than the backoff', async () => {
    const { scheduler, timers, runs } = setup([
      { ok: false, kind: 'server', retryAfterMs: 90_000 },
    ]);
    scheduler.enable();
    const t0 = timers.now();
    scheduler.trigger('now');
    await timers.advance(89_000);
    expect(runs).toEqual([t0]);
    await timers.advance(1_000);
    expect(runs).toEqual([t0, t0 + 90_000]);
  });

  it('changes during a backoff wait for the retry instead of hammering', async () => {
    const { scheduler, timers, runs } = setup([
      { ok: false, kind: 'server' },
      { ok: false, kind: 'server' },
    ]);
    scheduler.enable();
    scheduler.trigger('now');
    await settle();
    await timers.advance(5_000); // first retry fails too: next in 10 s
    expect(runs.length).toBe(2);
    scheduler.trigger('change');
    await timers.advance(3_000);
    expect(runs.length).toBe(2);
    await timers.advance(7_000);
    expect(runs.length).toBe(3);
  });

  it('stops automatic sync on an auth failure until the person acts', async () => {
    const { scheduler, timers, runs } = setup([{ ok: false, kind: 'auth' }]);
    scheduler.enable();
    scheduler.trigger('now');
    await settle();
    expect(scheduler.state.paused).toBe('auth');
    scheduler.trigger('change');
    scheduler.trigger('read');
    scheduler.trigger('online');
    scheduler.trigger('visible');
    await timers.advance(DEFAULT_SCHEDULE.intervalMs * 3);
    expect(runs.length).toBe(1);
    expect(scheduler.state.nextAt).toBeNull();
    // "Sync now" still runs; a success clears the pause.
    scheduler.trigger('now');
    await settle();
    expect(runs.length).toBe(2);
    expect(scheduler.state.paused).toBeNull();
    expect(scheduler.state.failures).toBe(0);
  });

  it('a new token (connect) clears the pause and the failure count', async () => {
    const { scheduler, timers, runs } = setup([
      { ok: false, kind: 'auth' },
      { ok: false, kind: 'auth' },
    ]);
    scheduler.enable();
    scheduler.trigger('now');
    await settle();
    scheduler.trigger('now');
    await settle();
    expect(scheduler.state.failures).toBe(2);
    scheduler.trigger('connect');
    await settle();
    expect(runs.length).toBe(3);
    expect(scheduler.state).toMatchObject({ paused: null, failures: 0 });
    await timers.advance(1);
  });

  it('a fatal failure stops it too', async () => {
    const { scheduler, timers, runs } = setup([{ ok: false, kind: 'fatal' }]);
    scheduler.enable();
    scheduler.trigger('now');
    await timers.advance(DEFAULT_SCHEDULE.intervalMs * 2);
    expect(runs.length).toBe(1);
    expect(scheduler.state.paused).toBe('fatal');
  });

  it('retries soon after coming back online', async () => {
    const { scheduler, timers, runs } = setup([{ ok: false, kind: 'offline' }]);
    scheduler.enable();
    const t0 = timers.now();
    scheduler.trigger('now');
    await settle();
    expect(scheduler.state.offline).toBe(true);
    await timers.advance(2_000);
    scheduler.trigger('online');
    expect(scheduler.state.offline).toBe(false);
    await timers.advance(DEFAULT_SCHEDULE.onlineDelayMs);
    expect(runs).toEqual([t0, t0 + 2_000 + DEFAULT_SCHEDULE.onlineDelayMs]);
  });

  it('syncs when it becomes visible after a while, not right after a sync', async () => {
    const { scheduler, timers, runs } = setup();
    scheduler.enable();
    scheduler.trigger('now');
    await settle();
    expect(runs.length).toBe(1);
    await timers.advance(10_000);
    scheduler.trigger('visible');
    await settle();
    expect(runs.length).toBe(1);
    await timers.advance(DEFAULT_SCHEDULE.visibleStaleMs);
    scheduler.trigger('visible');
    await settle();
    expect(runs.length).toBe(2);
  });

  it('syncs on a slow interval while enabled', async () => {
    const { scheduler, timers, runs } = setup();
    scheduler.enable();
    await timers.advance(DEFAULT_SCHEDULE.intervalMs * 3 + 1);
    expect(runs.length).toBe(3);
    scheduler.disable();
    await timers.advance(DEFAULT_SCHEDULE.intervalMs * 3);
    expect(runs.length).toBe(3);
  });

  it('disable drops planned runs, and idle() waits for the run in progress', async () => {
    const env = setup();
    env.scheduler.enable();
    env.scheduler.trigger('change');
    env.scheduler.disable();
    await env.timers.advance(60_000);
    expect(env.runs).toEqual([]);

    env.scheduler.enable();
    env.holdRuns(true);
    env.scheduler.trigger('now');
    await settle();
    let idle = false;
    void env.scheduler.idle().then(() => (idle = true));
    await settle();
    expect(idle).toBe(false);
    env.finishRun();
    await settle();
    expect(idle).toBe(true);
  });
});

describe('indicatorFor', () => {
  const base = {
    connected: true,
    running: false,
    paused: null,
    offline: false,
    failures: 0,
    conflicts: 0,
    pendingNotes: 0,
    pendingChanges: 0,
  } as const;

  it('says off when not connected, whatever else is true', () => {
    expect(indicatorFor({ ...base, connected: false, conflicts: 3, paused: 'auth' })).toBe('off');
  });

  it('orders the states: syncing, attention, offline, waiting, synced', () => {
    expect(indicatorFor(base)).toBe('synced');
    expect(indicatorFor({ ...base, pendingNotes: 1 })).toBe('waiting');
    expect(indicatorFor({ ...base, pendingChanges: 1 })).toBe('waiting');
    expect(indicatorFor({ ...base, failures: 1 })).toBe('waiting');
    expect(indicatorFor({ ...base, failures: 3 })).toBe('attention');
    expect(indicatorFor({ ...base, offline: true, failures: 5, pendingNotes: 2 })).toBe('offline');
    expect(indicatorFor({ ...base, offline: true, conflicts: 1 })).toBe('attention');
    expect(indicatorFor({ ...base, paused: 'auth' })).toBe('attention');
    expect(indicatorFor({ ...base, running: true, paused: 'auth' })).toBe('syncing');
  });
});
