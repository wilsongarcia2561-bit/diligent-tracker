/** Settings — palette, framework constants, the bodyweight log (§4), and local data management. */

import { BMR_KCAL, DEFAULT_BREAK_MINUTES, MAX_HR, RESTING_HR } from '../data.js';
import * as store from '../store.js';
import { PALETTES, SWATCH_ORDER, applyPalette, paletteId } from '../theme.js';
import { summarize, addDays } from '../analytics.js';
import { calculatedDays } from './history.js';
import { confirmClick, esc, kcal, kgToLb, lbToKg, num, openPastePanel, openTextPanel, toast, todayIso } from '../ui.js';

/**
 * Listeners attach once, here; redraws after an edit only replace markup.
 * (Re-running render() used to stack another set of handlers on the same
 * root each time, so one click ran every stacked handler — a single click on
 * "Erase all data" could arm and confirm itself.)
 */
export function render(root, { onChange }) {
  draw(root);
  attach(root, onChange);
}

/** Last 30 logged days' average, work and rest TDEE: what each palette card previews. */
function previewFigures() {
  const all = calculatedDays();
  if (!all.length) return { avg: 2914, work: 3388, rest: 1946, sample: true };
  const from = addDays(all.at(-1).date, -29);
  const s = summarize(all.filter((d) => d.date >= from));
  return { avg: s.avg, work: s.workAvg, rest: s.restAvg, sample: false };
}

function paletteSection(current) {
  const f = previewFigures();
  const card = (p) => {
    const c = p.colors;
    const style = `--p-base:${c.base};--p-card:${c.card};--p-text:${c.text};--p-work:${c.work};--p-rest:${c.rest};--p-line:${c.line}`;
    return `
      <button type="button" class="palette-opt" role="radio" aria-checked="${current === p.id}" data-palette-pick="${p.id}" style="${style}">
        <span class="po-head"><span class="po-name">${esc(p.name)}</span><span class="po-tag">${esc(p.tag)}</span></span>
        <span class="po-blurb">${esc(p.blurb)}</span>
        <span class="po-swatches">
          ${SWATCH_ORDER.map((k) => `<span class="po-sw"><i style="background:${c[k]}"></i><b>${k[0].toUpperCase()}${k.slice(1)}</b><code>${c[k]}</code></span>`).join('')}
        </span>
        <span class="po-preview">
          <span class="po-fig"><small>Avg</small><strong>${kcal(f.avg)}</strong></span>
          <span class="po-fig work"><small>Work</small><strong>${kcal(f.work)}</strong></span>
          <span class="po-fig rest"><small>Rest</small><strong>${kcal(f.rest)}</strong></span>
        </span>
      </button>`;
  };
  return `
    <section class="card palette-card" data-no-reveal>
      <div class="card-head">
        <h3>Palette</h3>
        <span class="meta">Work and rest get one color each, used for nothing else.</span>
      </div>
      <div class="palette-auto">
        <button type="button" class="chip-btn" role="radio" aria-checked="${current === 'auto'}" data-palette-pick="auto">Match device</button>
        <span class="muted small">Field in light mode, Clay &amp; Slate in dark.${f.sample ? '' : ' Previews show your last 30 logged days.'}</span>
      </div>
      <div class="palette-grid" role="radiogroup" aria-label="Palette">
        ${PALETTES.map(card).join('')}
      </div>
    </section>`;
}

function draw(root) {
  const s = store.getSettings();
  const weights = store.listWeights().slice().reverse();
  const hrDates = store.heartRateDates();

  root.innerHTML = `
    <header class="page-head" data-no-reveal>
      <p class="page-kicker">TDEE.</p>
      <h1 class="page-title">Settings.</h1>
      <p class="page-sub">Palette, bodyweight, constants and your data.</p>
    </header>

    ${paletteSection(paletteId(s.palette))}

    <section class="card">
      <h3>Bodyweight log <span class="sec-ref">§4</span></h3>
      <p class="muted">Update only from fasted, morning, post-bathroom readings. Each day's calculation uses the most recent reading on or before that date.</p>
      <div class="grid grid-4 align-end">
        <label class="field"><span class="field-label">Date</span><input type="date" id="w-date" value="${todayIso()}"></label>
        <label class="field"><span class="field-label">Weight kg</span><input type="number" id="w-kg" step="0.1" min="0" placeholder="57.6"></label>
        <label class="field"><span class="field-label">or lb</span><input type="number" id="w-lb" step="0.1" min="0" placeholder="127"></label>
        <button type="button" class="btn" id="w-add">Add reading</button>
      </div>
      ${
        weights.length
          ? `<table class="table compact">
              <thead><tr><th>Date</th><th class="right">kg</th><th class="right">lb</th><th>Note</th><th></th></tr></thead>
              <tbody>
                ${weights
                  .map(
                    (w, i) => `<tr>
                      <td>${esc(w.date)}${i === 0 ? '<span class="pill current">current</span>' : ''}</td>
                      <td class="right">${num(w.kg, 1)}</td>
                      <td class="right">${num(kgToLb(w.kg), 1)}</td>
                      <td class="muted">${esc(w.note || '')}</td>
                      <td class="right"><button type="button" class="link-btn danger" data-action="del-weight" data-date="${w.date}">Remove</button></td>
                    </tr>`,
                  )
                  .join('')}
              </tbody>
            </table>`
          : '<div class="empty">No readings logged.</div>'
      }
    </section>

    <section class="card">
      <h3>Framework constants</h3>
      <p class="muted">Defaults come straight from the spec. Change these only when the underlying measurement changes.</p>
      <div class="grid grid-2">
        <label class="field">
          <span class="field-label">BMR (kcal/day)</span>
          <input type="number" data-setting="bmr" value="${esc(s.bmr)}" step="1" min="0">
          <span class="hint">Spec value ${BMR_KCAL}. Fixed constant — never recalculated per day.</span>
        </label>
        <label class="field">
          <span class="field-label">Default break length (min)</span>
          <input type="number" data-setting="breakMinutesDefault" value="${esc(s.breakMinutesDefault)}" step="1" min="0">
          <span class="hint">Spec value ${DEFAULT_BREAK_MINUTES} min per break session.</span>
        </label>
      </div>
    </section>

    <section class="card">
      <h3>Watch heart rate <span class="sec-ref">§4</span></h3>
      <p class="muted">Readings from a Samsung Health heart-rate export (Import from file on the Daily entry tab) are used as recorded — no correction — to check each work day’s MET.</p>
      <div class="grid grid-2">
        <label class="field">
          <span class="field-label">Resting heart rate (bpm)</span>
          <input type="number" data-setting="restingHr" value="${esc(s.restingHr)}" step="1" min="30" max="110">
          <span class="hint">Spec value ${RESTING_HR}.</span>
        </label>
        <label class="field">
          <span class="field-label">Max heart rate (bpm)</span>
          <input type="number" data-setting="maxHr" value="${esc(s.maxHr)}" step="1" min="120" max="240">
          <span class="hint">Spec value ${MAX_HR}. HRR = (HR − resting) ÷ (max − resting).</span>
        </label>
      </div>
      ${hrDates.length
        ? `<p class="muted small">Stored: ${hrDates.length} day${hrDates.length === 1 ? '' : 's'} of readings, ${esc(hrDates[0])} to ${esc(hrDates.at(-1))}.</p>
           <div class="btn-row"><button type="button" class="btn danger" data-action="clear-hr">Remove heart-rate data</button></div>`
        : '<p class="muted small">No heart-rate readings stored yet.</p>'}
    </section>

    <section class="card">
      <h3>Your data</h3>
      <p class="muted">Everything is kept in this browser’s local storage (and synced to your private area inside the artifact). Export regularly if the data matters.</p>
      <div class="btn-row">
        <button type="button" class="btn" data-action="export">Back up (copy JSON)</button>
        <label class="btn ghost" for="import-file">Import JSON backup</label>
        <button type="button" class="btn ghost" data-action="import-paste">Paste JSON backup</button>
        <button type="button" class="btn danger" data-action="clear">Erase all data</button>
      </div>
      <input type="file" id="import-file" class="pick-input">
    </section>

    <section class="card">
      <h3>Sync across devices</h3>
      <p class="muted">Inside the artifact, every day, its heart-rate readings, every weight reading and setting is also saved to your own private area, so your phone and laptop show the same data. Only you can read it, even if you share this page. This device keeps a working copy, so the app still opens instantly and works offline.</p>
      <p class="sync-line" data-sync-line data-state="off"></p>
      <div class="btn-row">
        <button type="button" class="btn" data-action="sync-now">Retry sync now</button>
      </div>
    </section>

    <section class="card">
      <h3>Not implemented</h3>
      <ul class="ref-list muted">
        <li>Samsung Health screenshot OCR (spec §12.9, stretch goal) — active minutes are entered by hand per phase instead.</li>
        <li>Full MyFitnessPal integration (spec §12.10, stretch goal) — a single daily intake field covers deficit/surplus tracking and TEF adjustment.</li>
      </ul>
    </section>
  `;
}

function attach(root, onChange) {
  root.addEventListener('input', (e) => {
    const key = e.target.dataset.setting;
    if (key) {
      store.updateSettings({ [key]: Number(e.target.value) });
      onChange?.();
    }
    if (e.target.id === 'w-kg' && e.target.value !== '') {
      root.querySelector('#w-lb').value = kgToLb(e.target.value).toFixed(1);
    }
    if (e.target.id === 'w-lb' && e.target.value !== '') {
      root.querySelector('#w-kg').value = lbToKg(e.target.value).toFixed(1);
    }
  });

  root.addEventListener('click', (e) => {
    const action = e.target.dataset.action;

    const pick = e.target.closest('[data-palette-pick]');
    if (pick) {
      const id = paletteId(pick.dataset.palettePick);
      store.updateSettings({ palette: id });
      applyPalette(id, { animate: true });
      root.querySelectorAll('[data-palette-pick]').forEach((b) => b.setAttribute('aria-checked', String(paletteId(b.dataset.palettePick) === id)));
      onChange?.();
      return;
    }

    if (e.target.id === 'w-add') {
      const date = root.querySelector('#w-date').value;
      const kg = Number(root.querySelector('#w-kg').value);
      if (!date || !kg) {
        toast('Enter a date and a weight.', 'warn');
        return;
      }
      store.upsertWeight({ date, kg: Math.round(kg * 10) / 10, note: '' });
      toast('Weight logged');
      draw(root);
      onChange?.();
      return;
    }

    if (action === 'del-weight') {
      store.deleteWeight(e.target.dataset.date);
      draw(root);
      onChange?.();
    } else if (action === 'export') {
      openTextPanel({
        title: 'Backup',
        hint: `Everything this browser holds: every day, the weight log and settings. Paste it into a file named diligent3-backup-${todayIso()}.json to keep it; Import restores it.`,
        text: store.exportJson(),
      });
    } else if (action === 'import-paste') {
      openPastePanel({
        title: 'Paste a JSON backup',
        hint: 'Paste the whole backup text. It replaces everything on this device, and on your other synced devices.',
        submit: 'Restore',
        onSubmit: (text) => {
          try {
            store.importJson(text);
            toast('Backup imported');
            draw(root);
            onChange?.();
          } catch (err) {
            toast(err.message || 'That doesn’t look like a backup.', 'warn');
          }
        },
      });
    } else if (action === 'clear-hr') {
      if (confirmClick(e.target, 'Remove all heart-rate readings? Click again')) {
        store.clearHeartRate();
        toast('Heart-rate readings removed', 'warn');
        draw(root);
        onChange?.();
      }
    } else if (action === 'clear') {
      if (confirmClick(e.target, 'Erase everything? Click again')) {
        store.clearAll();
        toast('All data erased', 'warn');
        draw(root);
        onChange?.();
      }
    }
  });

  // Delegated: the file input is recreated by every draw().
  root.addEventListener('change', async (e) => {
    if (e.target.id !== 'import-file') return;
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      store.importJson(await file.text());
      toast('Backup imported');
      draw(root);
      onChange?.();
    } catch (err) {
      toast(err.message || 'Could not read that file.', 'warn');
    }
  });
}
