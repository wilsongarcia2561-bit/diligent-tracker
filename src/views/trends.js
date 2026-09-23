/** Trends — TDEE over time, work vs rest, allocation, and weekly ranges (§12.6). */

import { areaChart, candleChart, shortDate, sparkline } from '../charts.js';
import {
  COMPONENTS,
  RANGES,
  rangeWindows,
  rollingSeries,
  summarize,
  topBurns,
  weeklyCandles,
} from '../analytics.js';
import { calculatedDays } from './history.js';
import { esc, kcal } from '../ui.js';

const RANGE_KEY = 'diligent3.trendsRange';
let range = '3M';
try {
  const saved = localStorage.getItem(RANGE_KEY);
  if (saved && saved in RANGES) range = saved;
} catch {
  /* storage unavailable — keep the default */
}

const RANGE_WORDS = { '1W': '1W', '1M': '1M', '3M': '3M', ALL: 'all time' };

function signed(n) {
  const r = Math.round(n);
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toLocaleString()}`;
}

function deltaClass(n) {
  const r = Math.round(n);
  return r > 0 ? 'up' : r < 0 ? 'down' : 'flat';
}

function longDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${wd}, ${shortDate(iso)}`;
}

export function render(root, { onEdit, onLog } = {}) {
  const all = calculatedDays();

  if (!all.length) {
    root.innerHTML = `
      <div class="empty-state">
        <p class="eyebrow">Trends</p>
        <h2>Nothing to chart yet</h2>
        <p class="muted">Trends fill in as days are logged. Log today, or import a month of calendar logs from the Daily entry tab.</p>
        <button type="button" class="btn primary" data-action="go-log">Log a day</button>
      </div>`;
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="go-log"]')) onLog?.();
    });
    return;
  }

  const anchor = all.at(-1).date;
  const { current, prior } = rangeWindows(all, range, anchor);
  const s = summarize(current);
  const p = summarize(prior);
  const rolling = rollingSeries(all).filter((r) => current.some((d) => d.date === r.date));
  const series = current.map((d) => ({ date: d.date, value: d.tdee, restDay: d.restDay }));

  const heroDelta = s.avg !== null && p.avg !== null ? s.avg - p.avg : null;
  const heroLine = heroDelta === null
    ? `<span class="faint">${current.length ? `Since ${shortDate(current[0].date)} · no earlier period to compare` : ''}</span>`
    : `<span class="delta ${deltaClass(heroDelta)}">${heroDelta >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(heroDelta)).toLocaleString()} (${Math.abs((heroDelta / p.avg) * 100).toFixed(1)}%)</span>
       <span class="faint">vs prior ${RANGE_WORDS[range]}</span>`;

  const allocTotal = COMPONENTS.reduce((sum, c) => sum + (s.components[c.key] || 0), 0) || 1;
  const allocRows = COMPONENTS.map((c) => {
    const v = s.components[c.key] || 0;
    const pv = p.components[c.key];
    const d = pv === null || pv === undefined || !prior.length ? null : v - pv;
    return `
      <tr>
        <td><span class="swatch" style="--sw:${c.color}"></span>${c.label}${c.estimate ? ' <span class="est-tag">EST</span>' : ''}</td>
        <td class="num strong">${kcal(v)}</td>
        <td class="num faint">${((v / allocTotal) * 100).toFixed(1)}%</td>
        <td class="num ${d === null ? 'faint' : `delta ${deltaClass(d)}`}">${d === null ? '–' : signed(d)}</td>
      </tr>`;
  }).join('');

  const workDays = current.filter((d) => !d.restDay);
  const restDays = current.filter((d) => d.restDay);
  const gap = s.workAvg !== null && s.restAvg !== null ? s.workAvg - s.restAvg : null;

  const burns = topBurns(current, all, 5);

  root.innerHTML = `
    <section class="trend-hero">
      <div>
        <p class="eyebrow">Avg daily TDEE · ${RANGE_WORDS[range]}</p>
        <div class="hero-num">${kcal(s.avg)}<span class="unit">kcal</span></div>
        <p class="hero-line">${heroLine}</p>
      </div>
      <div class="seg" role="group" aria-label="Date range">
        ${Object.keys(RANGES).map((r) => `<button type="button" data-range="${r}" aria-pressed="${r === range}" class="${r === range ? 'active' : ''}">${r}</button>`).join('')}
      </div>
    </section>

    <div id="tdee-chart" class="chart-host"></div>
    <ul class="chart-legend">
      <li><span class="lg-line"></span>Daily TDEE</li>
      <li><span class="lg-dash"></span>Rolling 7-day average</li>
    </ul>

    <section class="stat-row">
      <div class="stat"><span class="stat-label">Work-day avg</span><span class="stat-value">${kcal(s.workAvg)}</span><span class="stat-sub">${s.workCount} day${s.workCount === 1 ? '' : 's'}</span></div>
      <div class="stat"><span class="stat-label">Rest-day avg</span><span class="stat-value">${kcal(s.restAvg)}</span><span class="stat-sub">${s.restCount} day${s.restCount === 1 ? '' : 's'}</span></div>
      <div class="stat"><span class="stat-label">Avg active kcal</span><span class="stat-value">${kcal(s.activeAvg)}</span><span class="stat-sub">work days only</span></div>
      <div class="stat"><span class="stat-label">Peak day</span><span class="stat-value">${s.peak ? kcal(s.peak.tdee) : '—'}</span><span class="stat-sub">${s.peak ? longDate(s.peak.date) : '—'}</span></div>
      <div class="stat"><span class="stat-label">Days logged</span><span class="stat-value">${s.count}</span><span class="stat-sub">in range</span></div>
    </section>

    <section class="trend-grid">
      <article class="panel">
        <header class="panel-head"><h3>Allocation</h3><span class="meta">avg / day · ${RANGE_WORDS[range]}</span></header>
        <div class="stackbar" role="img" aria-label="Average TDEE split by component">
          ${COMPONENTS.map((c) => `<span class="${c.estimate ? 'est' : ''}" style="flex:${Math.max(0.001, s.components[c.key] || 0)};--sw:${c.color}" title="${c.label}: ${kcal(s.components[c.key])} kcal"></span>`).join('')}
        </div>
        <table class="mini-table alloc">
          <thead class="sr-only"><tr><th>Component</th><th>kcal</th><th>Share</th><th>vs prior</th></tr></thead>
          <tbody>${allocRows}</tbody>
        </table>
      </article>

      <article class="panel">
        <header class="panel-head"><h3>Work day vs rest day</h3></header>
        <div class="split-cards">
          <div class="inset">
            <div class="inset-head"><span class="tag-label work">Work days</span><span class="faint">${workDays.length} days</span></div>
            <div class="inset-body"><span class="inset-num">${kcal(s.workAvg)}</span><span class="spark-host" data-spark="work"></span></div>
          </div>
          <div class="inset">
            <div class="inset-head"><span class="tag-label rest">Rest days</span><span class="faint">${restDays.length} days</span></div>
            <div class="inset-body"><span class="inset-num">${kcal(s.restAvg)}</span><span class="spark-host" data-spark="rest"></span></div>
          </div>
        </div>
        <p class="panel-foot">${gap === null ? 'Log both work and rest days to compare them.' : `Work days burn <strong>${kcal(gap)} kcal</strong> more on average.`}</p>
      </article>

      <article class="panel">
        <header class="panel-head"><h3>Top burns</h3><span class="meta">vs 7d avg</span></header>
        <ol class="burns">
          ${burns.map((b, i) => `
            <li>
              <button type="button" class="burn" data-date="${b.date}">
                <span class="rank">${i + 1}</span>
                <span class="burn-main"><span class="burn-date">${longDate(b.date)}</span><span class="burn-task">${esc(b.task || 'No task logged')}</span></span>
                <span class="burn-nums"><span class="strong">${kcal(b.tdee)}</span><span class="delta ${b.delta === null ? 'flat' : deltaClass(b.delta)}">${b.delta === null ? '–' : signed(b.delta)}</span></span>
              </button>
            </li>`).join('')}
        </ol>
      </article>
    </section>

    <section class="panel candles-panel">
      <header class="panel-head">
        <div>
          <h3>Weekly range</h3>
          <p class="panel-sub">Body: change in weekly average vs the week before. Wick: lowest to highest single day.</p>
        </div>
        <ul class="candle-legend"><li><span class="sq up"></span>Avg up</li><li><span class="sq down"></span>Avg down</li></ul>
      </header>
      <div id="candle-chart" class="chart-host"></div>
    </section>`;

  areaChart(root.querySelector('#tdee-chart'), series, rolling);
  candleChart(root.querySelector('#candle-chart'), weeklyCandles(current));
  const work = root.querySelector('[data-spark="work"]');
  const rest = root.querySelector('[data-spark="rest"]');
  if (work) work.append(sparkline(workDays.map((d) => d.tdee), 'var(--green)'));
  if (rest) rest.append(sparkline(restDays.map((d) => d.tdee), 'var(--blue)'));

  root.addEventListener('click', (e) => {
    const r = e.target.closest('[data-range]');
    if (r) {
      range = r.dataset.range;
      try {
        localStorage.setItem(RANGE_KEY, range);
      } catch {
        /* non-essential */
      }
      const fresh = root.cloneNode(false);
      root.replaceWith(fresh);
      render(fresh, { onEdit, onLog });
      return;
    }
    const burn = e.target.closest('.burn');
    if (burn) onEdit?.(burn.dataset.date);
  });
}
