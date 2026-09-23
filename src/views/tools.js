/** BPM / HRR calculator — cross-validation of task MET against corrected heart rate (§6, §12.8). */

import { BPM_CORRECTIONS, HRR_MET_TABLE } from '../data.js';
import { validateWithBpm } from '../engine.js';
import * as store from '../store.js';
import { esc, num, pct } from '../ui.js';

const state = { watchMin: '', watchMax: '', taskMet: '' };

function resultBlock(watchBpm, taskMet, label) {
  const settings = store.getSettings();
  const r = validateWithBpm({
    watchBpm,
    taskMet: taskMet === '' ? null : Number(taskMet),
    resting: settings.restingHr,
    max: settings.maxHr,
  });
  if (!r) return '';
  const impliedText = r.implied
    ? `${r.implied.metMin}–${r.impliedMax && r.impliedMax !== r.implied ? r.impliedMax.metMax : r.implied.metMax}`
    : 'below table floor';
  return `
    <div class="hrr-result">
      <div class="hrr-result-head">${esc(label)} — watch ${r.watchBpm} BPM</div>
      <div class="hrr-grid">
        <div><span class="stat-label">Correction</span><span class="stat-value sm">${esc(r.correction.note)}</span></div>
        <div><span class="stat-label">Corrected BPM</span><span class="stat-value sm">${r.correctedBpm}${r.correctedBpmMax !== r.correctedBpm ? `–${r.correctedBpmMax}` : ''}</span></div>
        <div><span class="stat-label">HRR%</span><span class="stat-value sm">${pct(r.hrr)}${r.hrrMax !== r.hrr ? `–${pct(r.hrrMax)}` : ''}</span></div>
        <div><span class="stat-label">Implied MET</span><span class="stat-value sm">${impliedText}</span></div>
      </div>
      <div class="callout ${r.verdict === 'revise-up' || r.verdict === 'revise-down' ? 'warn' : r.verdict === 'validates' ? 'ok' : 'info'}">${esc(r.message)}</div>
    </div>`;
}

export function render(root) {
  const settings = store.getSettings();

  root.innerHTML = `
    <div class="card-head"><h2>BPM &amp; HRR calculator <span class="sec-ref">§6 · §12.8</span></h2></div>

    <div class="callout warn">
      Correction factors (+30 / +35) come from a small number of manual pulse checks, not a validated device.
      Treat HRR-derived MET as directional confirmation, not ground truth.
    </div>

    <section class="card">
      <div class="grid grid-3">
        <label class="field"><span class="field-label">Watch BPM — low end of window</span><input type="number" id="watch-min" min="40" max="220" value="${esc(state.watchMin)}" placeholder="e.g. 118"></label>
        <label class="field"><span class="field-label">Watch BPM — high end of window</span><input type="number" id="watch-max" min="40" max="220" value="${esc(state.watchMax)}" placeholder="e.g. 141"></label>
        <label class="field"><span class="field-label">Task MET to cross-check</span><input type="number" id="task-met" step="0.1" min="0" max="16" value="${esc(state.taskMet)}" placeholder="e.g. 7.0"></label>
      </div>
      <p class="muted small">
        Resting HR ${settings.restingHr} bpm, estimated max ${settings.maxHr} bpm →
        HRR% = (corrected BPM − ${settings.restingHr}) / ${settings.maxHr - settings.restingHr}. Both editable in Settings.
      </p>
    </section>

    <div id="hrr-results"></div>

    <section class="card">
      <h3>Reference tables</h3>
      <div class="grid grid-2">
        <div>
          <h4>Watch correction factors</h4>
          <table class="table compact">
            <thead><tr><th>Intensity</th><th>Watch range</th><th class="right">Correction</th></tr></thead>
            <tbody>
              ${BPM_CORRECTIONS.map(
                (b) =>
                  `<tr><td>${esc(b.label)}</td><td>${b.watchMin}–${b.watchMax}</td><td class="right">+${b.add}${b.addMax !== b.add ? `–${b.addMax}` : ''} BPM</td></tr>`,
              ).join('')}
            </tbody>
          </table>
        </div>
        <div>
          <h4>HRR% → approximate MET</h4>
          <table class="table compact">
            <thead><tr><th>HRR %</th><th class="right">Approx. MET</th></tr></thead>
            <tbody>
              ${HRR_MET_TABLE.map(
                (r) => `<tr><td>${Math.round(r.hrrMin * 100)}–${Math.round(r.hrrMax * 100)}%</td><td class="right">${r.metMin}–${r.metMax}</td></tr>`,
              ).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `;

  const results = root.querySelector('#hrr-results');

  function update() {
    const blocks = [];
    if (state.watchMin !== '' && Number.isFinite(Number(state.watchMin))) {
      blocks.push(resultBlock(Number(state.watchMin), state.taskMet, 'Window low'));
    }
    if (state.watchMax !== '' && Number.isFinite(Number(state.watchMax))) {
      blocks.push(resultBlock(Number(state.watchMax), state.taskMet, 'Window high'));
    }
    results.innerHTML = blocks.length
      ? blocks.join('')
      : '<div class="empty">Enter a watch BPM reading to see the corrected value, HRR% and implied MET.</div>';
  }

  root.addEventListener('input', (e) => {
    if (e.target.id === 'watch-min') state.watchMin = e.target.value;
    if (e.target.id === 'watch-max') state.watchMax = e.target.value;
    if (e.target.id === 'task-met') state.taskMet = e.target.value;
    update();
  });

  update();
}
