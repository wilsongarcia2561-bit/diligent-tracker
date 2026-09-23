import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addDays,
  groupByWeek,
  mainTask,
  rangeWindows,
  rollingSeries,
  summarize,
  topBurns,
  trailingAverage,
  weekStart,
  weeklyCandles,
} from '../src/analytics.js';

const day = (date, tdee, extra = {}) => ({
  date,
  tdee,
  restDay: false,
  components: { bmr: 1436, active: tdee - 1946, background: 225, tef: 210, neat: 75 },
  phases: [],
  ...extra,
});

describe('date helpers', () => {
  it('adds calendar days across a month boundary', () => {
    assert.equal(addDays('2026-08-30', 3), '2026-09-02');
    assert.equal(addDays('2026-09-02', -3), '2026-08-30');
  });

  it('finds the Monday that starts the week', () => {
    assert.equal(weekStart('2026-09-14'), '2026-09-14'); // Monday
    assert.equal(weekStart('2026-09-20'), '2026-09-14'); // Sunday
    assert.equal(weekStart('2026-09-21'), '2026-09-21');
  });
});

describe('rangeWindows', () => {
  const days = [day('2026-09-01', 3000), day('2026-09-08', 3100), day('2026-09-10', 3200), day('2026-09-14', 3300)];

  it('keeps the last N calendar days ending at the anchor, inclusive', () => {
    const { current } = rangeWindows(days, '1W', '2026-09-14');
    assert.deepEqual(current.map((d) => d.date), ['2026-09-08', '2026-09-10', '2026-09-14']);
  });

  it('returns the equally long window just before as the prior period', () => {
    const { prior } = rangeWindows(days, '1W', '2026-09-14');
    assert.deepEqual(prior.map((d) => d.date), ['2026-09-01']);
  });

  it('ALL takes everything and has no prior period', () => {
    const { current, prior } = rangeWindows(days, 'ALL', '2026-09-14');
    assert.equal(current.length, 4);
    assert.equal(prior.length, 0);
  });
});

describe('trailing and rolling averages use calendar days, not entry counts', () => {
  const days = [day('2026-09-01', 2000), day('2026-09-09', 3000), day('2026-09-10', 4000)];

  it('excludes the day itself and anything older than 7 days', () => {
    assert.equal(trailingAverage(days, '2026-09-10'), 3000);
    assert.equal(trailingAverage(days, '2026-09-09'), null, 'Sep 1 is 8 days back');
  });

  it('rolls over the 7 days ending on each date, inclusive', () => {
    const rolled = rollingSeries(days);
    assert.equal(rolled[0].value, 2000);
    assert.equal(rolled[1].value, 3000);
    assert.equal(rolled[2].value, 3500);
  });
});

describe('mainTask', () => {
  it('names the highest-kcal phase', () => {
    const d = day('2026-09-10', 3000, {
      phases: [
        { description: 'Trim', kcal: 200 },
        { description: 'Wet sod wheelbarrow', kcal: 900 },
      ],
    });
    assert.equal(mainTask(d), 'Wet sod wheelbarrow');
  });

  it('labels rest days, and leaves task-less work days blank rather than inventing one', () => {
    assert.equal(mainTask(day('2026-09-12', 1946, { restDay: true })), 'Non-work day');
    assert.equal(mainTask(day('2026-08-28', 1946)), '');
  });
});

describe('summarize', () => {
  it('splits work and rest averages and finds the peak day', () => {
    const s = summarize([
      day('2026-09-10', 3400),
      day('2026-09-11', 3600),
      day('2026-09-12', 1950, { restDay: true }),
    ]);
    assert.equal(s.workAvg, 3500);
    assert.equal(s.restAvg, 1950);
    assert.equal(s.workCount, 2);
    assert.equal(s.restCount, 1);
    assert.equal(s.peak.date, '2026-09-11');
    assert.equal(s.components.bmr, 1436);
  });

  it('reports nulls, not zeros, for an empty window', () => {
    const s = summarize([]);
    assert.equal(s.avg, null);
    assert.equal(s.peak, null);
  });
});

describe('topBurns', () => {
  it('ranks by TDEE and compares against the trailing week from the full history', () => {
    const history = [day('2026-09-08', 3000), day('2026-09-09', 3000), day('2026-09-10', 3600)];
    const top = topBurns([history[2]], history, 5);
    assert.equal(top.length, 1);
    assert.equal(top[0].delta, 600);
  });
});

describe('weeklyCandles', () => {
  const days = [
    day('2026-09-07', 3000),
    day('2026-09-08', 3400), // week of Sep 7: avg 3200, low 3000, high 3400
    day('2026-09-14', 3000),
    day('2026-09-15', 3000), // week of Sep 14: avg 3000 → down from 3200
  ];
  const candles = weeklyCandles(days);

  it('makes one candle per calendar week with the day range as its wick', () => {
    assert.equal(candles.length, 2);
    assert.equal(candles[0].low, 3000);
    assert.equal(candles[0].high, 3400);
  });

  it('opens each candle at the previous week average and marks the direction', () => {
    assert.equal(candles[0].open, candles[0].close, 'first week has nothing to compare with');
    assert.equal(candles[1].open, 3200);
    assert.equal(candles[1].close, 3000);
    assert.equal(candles[1].up, false);
  });
});

describe('groupByWeek', () => {
  it('returns newest week first with work/rest counts and newest rows first', () => {
    const groups = groupByWeek([
      day('2026-09-07', 3000),
      day('2026-09-12', 1950, { restDay: true }),
      day('2026-09-14', 3300),
    ]);
    assert.equal(groups[0].week, '2026-09-14');
    assert.equal(groups[1].week, '2026-09-07');
    assert.deepEqual(groups[1].rows.map((r) => r.date), ['2026-09-12', '2026-09-07']);
    assert.equal(groups[1].workCount, 1);
    assert.equal(groups[1].restCount, 1);
  });
});
