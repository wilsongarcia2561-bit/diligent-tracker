/**
 * Cross-day analytics for the Trends and History screens.
 *
 * Pure functions over calculated days (the objects calculateDay returns), no
 * DOM or storage — tested in tests/analytics.test.mjs. Every window here is
 * measured in calendar days, not "last N entries", so a gap in logging (a
 * weekend, a missed day) never stretches a "7-day" figure across two weeks.
 */

const DAY_MS = 86400000;

function toTime(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(iso, n) {
  return new Date(toTime(iso) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Monday of the ISO week containing `iso`. */
export function weekStart(iso) {
  const dow = (new Date(toTime(iso)).getUTCDay() + 6) % 7;
  return addDays(iso, -dow);
}

export const RANGES = { '1W': 7, '1M': 30, '3M': 91, ALL: Infinity };

export const COMPONENTS = [
  { key: 'bmr', label: 'BMR', color: 'var(--c-bmr)', estimate: false },
  { key: 'active', label: 'Active work', color: 'var(--c-active)', estimate: false },
  { key: 'background', label: 'Background life', color: 'var(--c-bg)', estimate: true },
  { key: 'tef', label: 'TEF', color: 'var(--c-tef)', estimate: false },
  { key: 'neat', label: 'Post-work NEAT', color: 'var(--c-neat)', estimate: true },
];

function mean(list, pick) {
  if (!list.length) return null;
  return list.reduce((sum, item) => sum + pick(item), 0) / list.length;
}

export function sortByDate(days) {
  return [...days].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Days inside the selected range ending at `anchor` (inclusive), plus the
 * equally long window immediately before it for "vs prior" comparisons.
 * ALL has no prior window.
 */
export function rangeWindows(days, range, anchor) {
  const span = RANGES[range] ?? RANGES['3M'];
  const sorted = sortByDate(days);
  if (!Number.isFinite(span)) return { current: sorted, prior: [] };
  const start = addDays(anchor, -span);
  const priorStart = addDays(anchor, -2 * span);
  return {
    current: sorted.filter((d) => d.date > start && d.date <= anchor),
    prior: sorted.filter((d) => d.date > priorStart && d.date <= start),
  };
}

/** Mean TDEE over the `span` calendar days before `date` (the day itself excluded). */
export function trailingAverage(days, date, span = 7) {
  const from = addDays(date, -span);
  return mean(days.filter((d) => d.date >= from && d.date < date), (d) => d.tdee);
}

/** Rolling mean over the `span` calendar days ending on each day (inclusive). */
export function rollingSeries(days, span = 7) {
  const sorted = sortByDate(days);
  return sorted.map((day) => {
    const from = addDays(day.date, -(span - 1));
    const window = sorted.filter((d) => d.date >= from && d.date <= day.date);
    return { date: day.date, value: mean(window, (d) => d.tdee), samples: window.length };
  });
}

/** The phase that burned the most, as a short label for ledgers and lists. */
export function mainTask(day) {
  if (day.restDay) return 'Rest day';
  const phases = (day.phases || []).filter((p) => p.description);
  if (!phases.length) return '';
  return phases.reduce((best, p) => (p.kcal > best.kcal ? p : best)).description;
}

export function summarize(days) {
  const work = days.filter((d) => !d.restDay);
  const rest = days.filter((d) => d.restDay);
  const peak = days.length ? days.reduce((best, d) => (d.tdee > best.tdee ? d : best)) : null;
  const components = {};
  for (const c of COMPONENTS) components[c.key] = mean(days, (d) => d.components[c.key] || 0);
  return {
    count: days.length,
    avg: mean(days, (d) => d.tdee),
    workCount: work.length,
    restCount: rest.length,
    workAvg: mean(work, (d) => d.tdee),
    restAvg: mean(rest, (d) => d.tdee),
    activeAvg: mean(work, (d) => d.components.active),
    peak: peak ? { date: peak.date, tdee: peak.tdee, task: mainTask(peak) } : null,
    components,
  };
}

/**
 * Highest-TDEE days in `days`, each compared against the trailing 7-day
 * average computed from `history` (the full log, so a day at the start of
 * a range still gets a comparison from the days just before it).
 */
export function topBurns(days, history = days, n = 5) {
  return [...days]
    .sort((a, b) => b.tdee - a.tdee)
    .slice(0, n)
    .map((d) => {
      const avg = trailingAverage(history, d.date);
      return { date: d.date, tdee: d.tdee, task: mainTask(d), delta: avg === null ? null : d.tdee - avg };
    });
}

/**
 * One candle per calendar week. The body runs from the previous week's
 * average ("open") to this week's ("close"); the wick spans the lowest to the
 * highest single day. The first week has no previous week, so it opens at its
 * own average and draws as a flat body.
 */
export function weeklyCandles(days) {
  const byWeek = new Map();
  for (const d of sortByDate(days)) {
    const key = weekStart(d.date);
    if (!byWeek.has(key)) byWeek.set(key, []);
    byWeek.get(key).push(d);
  }
  const candles = [];
  let prevAvg = null;
  for (const [week, list] of byWeek) {
    const avg = mean(list, (d) => d.tdee);
    const values = list.map((d) => d.tdee);
    const open = prevAvg ?? avg;
    candles.push({
      week,
      avg,
      open,
      close: avg,
      low: Math.min(...values),
      high: Math.max(...values),
      up: avg >= open,
      days: list.length,
    });
    prevAvg = avg;
  }
  return candles;
}

/** Newest week first; rows inside each week newest first — a statement ledger. */
export function groupByWeek(days) {
  const groups = new Map();
  for (const d of sortByDate(days).reverse()) {
    const key = weekStart(d.date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  return [...groups].map(([week, rows]) => ({
    week,
    rows,
    avg: mean(rows, (d) => d.tdee),
    workCount: rows.filter((d) => !d.restDay).length,
    restCount: rows.filter((d) => d.restDay).length,
  }));
}
