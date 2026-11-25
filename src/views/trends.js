/** Trends — weekly, monthly and latest TDEE up top; allocation and weekly ranges below (§12.6). */

import { candleChart, shortDate, sparkline, trendChart } from '../charts.js';
import {
  COMPONENTS,
  RANGES,
  addDays,
  mainTask,
  rangeWindows,
  summarize,
  topBurns,
  trailingSeries,
  trailingWindow,
  weeklyCandles,
} from '../analytics.js';
import { calculatedDays } from './history.js';
import * as store from '../store.js';
import { countUp, esc, kcal, num, reveal } from '../ui.js';

const RANGE_KEY = 'diligent3.trendsRange';
const MODE_KEY = 'diligent3.trendsMode';
const read = (key, ok, fallback) => {
  try {
    const v = localStorage.getItem(key);
    return v && ok(v) ? v : fallback;
  } catch {
    return fallback;
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* non-essential */
  }
};

const MODES = {
  weekly: { label: 'Weekly', span: 7, count: 8 },
  monthly: { label: 'Monthly', span: 30, count: 6 },
  latest: { label: 'Latest', span: 14 },
};

let range = read(RANGE_KEY, (v) => v in RANGES, '3M');
let mode = read(MODE_KEY, (v) => v in MODES, 'weekly');

const RANGE_WORDS = { '1W': '1W', '1M': '1M', '3M': '3M', ALL: 'all time' };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function signed(n) {
  const r = Math.round(n);
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toLocaleString()}`;
}

function deltaClass(n) {
  const r = Math.round(n);
  return r > 0 ? 'up' : r < 0 ? 'down' : 'flat';
}

const weekday = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
};
const longDate = (iso) => `${weekday(iso)}, ${shortDate(iso)}`;
const slashDate = (iso) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${weekday(iso)} ${m}/${d}`;
};
const round = (v) => Math.round(v);

/** The chart points for a mode, oldest first. */
function pointsFor(id, all, anchor) {
  if (id === 'latest') {
    const from = addDays(anchor, -(MODES.latest.span - 1));
    return all
      .filter((d) => d.date >= from)
      .map((d) => ({ date: d.date, value: d.tdee, tone: d.restDay ? 'rest' : 'work', day: d }));
  }
  const { span, count } = MODES[id];
  return trailingSeries(all, anchor, span, count);
}

/** The line under the tiles: which stretch the selected point covers, and its figure. */
function readout(id, p, isLast) {
  if (id === 'latest') {
    const d = p.day;
    const task = mainTask(d);
    return {
      text: `${isLast ? 'Latest' : 'Day'} · ${longDate(d.date)} · ${d.restDay ? 'Rest day' : 'Work day'}${task && !d.restDay ? ` · ${task}` : ''}`,
      value: p.value,
      date: d.date,
    };
  }
  return {
    text: `${isLast ? 'Latest' : 'Window'} · ${p.span} days to ${longDate(p.date)} · ${p.work}W ${p.rest}R`,
    value: p.value,
  };
}

export function render(root, { onEdit, onLog } = {}) {
  const all = calculatedDays();

  if (!all.length) {
    root.innerHTML = `
      <header class="page-head" data-no-reveal>
        <p class="page-kicker">TDEE.</p>
        <h1 class="page-title">Trends.</h1>
        <p class="page-sub">Nothing logged yet.</p>
      </header>
      <div class="empty-state">
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
  const latest = all.at(-1);
  const weekly = trailingWindow(all, anchor, 7);
  const monthly = trailingWindow(all, anchor, 30);
  const weight = store.weightForDate(anchor);

  root.innerHTML = `
    <header class="page-head" data-no-reveal>
      <p class="page-kicker">TDEE.</p>
      <h1 class="page-title">Trends.</h1>
      <div class="page-sub-row">
        <p class="page-sub">Logged through ${longDate(anchor)}</p>
        <span class="chip" title="Bodyweight every calculation uses until the next weigh-in. Change it in Settings → Bodyweight log.">${num(weight, 1)} kg · fixed</span>
      </div>
    </header>

    <section class="trend-card" data-no-reveal aria-label="Average TDEE">
      <div class="tiles" role="tablist" aria-label="Average over">
        <span class="tile-thumb" aria-hidden="true"></span>
        <div class="tile-well">
          <button type="button" class="tile" role="tab" data-mode="weekly">
            <span class="tile-num"><span data-count="${round(weekly.value)}">${kcal(weekly.value)}</span><span class="avg-mark" title="Average">⌀</span></span>
            <span class="tile-label">Weekly</span>
          </button>
          <button type="button" class="tile" role="tab" data-mode="monthly">
            <span class="tile-num"><span data-count="${round(monthly.value)}">${kcal(monthly.value)}</span><span class="avg-mark" title="Average">⌀</span></span>
            <span class="tile-label">Monthly</span>
          </button>
        </div>
        <button type="button" class="tile tile-latest" role="tab" data-mode="latest">
          <span class="tile-num"><span data-count="${round(latest.tdee)}">${kcal(latest.tdee)}</span><small>kcal</small></span>
          <span class="tile-label">Latest · ${slashDate(anchor)}</span>
        </button>
      </div>
      <div class="readout-line" aria-live="polite">
        <span class="readout-text"></span>
        <span class="readout-val"><span class="rv-num"></span> kcal</span>
      </div>
      <div class="tchart-host"></div>
    </section>

    <section id="breakdown" class="breakdown"></section>`;

  const card = root.querySelector('.trend-card');
  const tiles = card.querySelector('.tiles');
  const thumb = card.querySelector('.tile-thumb');
  const text = card.querySelector('.readout-text');
  const val = card.querySelector('.rv-num');
  const chartHost = card.querySelector('.tchart-host');
  let points = [];

  const moveThumb = (animate) => {
    const btn = tiles.querySelector(`[data-mode="${mode}"]`);
    const a = tiles.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    thumb.style.transition = animate ? '' : 'none';
    thumb.style.width = `${b.width}px`;
    thumb.style.height = `${b.height}px`;
    thumb.style.transform = `translate(${b.left - a.left}px, ${b.top - a.top}px)`;
    if (!animate) requestAnimationFrame(() => { thumb.style.transition = ''; });
  };

  const showPoint = (i, animate = true) => {
    const p = points[i];
    if (!p) {
      text.textContent = 'Nothing logged in this stretch';
      val.textContent = '–';
      return;
    }
    const r = readout(mode, p, i === points.length - 1);
    text.textContent = r.text;
    val.textContent = kcal(r.value);
    val.dataset.count = round(r.value);
    if (animate) countUp(card.querySelector('.readout-val'), { duration: 450 });
    card.querySelector('.readout-line').classList.remove('bump');
    void card.offsetWidth;
    card.querySelector('.readout-line').classList.add('bump');
  };

  const showMode = (id, animate) => {
    mode = id;
    write(MODE_KEY, id);
    tiles.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === id)));
    moveThumb(animate);
    points = pointsFor(id, all, anchor);
    const fresh = chartHost.cloneNode(false);
    chartHost.replaceWith(fresh);
    trendChart(fresh, points, {
      label: `${MODES[id].label} TDEE`,
      xLabel: id === 'latest' ? (p) => `${weekday(p.date).slice(0, 2)} ${Number(p.date.slice(8))}` : (p) => shortDate(p.date),
      onSelect: (i) => showPoint(i),
    });
    showPoint(points.length - 1, animate);
  };

  showMode(mode, false);
  countUp(card);
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => (tiles.isConnected ? moveThumb(false) : ro.disconnect()));
    ro.observe(tiles);
  }

  tiles.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (btn && btn.dataset.mode !== mode) showMode(btn.dataset.mode, true);
  });
  tiles.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const ids = Object.keys(MODES);
    const next = ids[(ids.indexOf(mode) + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
    showMode(next, true);
    tiles.querySelector(`[data-mode="${next}"]`).focus();
  });

  const breakdown = root.querySelector('#breakdown');
  renderBreakdown(breakdown, all);
  breakdown.addEventListener('click', (e) => {
    const r = e.target.closest('[data-range]');
    if (r) {
      range = r.dataset.range;
      write(RANGE_KEY, range);
      renderBreakdown(breakdown, all);
      reveal(breakdown, { skip: '.section-head' });
      return;
    }
    const burn = e.target.closest('.burn');
    if (burn) onEdit?.(burn.dataset.date);
  });
}

/** Everything below the card, for the chosen range: allocation, work vs rest, top burns, weekly ranges. */
function renderBreakdown(host, all) {
  const anchor = all.at(-1).date;
  const { current, prior } = rangeWindows(all, range, anchor);
  const s = summarize(current);
  const p = summarize(prior);

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
  const heroDelta = s.avg !== null && p.avg !== null ? s.avg - p.avg : null;

  host.innerHTML = `
    <div class="section-head">
      <div>
        <h2>Breakdown</h2>
        <p class="section-sub">Avg ${kcal(s.avg)} kcal over ${s.count} day${s.count === 1 ? '' : 's'}${heroDelta === null ? '' : ` · <span class="delta ${deltaClass(heroDelta)}">${heroDelta >= 0 ? '▲' : '▼'} ${Math.abs(round(heroDelta)).toLocaleString()}</span> vs prior ${RANGE_WORDS[range]}`}</p>
      </div>
      <div class="seg" role="group" aria-label="Date range">
        ${Object.keys(RANGES).map((r) => `<button type="button" data-range="${r}" aria-pressed="${r === range}" class="${r === range ? 'active' : ''}">${r}</button>`).join('')}
      </div>
    </div>

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
          <div class="inset wr-inset work">
            <div class="inset-head"><span class="tag-label work">Work · ${workDays.length}D</span></div>
            <div class="inset-body"><span class="inset-num">${kcal(s.workAvg)}</span><span class="spark-host" data-spark="work"></span></div>
          </div>
          <div class="inset wr-inset rest">
            <div class="inset-head"><span class="tag-label rest">Rest · ${restDays.length}D</span></div>
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

  candleChart(host.querySelector('#candle-chart'), weeklyCandles(current));
  const work = host.querySelector('[data-spark="work"]');
  const rest = host.querySelector('[data-spark="rest"]');
  if (work) work.append(sparkline(workDays.map((d) => d.tdee), 'var(--work)'));
  if (rest) rest.append(sparkline(restDays.map((d) => d.tdee), 'var(--rest)'));
}
