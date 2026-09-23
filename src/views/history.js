/** History — a statement ledger grouped by week, every day editable after the fact (§12.5). */

import { groupByWeek, mainTask, trailingAverage } from '../analytics.js';
import { MODEL_LABELS, calculateDay } from '../engine.js';
import * as store from '../store.js';
import { esc, kcal, num, openTextPanel } from '../ui.js';

function resolveWeight(entry) {
  if (entry.weightKg !== '' && Number(entry.weightKg) > 0) return entry;
  return { ...entry, weightKg: store.weightForDate(entry.date) };
}

export function calculatedEntries() {
  return store
    .listEntries()
    .map((entry) => ({ entry, calc: calculateDay(resolveWeight(entry), store.getSettings()) }));
}

/** Calculated days only, oldest first — the shape analytics.js works on. */
export function calculatedDays() {
  return calculatedEntries()
    .map((r) => r.calc)
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

function toCsv(rows) {
  const header = [
    'date', 'rest_day', 'main_task', 'net_work_minutes', 'feels_like_f', 'sites', 'weight_kg',
    'bmr', 'active_kcal', 'neat_kcal', 'tef_kcal', 'background_kcal', 'tdee_kcal',
    'kcal_raw_comparison', 'intake_kcal', 'balance_kcal', 'models_used', 'flags',
  ];
  const lines = rows.map(({ entry, calc }) =>
    [
      entry.date,
      calc.restDay ? 'yes' : 'no',
      mainTask(calc),
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
      [...new Set(calc.phases.map((p) => MODEL_LABELS[p.model]))].join(' + '),
      calc.flags.length,
    ]
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
    hint: `${rows.length} day${rows.length === 1 ? '' : 's'}, one row each with every TDEE component broken out. Paste into a .csv file or straight into a spreadsheet.`,
    text: toCsv(rows),
  });
}

export function render(root, { onEdit }) {
  const days = calculatedDays();

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
          <td colspan="2" class="week-meta">AVG <strong>${kcal(g.avg)}</strong> · ${g.workCount} work · ${g.restCount} rest</td>
        </tr>`;
      const rows = g.rows
        .map((d) => {
          const avg = trailingAverage(days, d.date);
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
      <span class="flag-dot"></span> marks a day with data-quality warnings.
    </p>`;

  root.addEventListener('click', (e) => {
    const row = e.target.closest('[data-date]');
    if (row) onEdit(row.dataset.date);
  });
}
