/** History — a statement ledger grouped by week, every day editable after the fact (§12.5). */

import { groupByWeek, mainTask, trailingAverage } from '../analytics.js';
import { calculateDay } from '../engine.js';
import { EXPORT_COLUMNS } from '../summaryImport.js';
import * as store from '../store.js';
import { esc, kcal, num, openTextPanel } from '../ui.js';

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

function ledgerDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${MONTHS[m - 1]} ${d}`;
}

function weekLabel(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `Week of ${MONTHS[m - 1]} ${d}`;
}

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

export function render(root, { onEdit }) {
  const entries = new Map(store.listEntries().map((e) => [e.date, e]));
  const days = calculatedDays({ includeUnusable: true });
  const usableDays = days.filter((d) => !d.unusable);

  if (!days.length) {
    root.innerHTML = `
      <div class="empty-state">
        <p class="eyebrow">History</p>
        <h2>No days logged yet</h2>
        <p class="muted">Log a day by hand, or bring in a whole month at once with <strong>Import from file</strong> on the Daily entry tab.</p>
        <button type="button" class="btn primary" data-action="go-log">Open Daily entry</button>
      </div>`;
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="go-log"]')) onEdit(null);
    });
    return;
  }

  const groups = groupByWeek(days);
  const body = groups
    .map((g) => {
      const head = `
        <tr class="week-row">
          <th colspan="6" scope="rowgroup">${weekLabel(g.week)}</th>
          <td colspan="2" class="week-meta">AVG <strong>${kcal(g.avg)}</strong> · ${g.workCount} work · ${g.restCount} rest${g.unusableCount ? ` · ${g.unusableCount} unusable` : ''}</td>
        </tr>`;
      const rows = g.rows
        .map((d) => {
          if (d.unusable) {
            const label = entries.get(d.date)?.taskLabel || mainTask(d) || 'No task logged';
            return `
            <tr class="ledger-row is-unusable" data-date="${d.date}">
              <td class="col-date">
                <button type="button" class="row-link" data-date="${d.date}">${ledgerDate(d.date)}</button>
                <span class="flag-dot" title="Unusable — left out of Trends and averages"></span>
              </td>
              <td class="col-task none" title="${esc(label)}"><span class="pill unusable">Unusable</span> ${esc(label)}</td>
              <td class="num">–</td><td class="num">–</td><td class="num">–</td><td class="num">–</td>
              <td class="num faint">–</td><td class="num"><span class="faint">–</span></td>
            </tr>`;
          }
          const avg = trailingAverage(usableDays, d.date);
          const delta = avg === null ? null : d.tdee - avg;
          const task = mainTask(d);
          const warn = d.flags.filter((f) => f.level !== 'info').length;
          return `
            <tr class="ledger-row${d.restDay ? ' is-rest' : ''}" data-date="${d.date}">
              <td class="col-date">
                <button type="button" class="row-link" data-date="${d.date}">${ledgerDate(d.date)}</button>
                ${warn ? `<span class="flag-dot" title="${warn} data-quality flag${warn === 1 ? '' : 's'} — open the day to review"></span>` : ''}
              </td>
              <td class="col-task${task ? '' : ' none'}" title="${esc(task)}">${esc(task || 'No task logged')}</td>
              <td class="num">${d.restDay ? '–' : hm(d.timing.netWorkMinutes)}</td>
              <td class="num">${d.restDay || d.feelsLikeF === null ? '–' : `${d.feelsLikeF}°F`}</td>
              <td class="num">${d.restDay ? '–' : kcal(d.components.active)}</td>
              <td class="num est">${kcal(d.components.neat + d.components.background)}</td>
              <td class="num strong">${kcal(d.tdee)}</td>
              <td class="num">${delta === null ? '<span class="faint">–</span>' : `<span class="delta-pill ${delta >= 0 ? 'up' : 'down'}">${signed(delta)}</span>`}</td>
            </tr>`;
        })
        .join('');
      return `<tbody>${head}${rows}</tbody>`;
    })
    .join('');

  root.innerHTML = `
    <div class="table-scroll">
      <table class="ledger">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Main task</th>
            <th scope="col" class="num">Net work</th>
            <th scope="col" class="num">Feels-like</th>
            <th scope="col" class="num">Active</th>
            <th scope="col" class="num">Est. lines</th>
            <th scope="col" class="num">TDEE</th>
            <th scope="col" class="num">vs 7D</th>
          </tr>
        </thead>
        ${body}
      </table>
    </div>
    <p class="footnote">
      <span class="est-tag">EST</span> Est. lines = post-work NEAT + background daily life, the two lowest-confidence
      components. vs 7D compares each day with the average of the 7 calendar days before it.
      <span class="flag-dot"></span> marks a day with data-quality warnings. <strong>Unusable</strong> days (no task description) are
      listed but left out of every average and of Trends.
    </p>`;

  root.addEventListener('click', (e) => {
    const row = e.target.closest('[data-date]');
    if (row) onEdit(row.dataset.date);
  });
}
