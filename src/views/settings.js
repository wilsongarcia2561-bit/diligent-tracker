/** Settings — framework constants, the bodyweight log (§4), and local data management. */

import { BMR_KCAL, DEFAULT_BREAK_MINUTES, MAX_HR, RESTING_HR } from '../data.js';
import * as store from '../store.js';
import { confirmClick, esc, kgToLb, lbToKg, num, openTextPanel, toast, todayIso } from '../ui.js';

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

function draw(root) {
  const s = store.getSettings();
  const weights = store.listWeights().slice().reverse();

  root.innerHTML = `
    <div class="card-head"><h2>Settings</h2></div>

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
          <span class="hint">Spec value ${BMR_KCAL}. Measured via 8-electrode BIA — do not recalculate from population formulas.</span>
        </label>
        <label class="field">
          <span class="field-label">Default break length (min)</span>
          <input type="number" data-setting="breakMinutesDefault" value="${esc(s.breakMinutesDefault)}" step="1" min="0">
          <span class="hint">Spec value ${DEFAULT_BREAK_MINUTES} min per break session.</span>
        </label>
        <label class="field">
          <span class="field-label">Resting HR (bpm)</span>
          <input type="number" data-setting="restingHr" value="${esc(s.restingHr)}" step="1" min="20">
          <span class="hint">Spec value ${RESTING_HR} (confirmed range 47–52).</span>
        </label>
        <label class="field">
          <span class="field-label">Estimated max HR (bpm)</span>
          <input type="number" data-setting="maxHr" value="${esc(s.maxHr)}" step="1" min="100">
          <span class="hint">Spec value ${MAX_HR} (220 − 19). Individual max may run higher.</span>
        </label>
      </div>
    </section>

    <section class="card">
      <h3>Your data</h3>
      <p class="muted">Everything is stored in this browser's local storage. Nothing leaves the machine — export regularly if the data matters.</p>
      <div class="btn-row">
        <button type="button" class="btn" data-action="export">Back up (copy JSON)</button>
        <button type="button" class="btn ghost" data-action="import">Import JSON backup</button>
        <button type="button" class="btn danger" data-action="clear">Erase all data</button>
      </div>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
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
    } else if (action === 'import') {
      root.querySelector('#import-file').click();
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
