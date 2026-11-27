import { describe, expect, it } from 'vitest';
import { timescore } from '@somememos/core';
import {
  describeCount,
  describePace,
  formatBytes,
  formatNumber,
  kindSplit,
  neglectedSignal,
  paceRows,
  relativeTime,
  relevanceWords,
  scoreSummary,
  steadyNeglectedRatio,
  trendingSignal,
  weeklyPace,
} from './format.ts';

const H = timescore.HALF_LIVES;
const DAY = 86_400;

/** The score now of one value-1 event a day for `days` days, the last one just now. */
function steadyScore(halfLife: number, days = Math.ceil((30 * halfLife) / DAY)): number {
  let s = 0;
  for (let i = 0; i < days; i++) s += 2 ** ((-i * DAY) / halfLife);
  return s;
}

function view(
  overrides: Partial<{ activation: Record<string, number>; pace: number; neglected: number }>,
) {
  return {
    dangling: false,
    components: { relevance: null } as never,
    now: {
      activation: overrides.activation ?? {},
      kinds: {
        week: { read: 3, edit: 1, mention: 0 },
      },
      trendingRatio: 0,
      trendingPace: overrides.pace ?? 0,
      neglectedRatio: overrides.neglected ?? 0,
    },
  };
}

describe('formatNumber', () => {
  it('keeps about two significant figures', () => {
    expect(formatNumber(1234.5)).toBe('1,235');
    expect(formatNumber(42.4)).toBe('42');
    expect(formatNumber(3.14159)).toBe('3.1');
    expect(formatNumber(0.123)).toBe('0.12');
    expect(formatNumber(0.001)).toBe('<0.01');
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(null)).toBe('–');
    expect(formatNumber(-Infinity)).toBe('–');
  });
});

describe('weekly pace', () => {
  it('reads steady daily use as 7 a week at every half-life', () => {
    for (const h of Object.values(H)) {
      expect(weeklyPace(steadyScore(h), h)).toBeCloseTo(7, 1);
    }
  });

  it('is zero without activity', () => {
    expect(weeklyPace(0, H.week)).toBe(0);
  });

  it('describes a pace in words', () => {
    expect(describePace(0)).toBe('none');
    expect(describePace(3.2)).toBe('about 3.2 a week');
    expect(describePace(0.5)).toBe('about 2.1 a month');
    expect(describePace(0.1)).toBe('less than one a month');
    expect(describePace(0.01)).toBe('almost none');
  });

  it('counts the activity a window held, in that window', () => {
    expect(describeCount(0, 7)).toBe('none');
    expect(describeCount(7, 1)).toBe('about once');
    expect(describeCount(3.2, 7)).toBe('about 3 times');
    expect(describeCount(0.5, 30)).toBe('about 2 times');
    expect(describeCount(0.5, 1)).toBe('less than once');
    expect(describeCount(0.001, 7)).toBe('almost none');
    expect(describeCount(14, 365)).toBe('about 730 times');
  });

  it('gives one bar per half-life, scaled to the fastest', () => {
    const rows = paceRows(view({ activation: { day: 2, week: 2, month: 2, year: 2 } }));
    expect(rows.map((r) => r.name)).toEqual(['day', 'week', 'month', 'year']);
    expect(rows[0]?.fraction).toBe(1);
    expect(rows[3]?.fraction).toBeLessThan(0.01);
  });
});

describe('kind split', () => {
  it('shares activity between reads, edits and mentions', () => {
    const split = kindSplit(view({}), 'week');
    expect(split.map((s) => [s.kind, s.share])).toEqual([
      ['read', 0.75],
      ['edit', 0.25],
      ['mention', 0],
    ]);
    expect(kindSplit(view({}), 'year').every((s) => s.share === 0)).toBe(true);
  });
});

describe('signals', () => {
  it('reads trending pace against 1.0', () => {
    expect(trendingSignal(view({ pace: 2.3 })).label).toBe('Heating up');
    expect(trendingSignal(view({ pace: 1.0 })).label).toBe('Steady');
    expect(trendingSignal(view({ pace: 0.3 })).label).toBe('Cooling');
    expect(trendingSignal(view({ pace: 0 })).tone).toBe('none');
  });

  it('reads the neglected ratio against steady use', () => {
    const steady = steadyNeglectedRatio();
    expect(steady).toBeGreaterThan(10);
    expect(neglectedSignal(view({ neglected: steady * 4 })).label).toBe('Gone quiet');
    expect(neglectedSignal(view({ neglected: steady })).label).toBe('As usual');
    expect(neglectedSignal(view({ neglected: steady / 3 })).label).toBe('Busier lately');
    expect(neglectedSignal(view({})).tone).toBe('none');
  });

  it('summarizes a result by mode', () => {
    expect(scoreSummary(view({ pace: 2 }), 'trending')).toBe('Heating up · 2.0× usual');
    expect(scoreSummary(view({}), 'hot')).toBe('No recent activity');
    expect(scoreSummary(view({ activation: { week: 10 } }), 'hot')).toMatch(/^Lately about/);
  });

  it('describes relevance relative to the best match', () => {
    expect(relevanceWords(9, 10)).toBe('Strong match');
    expect(relevanceWords(5, 10)).toBe('Good match');
    expect(relevanceWords(1, 10)).toBe('Weak match');
    expect(relevanceWords(null, 10)).toBe('No keywords');
  });
});

describe('times and sizes', () => {
  it('says how long ago', () => {
    const now = 1_800_000_000;
    expect(relativeTime(now - 10, now)).toBe('just now');
    expect(relativeTime(now - 600, now)).toBe('10 min ago');
    expect(relativeTime(now - 3 * 3600, now)).toBe('3 h ago');
    expect(relativeTime(now - 30 * 3600, now)).toBe('yesterday');
    expect(relativeTime(now - 3 * DAY, now)).toBe('3 days ago');
  });

  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(1_234_000)).toBe('1.2 MB');
    expect(formatBytes(undefined)).toBe('unknown');
  });
});
