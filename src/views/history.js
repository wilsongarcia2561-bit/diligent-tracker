/** History log — every stored day, with its calculated TDEE, editable after the fact. */

import { MODEL_LABELS, calculateDay, formatDuration } from '../engine.js';
import * as store from '../store.js';
import { download, esc, kcal, num, prettyDate } from '../ui.js';

function resolveWeight(entry) {
  if (entry.weightKg !== '' && Number(entry.weightKg) > 0) return entry;
  return { ...entry, weightKg: store.weightForDate(entry.date) };
}

export function calculatedEntries() {
  return store
    .listEntries()
    .map((entry) => ({ entry, calc: calculateDay(resolveWeight(entry), store.getSettings()) }));
}

function toCsv(rows) {
  const header = [
    'date',
    'rest_day',
    'net_work_minutes',
    'feels_like_f',
    'sites',
    'weight_kg',
    'bmr',
    'active_kcal',
    'neat_kcal',
    'tef_kcal',
    'background_kcal',
    'tdee_kcal',
    'kcal_raw_comparison',
    'intake_kcal',
    'balance_kcal',
    'models_used',
    'flags',
  ];
  const lines = rows.map(({ entry, calc }) =>
    [
      entry.date,
      calc.restDay ? 'yes' : 'no',
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

export function render(root, { onEdit }) {
  const rows = calculatedEntries();

  root.innerHTML = `
    <div class="card-head">
      <h2>History log <span class="sec-ref">§12.5</span></h2>
      <div class="btn-row">
        <button type="button" class="btn ghost" data-action="export-csv" ${rows.length ? '' : 'disabled'}>Export CSV</button>
      </div>
    </div>
    ${
      rows.length
        ? `<table class="table history">
            <thead>
              <tr>
                <th>Date</th><th class="right">Net work</th><th class="right">Feels-like</th>
                <th class="right">Active</th><th class="right">Est. lines</th><th class="right">TDEE</th>
                <th>Models</th><th class="right">Flags</th><th></th>
              </tr>
            </thead>
            <tbody>
              ${rows
                .map(
                  ({ entry, calc }) => `
                <tr data-date="${entry.date}">
                  <td><strong>${esc(prettyDate(entry.date))}</strong>${calc.restDay ? '<span class="sub">rest day</span>' : ''}</td>
                  <td class="right">${calc.restDay ? '—' : formatDuration(calc.timing.netWorkMinutes)}</td>
                  <td class="right">${calc.feelsLikeF === null ? '—' : `${calc.feelsLikeF}°F`}</td>
                  <td class="right">${kcal(calc.components.active)}</td>
                  <td class="right est">${kcal(calc.components.neat + calc.components.background)}</td>
                  <td class="right strong">${kcal(calc.tdee)}</td>
                  <td>${[...new Set(calc.phases.map((p) => MODEL_LABELS[p.model]))].map((m) => `<span class="pill ${m === 'KRI' ? 'kri' : 'intermediate'}">${m}</span>`).join('') || '—'}</td>
                  <td class="right">${calc.flags.filter((f) => f.level !== 'info').length || '—'}</td>
                  <td class="right"><button type="button" class="link-btn" data-action="edit" data-date="${entry.date}">Edit</button></td>
                </tr>`,
                )
                .join('')}
            </tbody>
          </table>
          <p class="muted small">Columns marked <span class="est">est.</span> combine post-work NEAT and background daily life — the two lowest-confidence lines in the framework.</p>`
        : '<div class="empty">No days logged yet. Start on the <strong>Daily entry</strong> tab.</div>'
    }
  `;

  root.addEventListener('click', (e) => {
    const action = e.target.dataset.action;
    if (action === 'edit') onEdit(e.target.dataset.date);
    if (action === 'export-csv') download('diligent3-history.csv', toCsv(rows), 'text/csv');
  });
}
