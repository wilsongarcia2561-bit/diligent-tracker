/** History — two weeks at a time, short rows that open in place, every day editable after the fact (§12.5). */

import { addDays, biweeks, mainTask, trailingAverage } from '../analytics.js';
import { calculateDay } from '../engine.js';
import { EXPORT_COLUMNS } from '../summaryImport.js';
import * as store from '../store.js';
import { countUp, esc, kcal, num, openTextPanel, reducedMotion, reveal, todayIso } from '../ui.js';

const resolveWeight = (entry) => store.resolveEntry(entry);

export function calculatedEntries() {
  return store
    .listEntries()
    .map((entry) => ({ entry, calc: calculateDay(resolveWeight(entry), store.getSettings()) }));
}

/**
 * Calculated days, oldest first — the shape analytics.js works on. Days marked
 * unusable are left out: they'd count as ~1,950 kcal work days in every average.
 */
export function calculatedDays({ includeUnusable = false } = {}) {
  return calculatedEntries()
    .map((r) => r.calc)
    .filter((c) => includeUnusable || !c.unusable)
    .sort((a, b) => a.date.localeCompare(b.date));
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function hm(minutes) {
  const total = Math.round(minutes);
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}`;
}

function signed(n) {
  const r = Math.round(n);
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toLocaleString()}`;
}

/** The day's work on the clock: "07:47-16:32", and lunch plus other non-work windows. */
function clockColumns(entry) {
  const shift = entry.shiftStart && entry.shiftEnd ? `${entry.shiftStart}-${entry.shiftEnd}` : '';
  const windows = [
    ...(entry.lunchStart && entry.lunchEnd ? [{ start: entry.lunchStart, end: entry.lunchEnd }] : []),
    ...(Array.isArray(entry.nonLaborWindows) ? entry.nonLaborWindows : []),
  ].filter((w) => w && w.start && w.end);
  return [shift, windows.map((w) => `${w.start}-${w.end}`).join(' ')];
}

export function toCsv(rows) {
  const header = EXPORT_COLUMNS;
  const lines = rows.map(({ entry, calc }) =>
    (calc.unusable
      ? [entry.date, 'false', mainTask(calc) || entry.taskLabel || '', '', calc.feelsLikeF ?? '', calc.siteCount, num(calc.weightKg, 1),
        Math.round(calc.components.bmr), '', '', '', '', '', '', calc.intakeKcal ?? '', '', calc.dataset?.tdee ?? '',
        ['UNUSABLE', ...calc.flags.filter((f) => f.level !== 'info').map((f) => f.text)].join('; '), ...clockColumns(entry)]
      : [
      entry.date,
      calc.restDay ? 'true' : 'false',
      mainTask(calc) || entry.taskLabel || '',
      Math.round(calc.timing.netWorkMinutes),
      calc.feelsLikeF ?? '',
      calc.siteCount,
      num(calc.weightKg, 1),
      Math.round(calc.components.bmr),
      Math.round(calc.components.active),
      Math.round(calc.components.neat),
      Math.round(calc.components.tef),
      Math.round(calc.components.background),
      Math.round(calc.tdee),
      Math.round(calc.comparison.raw),
      calc.intakeKcal ?? '',
      calc.balance === null ? '' : Math.round(calc.balance),
      calc.dataset?.tdee ?? '',
      calc.flags.map((f) => f.text).join('; '),
      ...clockColumns(entry),
    ])
      .map((v) => {
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(','),
  );
  return [header.join(','), ...lines].join('\n');
}

export function exportCsv() {
  const rows = calculatedEntries();
  if (!rows.length) return;
  openTextPanel({
    title: 'Export CSV',
    hint: `${rows.length} day${rows.length === 1 ? '' : 's'}, one row each with every TDEE component broken out. Paste into a .csv file or straight into a spreadsheet — and back into the app with Import or Paste text.`,
    text: toCsv(rows),
  });
}

/** "Nov 16 – 29", or "Oct 26 – Nov 8" across a month. */
function rangeLabel(start, end) {
  const [, m1, d1] = start.split('-').map(Number);
  const [, m2, d2] = end.split('-').map(Number);
  return m1 === m2 ? `${MONTHS[m1 - 1]} ${d1} – ${d2}` : `${MONTHS[m1 - 1]} ${d1} – ${MONTHS[m2 - 1]} ${d2}`;
}

function biweekTag(i) {
  return i === 0 ? 'This biweek' : i === 1 ? 'Last biweek' : `${i} biweeks ago`;
}

/**
 * The biweek's work (or rest) days as dots on stems across its 14 days, with
 * the all-time average for that kind of day dashed across, so the period
 * reads against the whole history. Plain SVG markup.
 */
function periodChart(b, list, allTimeAvg, tone) {
  const W = 132;
  const H = 64;
  const pad = { l: 4, r: 4, t: 8, b: 10 };
  const base = H - pad.b;
  const values = list.map((d) => d.tdee);
  if (!values.length) return `<svg class="pchart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><line class="pc-base" x1="${pad.l}" x2="${W - pad.r}" y1="${base}" y2="${base}"/></svg>`;
  const ref = allTimeAvg ?? values[0];
  const lo = Math.min(...values, ref) - 150;
  const hi = Math.max(...values, ref) + 100;
  const x = (iso) => pad.l + (Math.round((Date.parse(iso) - Date.parse(b.start)) / 86400000) / 13) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (base - pad.t);
  const marks = list.map((d, i) => {
    const cx = x(d.date).toFixed(1);
    const cy = y(d.tdee).toFixed(1);
    return `<line class="pc-stem" x1="${cx}" x2="${cx}" y1="${base}" y2="${cy}" style="--i:${i}"/><circle class="pc-dot ${tone}" cx="${cx}" cy="${cy}" r="3" style="--i:${i}"><title>${d.date}: ${kcal(d.tdee)} kcal</title></circle>`;
  }).join('');
  const avgLine = allTimeAvg === null ? '' : `<line class="pc-avg" x1="${pad.l}" x2="${W - pad.r}" y1="${y(allTimeAvg).toFixed(1)}" y2="${y(allTimeAvg).toFixed(1)}"/>`;
  return `<svg class="pchart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${list.length} ${tone} day${list.length === 1 ? '' : 's'} this biweek against the all-time ${tone}-day average">
    <line class="pc-base" x1="${pad.l}" x2="${W - pad.r}" y1="${base}" y2="${base}"/>${avgLine}${marks}</svg>`;
}

/** "▲ 120 vs all-time 2,865" under a work or rest figure. */
function vsAllTime(value, allTime) {
  if (value === null || allTime === null) return 'no all-time figure yet';
  const d = Math.round(value - allTime);
  return `${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toLocaleString()} vs all-time ${kcal(allTime)}`;
}

let selected = 0;

export function render(root, { onEdit }) {
  const entries = new Map(store.listEntries().map((e) => [e.date, e]));
  const days = calculatedDays({ includeUnusable: true });
  const usableDays = days.filter((d) => !d.unusable);

  const head = (sub) => `
    <header class="page-head" data-no-reveal>
      <p class="page-kicker">TDEE.</p>
      <div class="page-title-row">
        <h1 class="page-title">History.</h1>
        ${days.length ? '<button type="button" class="chip-btn" data-action="csv" title="Every day as CSV, to paste into a spreadsheet">CSV</button>' : ''}
      </div>
      <p class="page-sub">${sub}</p>
    </header>`;

  if (!days.length) {
    root.innerHTML = `${head('Nothing logged yet.')}
      <div class="empty-state">
        <h2>No days logged yet</h2>
        <p class="muted">Log a day by hand, or bring in a whole month at once with <strong>Import from file</strong> on the Daily entry tab.</p>
        <button type="button" class="btn primary" data-action="go-log">Open Daily entry</button>
      </div>`;
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="go-log"]')) onEdit(null);
    });
    return;
  }

  const today = todayIso();
  const periods = biweeks(days, today);
  selected = Math.min(selected, periods.length - 1);
  const byDate = new Map(days.map((d) => [d.date, d]));
  const meanOf = (list) => (list.length ? list.reduce((t, d) => t + d.tdee, 0) / list.length : null);
  const allWork = meanOf(usableDays.filter((d) => !d.restDay));
  const allRest = meanOf(usableDays.filter((d) => d.restDay));

  root.innerHTML = `${head('Two weeks at a time. Tap a day for detail.')}
    <div class="biweek-switch" role="tablist" aria-label="Two-week period" data-no-reveal>
      <span class="switch-thumb" aria-hidden="true"></span>
    </div>
    <div class="bw-body"></div>`;

  const sw = root.querySelector('.biweek-switch');
  const thumb = sw.querySelector('.switch-thumb');
  const body = root.querySelector('.bw-body');

  const moveThumb = (animate) => {
    const btn = sw.querySelector('[aria-selected="true"]');
    if (!btn) return;
    thumb.style.transition = animate ? '' : 'none';
    thumb.style.width = `${btn.offsetWidth}px`;
    thumb.style.transform = `translateX(${btn.offsetLeft}px)`;
    if (!animate) requestAnimationFrame(() => { thumb.style.transition = ''; });
  };

  const drawSwitch = () => {
    // The selected biweek and the one before it; the oldest pairs with the one after.
    const pair = selected < periods.length - 1 ? [selected, selected + 1] : [Math.max(0, selected - 1), selected];
    sw.querySelectorAll('button').forEach((b) => b.remove());
    for (const i of [...new Set(pair)]) {
      const b = periods[i];
      sw.insertAdjacentHTML('beforeend', `
        <button type="button" role="tab" data-bw="${i}" aria-selected="${i === selected}">
          <span class="bw-range">${rangeLabel(b.start, b.end)}</span>
          <span class="bw-tag">${biweekTag(i)}</span>
        </button>`);
    }
  };

  const row = (date) => {
    const d = byDate.get(date);
    const [y, m, dd] = date.split('-').map(Number);
    const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()];
    const dateHtml = `<span class="day-date"><b>${wd}</b> ${dd}</span>`;
    if (!d) {
      return `<li class="day" data-state="empty">
        <button type="button" class="day-row" data-log="${date}">
          <span class="day-mark"></span>${dateHtml}
          <span class="day-task">Not logged · tap to log</span>
          <span class="day-kcal"></span><span class="day-go" aria-hidden="true">+</span>
        </button></li>`;
    }
    if (d.unusable) {
      const label = entries.get(date)?.taskLabel || mainTask(d) || 'No task logged';
      return `<li class="day" data-state="unusable">
        <button type="button" class="day-row" data-open="${date}" title="Left out of every average and of Trends">
          <span class="day-mark"></span>${dateHtml}
          <span class="day-task"><span class="pill unusable">Unusable</span> ${esc(label)}</span>
          <span class="day-kcal">–</span><span class="day-go" aria-hidden="true">›</span>
        </button></li>`;
    }
    const avg = trailingAverage(usableDays, date);
    const delta = avg === null ? null : d.tdee - avg;
    const task = d.restDay ? 'Rest day' : mainTask(d) || 'No task logged';
    const warn = d.flags.filter((f) => f.level !== 'info');
    const fact = (k, v) => `<div class="fact"><span class="fact-k">${k}</span><span class="fact-v">${v}</span></div>`;
    return `<li class="day" data-state="${d.restDay ? 'rest' : 'work'}">
      <button type="button" class="day-row" data-toggle aria-expanded="false" aria-controls="dd-${date}">
        <span class="day-mark"></span>${dateHtml}
        <span class="day-task">${esc(task)}${warn.length ? '<span class="flag-dot" title="Has data-quality warnings"></span>' : ''}</span>
        <span class="day-kcal">${kcal(d.tdee)}</span><span class="day-go chev" aria-hidden="true"></span>
      </button>
      <div class="day-detail" id="dd-${date}"><div class="day-detail-inner">
        <div class="facts">
          ${d.restDay ? fact('Walking', `${kcal(d.walking?.kcal ?? d.components.active)} kcal`) : fact('Net work', hm(d.timing.netWorkMinutes))}
          ${d.restDay ? '' : fact('Feels-like', d.feelsLikeF === null ? '–' : `${d.feelsLikeF}°F`)}
          ${d.restDay ? '' : fact('MET', d.blendedMet === null ? '–' : num(d.blendedMet, 2))}
          ${d.restDay ? '' : fact('Active', kcal(d.components.active))}
          ${fact('Est. lines', kcal(d.components.neat + d.components.background))}
          ${fact('vs 7D', delta === null ? '–' : signed(delta))}
        </div>
        ${warn.length ? `<p class="day-warn">${warn.length} data-quality warning${warn.length === 1 ? '' : 's'} — open the day to review.</p>` : ''}
        <button type="button" class="btn sm" data-open="${date}">Open day</button>
      </div></div>
    </li>`;
  };

  const drawBody = (animate) => {
    const b = periods[selected];
    const list = [];
    for (let date = b.shown; date >= b.start; date = addDays(date, -1)) list.push(row(date));
    const big = (v) => (v === null ? '–' : `<span data-count="${Math.round(v)}">${kcal(v)}</span>`);
    const usable = b.days.filter((d) => !d.unusable);
    body.innerHTML = `
      <section class="bw-summary">
        <p class="kicker">Avg TDEE</p>
        <div class="bw-avg-row">
          <span class="big-num">${big(b.avg)}<small>kcal</small></span>
          <span class="bw-logged">${b.logged} of 14 days logged${b.unusableCount ? ` · ${b.unusableCount} unusable` : ''}</span>
        </div>
        <div class="wr-cards">
          <div class="wr work">
            <div class="wr-text"><p class="kicker">Work · ${b.workCount}D</p><span class="wr-num">${big(b.workAvg)}</span><span class="wr-sub">${vsAllTime(b.workAvg, allWork)}</span></div>
            ${periodChart(b, usable.filter((d) => !d.restDay), allWork, 'work')}
          </div>
          <div class="wr rest">
            <div class="wr-text"><p class="kicker">Rest · ${b.restCount}D</p><span class="wr-num">${big(b.restAvg)}</span><span class="wr-sub">${vsAllTime(b.restAvg, allRest)}</span></div>
            ${periodChart(b, usable.filter((d) => d.restDay), allRest, 'rest')}
          </div>
        </div>
      </section>
      <ol class="day-list">${list.join('') || '<li class="day-none">This biweek hasn’t started yet.</li>'}</ol>
      ${periods.length > 1 ? `
      <section class="archive" aria-labelledby="archive-title">
        <div class="archive-head"><h2 id="archive-title">Archive</h2><span class="meta">${periods.length} biweeks</span></div>
        <ol class="archive-list">
          ${periods.map((p, i) => `
            <li><button type="button" class="archive-row${i === selected ? ' on' : ''}" data-pick="${i}" ${i === selected ? 'aria-current="true"' : ''}>
              <span class="ar-main"><span class="ar-range">${rangeLabel(p.start, p.end)}</span><span class="ar-tag">${biweekTag(i)}</span></span>
              <span class="ar-meta">${p.logged} day${p.logged === 1 ? '' : 's'}</span>
              <span class="ar-avg">${p.avg === null ? '–' : kcal(p.avg)}</span>
            </button></li>`).join('')}
        </ol>
      </section>` : ''}
      <p class="footnote">Est. lines are post-work NEAT plus background daily life, the two lowest-confidence components. vs 7D compares a day with the 7 calendar days before it. <strong>Unusable</strong> days are listed but left out of every average and of Trends.</p>`;
    countUp(body);
    if (animate) reveal(body);
  };

  const choose = (i) => {
    if (i === selected) return;
    const forward = i < selected;
    selected = i;
    drawSwitch();
    requestAnimationFrame(() => moveThumb(true));
    body.classList.remove('slide-l', 'slide-r');
    void body.offsetWidth;
    body.classList.add(forward ? 'slide-l' : 'slide-r');
    drawBody(true);
  };

  drawSwitch();
  drawBody(false);
  requestAnimationFrame(() => moveThumb(false));

  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="csv"]')) {
      exportCsv();
      return;
    }
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      choose(Number(pick.dataset.pick));
      sw.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
      return;
    }
    const tab = e.target.closest('[data-bw]');
    if (tab) {
      choose(Number(tab.dataset.bw));
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) {
      onEdit(open.dataset.open);
      return;
    }
    const log = e.target.closest('[data-log]');
    if (log) {
      onEdit(log.dataset.log);
      return;
    }
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const on = toggle.getAttribute('aria-expanded') !== 'true';
      body.querySelectorAll('[data-toggle][aria-expanded="true"]').forEach((t) => t.setAttribute('aria-expanded', 'false'));
      toggle.setAttribute('aria-expanded', String(on));
    }
  });
}
