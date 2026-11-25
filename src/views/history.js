/** History — two weeks at a time, short rows that open in place, every day editable after the fact (§12.5). */

import { addDays, biweeks, mainTask, trailingAverage } from '../analytics.js';
import { calculateDay } from '../engine.js';
import { EXPORT_COLUMNS } from '../summaryImport.js';
import * as store from '../store.js';
import { countUp, esc, kcal, num, openTextPanel, reveal, todayIso } from '../ui.js';

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

let selected = 0;

export function render(root, { onEdit }) {
  const entries = new Map(store.listEntries().map((e) => [e.date, e]));
  const days = calculatedDays({ includeUnusable: true });
  const usableDays = days.filter((d) => !d.unusable);
  document.querySelectorAll('[data-view-owned]').forEach((n) => n.remove());

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
    body.innerHTML = `
      <section class="bw-summary">
        <p class="kicker">Avg TDEE</p>
        <div class="bw-avg-row">
          <span class="big-num">${big(b.avg)}<small>kcal</small></span>
          <span class="bw-logged">${b.logged} of 14 days logged${b.unusableCount ? ` · ${b.unusableCount} unusable` : ''}</span>
        </div>
        <div class="wr-cards">
          <div class="wr work"><p class="kicker">Work · ${b.workCount}D</p><span class="wr-num">${big(b.workAvg)}</span></div>
          <div class="wr rest"><p class="kicker">Rest · ${b.restCount}D</p><span class="wr-num">${big(b.restAvg)}</span></div>
        </div>
      </section>
      <ol class="day-list">${list.join('') || '<li class="day-none">This biweek hasn’t started yet.</li>'}</ol>
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
    island?.querySelector('.island-count')?.replaceChildren(rangeLabel(periods[selected].start, periods[selected].end));
  };

  drawSwitch();
  drawBody(false);
  requestAnimationFrame(() => moveThumb(false));

  // Older biweeks live behind the Archive island, bottom-center.
  let island = null;
  if (periods.length > 2) {
    island = document.createElement('button');
    island.type = 'button';
    island.className = 'archive-island';
    island.dataset.viewOwned = '';
    island.innerHTML = `<span class="island-label">Archive</span><span class="island-count">${rangeLabel(periods[selected].start, periods[selected].end)}</span>`;
    document.body.append(island);
    island.addEventListener('click', () => openArchive(periods, selected, choose));
  }

  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="csv"]')) {
      exportCsv();
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

/** The archive sheet: every biweek with its average, newest first. */
function openArchive(periods, selected, choose) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.dataset.viewOwned = '';
  backdrop.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="archive-title">
      <div class="sheet-grip" aria-hidden="true"></div>
      <div class="sheet-head"><h2 id="archive-title">Archive</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
      <ol class="archive-list">
        ${periods.map((b, i) => `
          <li><button type="button" class="archive-row${i === selected ? ' on' : ''}" data-pick="${i}">
            <span class="ar-main"><span class="ar-range">${rangeLabel(b.start, b.end)}</span><span class="ar-tag">${biweekTag(i)}</span></span>
            <span class="ar-meta">${b.logged} day${b.logged === 1 ? '' : 's'}</span>
            <span class="ar-avg">${b.avg === null ? '–' : kcal(b.avg)}</span>
          </button></li>`).join('')}
      </ol>
    </div>`;
  const close = () => {
    backdrop.classList.add('leaving');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => backdrop.remove(), 220);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      choose(Number(pick.dataset.pick));
      close();
    } else if (e.target === backdrop || e.target.closest('[data-close]')) {
      close();
    }
  });
  document.body.append(backdrop);
  backdrop.querySelector(`[data-pick="${selected}"]`)?.focus();
}
