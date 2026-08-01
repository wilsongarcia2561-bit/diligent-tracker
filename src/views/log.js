/**
 * Daily entry view — the main working screen.
 *
 * The form is rendered from the draft entry and only rebuilt on structural
 * changes (adding/removing a phase, switching day). Field edits update the draft
 * in place and re-render just the results panel, so focus is never stolen.
 */

import {
  BACKGROUND_TIERS,
  CAPTURE_CATEGORIES,
  DAY_UNCERTAINTY_KCAL,
  NEAT_TIERS,
  SOIL_CLASSES,
  TASK_METS,
} from '../data.js';
import {
  MODEL,
  MODEL_FORMULAS,
  MODEL_LABELS,
  durationMinutes,
  formatDuration,
  calculateDay,
  suggestMet,
} from '../engine.js';
import { stackedBar } from '../charts.js';
import * as store from '../store.js';
import { debounce, esc, kcal, num, pct, prettyDate, toast, todayIso } from '../ui.js';

let draft = null;
let dirty = false;

const COMPONENT_COLORS = {
  bmr: 'var(--c-bmr)',
  active: 'var(--c-active)',
  neat: 'var(--c-neat)',
  tef: 'var(--c-tef)',
  background: 'var(--c-bg)',
};

const save = debounce(() => {
  if (!draft || !draft.date) return;
  store.saveEntry(draft);
  dirty = false;
  const badge = document.getElementById('save-state');
  if (badge) {
    badge.textContent = 'Saved';
    badge.className = 'save-state saved';
  }
}, 500);

function markDirty() {
  dirty = true;
  const badge = document.getElementById('save-state');
  if (badge) {
    badge.textContent = 'Saving…';
    badge.className = 'save-state pending';
  }
  save();
}

export function loadDate(date) {
  const existing = store.getEntry(date);
  draft = existing
    ? JSON.parse(JSON.stringify(existing))
    : { ...store.newEntry(date), weightKg: '' };
  if (!draft.phases || draft.phases.length === 0) draft.phases = [store.newPhase()];
  dirty = false;
}

export function getDraft() {
  return draft;
}

/* ------------------------------- templates ------------------------------- */

function field(label, inner, hint) {
  return `<label class="field">
    <span class="field-label">${label}</span>
    ${inner}
    ${hint ? `<span class="hint">${hint}</span>` : ''}
  </label>`;
}

function input(fieldName, value, attrs = '') {
  return `<input data-field="${fieldName}" value="${esc(value ?? '')}" ${attrs}>`;
}

function phaseInput(id, fieldName, value, attrs = '') {
  return `<input data-phase="${id}" data-field="${fieldName}" value="${esc(value ?? '')}" ${attrs}>`;
}

function soilOptions(selected) {
  return [
    '<option value="">— none —</option>',
    ...SOIL_CLASSES.map(
      (s) =>
        `<option value="${s.code}" ${s.code === selected ? 'selected' : ''}>${s.code} — ${esc(s.name)} (MET ${s.metMin}–${s.metMax})${s.kriTrigger ? ' · KRI' : ''}</option>`,
    ),
  ].join('');
}

function captureOptions(selected) {
  return [
    '<option value="">— not set —</option>',
    ...Object.entries(CAPTURE_CATEGORIES).map(
      ([key, cat]) =>
        `<option value="${key}" ${key === selected ? 'selected' : ''}>${esc(cat.label)} (${Math.round(cat.min * 100)}–${Math.round(cat.max * 100)}%)</option>`,
    ),
  ].join('');
}

function allocText(result) {
  if (!result) return 'Leave blank to prorate';
  return `Allocated: ${formatDuration(result.netMinutes)}${result.exactNet ? ' (exact)' : ' (prorated)'}`;
}

function phaseCard(phase, index, calc) {
  const result = calc.phases.find((p) => p.id === phase.id);
  const suggestion = suggestMet(phase.description, phase.soilCode);
  const autoLabel = result ? MODEL_LABELS[result.autoModel] : '—';
  const reasons = result && result.kriReasons.length ? result.kriReasons.join(' · ') : 'No KRI trigger — Intermediate applies';

  return `<div class="phase" data-phase-card="${phase.id}">
    <div class="phase-head">
      <span class="phase-index">Phase ${index + 1}</span>
      ${result ? `<span class="phase-kcal">${kcal(result.kcal)} kcal</span>` : ''}
      <button type="button" class="icon-btn" data-action="remove-phase" data-phase="${phase.id}" title="Remove phase">✕</button>
    </div>

    <div class="grid grid-2">
      ${field('Task description', `${phaseInput(phase.id, 'description', phase.description, 'list="task-list" placeholder="e.g. wet sod wheelbarrow to back slope"')}`)}
      ${field('Site', phaseInput(phase.id, 'site', phase.site, 'placeholder="optional — e.g. Bailey Cove"'))}
    </div>

    ${
      suggestion
        ? `<div class="suggestion">
             <span class="tag">Auto-suggest</span>
             ${esc(suggestion.label)} · MET ${suggestion.metMin}–${suggestion.metMax}
             <button type="button" class="link-btn" data-action="apply-met" data-phase="${phase.id}" data-met="${suggestion.met}" data-capture="${suggestion.capture}">Use ${suggestion.met}</button>
           </div>`
        : ''
    }

    <div class="grid grid-4">
      ${field('Soil class', `<select data-phase="${phase.id}" data-field="soilCode">${soilOptions(phase.soilCode)}</select>`)}
      ${field('MET', phaseInput(phase.id, 'met', phase.met, 'type="number" step="0.1" min="0" max="16" placeholder="6.5"'))}
      ${field('Start', phaseInput(phase.id, 'start', phase.start, 'type="time"'))}
      ${field('End', phaseInput(phase.id, 'end', phase.end, 'type="time"'))}
    </div>

    <div class="grid grid-3">
      ${field(
        'Model',
        `<select data-phase="${phase.id}" data-field="modelOverride">
          <option value="" data-automodel="${phase.id}" ${!phase.modelOverride ? 'selected' : ''}>Auto — ${esc(autoLabel)}</option>
          <option value="${MODEL.INTERMEDIATE}" ${phase.modelOverride === MODEL.INTERMEDIATE ? 'selected' : ''}>Force Intermediate</option>
          <option value="${MODEL.KRI}" ${phase.modelOverride === MODEL.KRI ? 'selected' : ''}>Force KRI</option>
        </select>`,
        `<span data-reasons="${phase.id}">${esc(reasons)}</span>`,
      )}
      ${field(
        'Exact net minutes',
        phaseInput(phase.id, 'netMinutesOverride', phase.netMinutesOverride, 'type="number" min="0" step="1" placeholder="auto"'),
        `<span data-alloc="${phase.id}">${allocText(result)}</span>`,
      )}
      ${field(
        'Sustained vigorous',
        `<label class="check"><input type="checkbox" data-phase="${phase.id}" data-field="vigorous" ${phase.vigorous ? 'checked' : ''}> Forces KRI</label>`,
      )}
    </div>

    <details class="phase-extra" ${phase.watchBpm || phase.samsungActiveMinutes || phase.metRevisionNote ? 'open' : ''}>
      <summary>Validation &amp; cross-checks</summary>
      <div class="grid grid-3">
        ${field('Watch BPM (peak)', phaseInput(phase.id, 'watchBpm', phase.watchBpm, 'type="number" min="40" max="220" placeholder="uncorrected"'))}
        ${field('Samsung active min', phaseInput(phase.id, 'samsungActiveMinutes', phase.samsungActiveMinutes, 'type="number" min="0" placeholder="cross-check only"'))}
        ${field('Capture category', `<select data-phase="${phase.id}" data-field="captureCategory">${captureOptions(phase.captureCategory)}</select>`)}
      </div>
      ${
        result && result.bpm
          ? `<div class="callout ${result.bpm.verdict === 'revise-up' ? 'warn' : 'info'}">
              <strong>${result.bpm.correctedBpm}${result.bpm.correctedBpmMax !== result.bpm.correctedBpm ? `–${result.bpm.correctedBpmMax}` : ''} corrected BPM</strong>
              (${esc(result.bpm.correction.note)}) → HRR ${pct(result.bpm.hrr)}${result.bpm.hrrMax !== result.bpm.hrr ? `–${pct(result.bpm.hrrMax)}` : ''}
              ${result.bpm.implied ? ` → implied MET ${result.bpm.implied.metMin}–${result.bpm.implied.metMax}` : ''}
              <div>${esc(result.bpm.message)}</div>
            </div>`
          : ''
      }
      ${
        result && result.capture
          ? `<div class="callout ${result.capture.status === 'expected' ? 'info' : 'warn'}">
              Capture rate ${pct(result.capture.rate)}${result.capture.band ? ` vs expected ${pct(result.capture.band.min)}–${pct(result.capture.band.max)}` : ''} — cross-check floor only; calendar net work time is authoritative.
            </div>`
          : ''
      }
      ${field('MET revision note', phaseInput(phase.id, 'metRevisionNote', phase.metRevisionNote, 'placeholder="e.g. revised 6.5 → 7.5 on BPM evidence"'))}
    </details>
  </div>`;
}

function formTemplate(entry, calc) {
  const weightInEffect = store.weightForDate(entry.date);
  const shiftGross = durationMinutes(entry.shiftStart, entry.shiftEnd);

  return `
  <div class="toolbar">
    <div class="toolbar-left">
      <label class="field inline">
        <span class="field-label">Date</span>
        <input type="date" id="entry-date" value="${esc(entry.date)}">
      </label>
      <label class="check big"><input type="checkbox" data-field="restDay" ${entry.restDay ? 'checked' : ''}> Rest day (no work)</label>
    </div>
    <div class="toolbar-right">
      <span id="save-state" class="save-state ${dirty ? 'pending' : 'saved'}">${dirty ? 'Saving…' : 'Saved'}</span>
      <button type="button" class="btn ghost" data-action="delete-entry">Delete day</button>
    </div>
  </div>

  <p class="day-title">${esc(prettyDate(entry.date))}</p>

  ${
    entry.restDay
      ? `<div class="callout info">Rest day — no active work calories. NEAT, TEF and background daily life still apply and can be tuned below.</div>`
      : `
  <section class="card">
    <h2>Shift &amp; net work time <span class="sec-ref">§8</span></h2>
    <div class="grid grid-4">
      ${field('Shift start', input('shiftStart', entry.shiftStart, 'type="time"'))}
      ${field('Shift end', input('shiftEnd', entry.shiftEnd, 'type="time"'))}
      ${field('Lunch start', input('lunchStart', entry.lunchStart, 'type="time"'))}
      ${field('Lunch end', input('lunchEnd', entry.lunchEnd, 'type="time"'))}
    </div>
    <div class="grid grid-4">
      ${field('Break count', input('breakCount', entry.breakCount, 'type="number" min="0" step="1" placeholder="0"'), `${store.getSettings().breakMinutesDefault} min each by default`)}
      ${field('Exact break minutes', input('breakMinutesActual', entry.breakMinutesActual, 'type="number" min="0" step="1" placeholder="auto"'), 'Overrides the estimate')}
      ${field('Non-work transit (min)', input('transitMinutes', entry.transitMinutes, 'type="number" min="0" step="1" placeholder="0"'), 'Supply runs, equipment drop-off')}
      ${field('Working minutes inside lunch', input('lunchEmbeddedMinutes', entry.lunchEmbeddedMinutes, 'type="number" min="0" step="1" placeholder="0"'), 'Split out embedded tasks; log them as a phase')}
    </div>
    <div class="timing-strip">
      <span>Gross shift <strong>${formatDuration(shiftGross)}</strong></span>
      <span>− eating <strong>${formatDuration(calc.timing.eatingMinutes)}</strong></span>
      <span>− breaks <strong>${formatDuration(calc.timing.breakMinutes)}</strong>${calc.timing.breakEstimated && Number(entry.breakCount) > 0 ? ' <em>est.</em>' : ''}</span>
      <span>− transit <strong>${formatDuration(calc.timing.transitMinutes)}</strong></span>
      <span class="net">= net work <strong>${formatDuration(calc.timing.netWorkMinutes)}</strong></span>
    </div>
  </section>

  <section class="card">
    <h2>Conditions &amp; sites <span class="sec-ref">§3 · §11</span></h2>
    <div class="grid grid-4">
      ${field('Temp °F', input('tempF', entry.tempF, 'type="number" step="1" placeholder="raw"'))}
      ${field('Feels-like °F', input('feelsLikeF', entry.feelsLikeF, 'type="number" step="1" placeholder="heat index"'), '≥ 88°F triggers KRI')}
      ${field('Site count', input('siteCount', entry.siteCount, 'type="number" min="1" step="1" placeholder="auto"'))}
      ${field('Bodyweight kg (fasted AM)', input('weightKg', entry.weightKg, 'type="number" step="0.1" min="0" placeholder="' + num(weightInEffect, 1) + '"'), `Using ${num(calc.weightKg, 1)} kg`)}
    </div>
    <div class="check-row">
      <label class="check"><input type="checkbox" data-field="heatInferred" ${entry.heatInferred ? 'checked' : ''}> Heat ≥88°F inferred (not documented) — flags the day</label>
      <label class="check"><input type="checkbox" data-field="outOfStateSupplyRun" ${entry.outOfStateSupplyRun ? 'checked' : ''}> Out-of-state supply run</label>
    </div>
  </section>

  <section class="card">
    <div class="card-head">
      <h2>Task phases <span class="sec-ref">§5 · §3</span></h2>
      <button type="button" class="btn" data-action="add-phase">+ Add phase</button>
    </div>
    <p class="muted">Model selection is per-task, not per-day. Each phase gets its own MET and its own Intermediate/KRI decision.</p>
    <div class="phases">
      ${entry.phases.map((p, i) => phaseCard(p, i, calc)).join('')}
    </div>
  </section>
  `
  }

  <section class="card">
    <h2>Estimated components <span class="sec-ref">§9 · §10 · §11</span></h2>
    <p class="muted">These three lines are lower-confidence estimates and are shown dashed in the breakdown. Leave the kcal boxes blank to use the tier default.</p>
    <div class="grid grid-2">
      ${field(
        'Post-work NEAT tier',
        `<select data-field="neatTier">
          <option value="">Auto — ${esc(calc.neat.suggestion.label)}</option>
          ${NEAT_TIERS.map((t) => `<option value="${t.id}" ${entry.neatTier === t.id ? 'selected' : ''}>${esc(t.label)} (${t.min}–${t.max})</option>`).join('')}
        </select>`,
      )}
      ${field('NEAT kcal override', input('neatKcal', entry.neatKcal, 'type="number" min="0" step="1" placeholder="' + kcal(calc.neat.kcal) + '"'))}
    </div>
    <div class="grid grid-2">
      ${field(
        'Background daily life tier',
        `<select data-field="backgroundTier">
          <option value="">Auto — ${esc(calc.background.suggestion.label)}</option>
          ${BACKGROUND_TIERS.map((t) => `<option value="${t.id}" ${entry.backgroundTier === t.id ? 'selected' : ''}>${esc(t.label)} (${t.kcal})</option>`).join('')}
        </select>`,
      )}
      ${field('Background kcal override', input('backgroundKcal', entry.backgroundKcal, 'type="number" min="0" step="1" placeholder="' + kcal(calc.background.kcal) + '"'))}
    </div>
    <div class="grid grid-2">
      ${field('Logged intake kcal', input('intakeKcal', entry.intakeKcal, 'type="number" min="0" step="1" placeholder="optional"'), 'Used for TEF adjustment and balance only')}
      ${field('TEF kcal override', input('tefKcal', entry.tefKcal, 'type="number" min="0" step="1" placeholder="' + kcal(calc.tef.kcal) + '"'), esc(calc.tef.suggestion.reason))}
    </div>
    ${field('Notes', `<textarea data-field="notes" rows="3" placeholder="Calendar quirks, revisions, anything worth remembering">${esc(entry.notes)}</textarea>`)}
  </section>

  <datalist id="task-list">
    ${TASK_METS.map((t) => `<option value="${esc(t.label)}"></option>`).join('')}
    ${SOIL_CLASSES.map((s) => `<option value="${esc(s.name)}"></option>`).join('')}
  </datalist>
  `;
}

/* -------------------------------- results -------------------------------- */

function resultsTemplate(calc) {
  const c = calc.components;
  const segments = [
    { label: 'BMR', value: c.bmr, color: 'var(--c-bmr)' },
    { label: 'Active work', value: c.active, color: 'var(--c-active)' },
    { label: 'Post-work NEAT', value: c.neat, color: 'var(--c-neat)', estimate: true },
    { label: 'TEF', value: c.tef, color: 'var(--c-tef)' },
    { label: 'Background', value: c.background, color: 'var(--c-bg)', estimate: true },
  ];

  const rows = calc.phases
    .map(
      (p) => `<tr>
        <td>${esc(p.description || '—')}${p.site ? `<span class="sub">${esc(p.site)}</span>` : ''}</td>
        <td>${p.soilCode || '—'}</td>
        <td class="right">${num(p.met, 1)}</td>
        <td class="right">${formatDuration(p.netMinutes)}</td>
        <td><span class="pill ${p.model}">${MODEL_LABELS[p.model]}</span>${p.modelOverridden ? '<span class="sub">manual</span>' : ''}</td>
        <td class="right strong">${kcal(p.kcal)}</td>
      </tr>`,
    )
    .join('');

  return `
  <div class="result-head">
    <div>
      <span class="result-label">Estimated TDEE</span>
      <div class="result-value">${kcal(calc.tdee)}<span class="unit">kcal</span></div>
      <div class="result-uncertainty">±${DAY_UNCERTAINTY_KCAL.min}–${DAY_UNCERTAINTY_KCAL.max} kcal single-day precision</div>
    </div>
    ${
      calc.balance !== null
        ? `<div class="balance ${calc.balance >= 0 ? 'surplus' : 'deficit'}">
            <span class="result-label">${calc.balance >= 0 ? 'Surplus' : 'Deficit'}</span>
            <div class="balance-value">${kcal(Math.abs(calc.balance))}</div>
            <div class="sub">intake ${kcal(calc.intakeKcal)}</div>
          </div>`
        : ''
    }
  </div>

  <div id="stack-host"></div>
  <ul class="legend">
    ${segments
      .map(
        (s) =>
          `<li><span class="swatch${s.estimate ? ' est' : ''}" style="--sw:${s.color}"></span>${s.label} <strong>${kcal(s.value)}</strong>${s.estimate ? '<em>est.</em>' : ''}</li>`,
      )
      .join('')}
  </ul>

  ${
    calc.phases.length
      ? `<table class="table">
          <thead><tr><th>Phase</th><th>Soil</th><th class="right">MET</th><th class="right">Net</th><th>Model</th><th class="right">kcal</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><td colspan="5">Active work calories</td><td class="right strong">${kcal(calc.components.active)}</td></tr></tfoot>
        </table>`
      : ''
  }

  ${
    calc.phases.length
      ? `<div class="comparison">
          <h3>Model comparison <span class="sec-ref">§12.11</span></h3>
          <table class="table compact">
            <tbody>
              <tr class="raw-row">
                <td>${MODEL_LABELS[MODEL.RAW]}<span class="sub">${MODEL_FORMULAS[MODEL.RAW]}</span></td>
                <td class="right">${kcal(calc.comparison[MODEL.RAW])}</td>
                <td class="note">QA only — never added to BMR</td>
              </tr>
              <tr>
                <td>${MODEL_LABELS[MODEL.INTERMEDIATE]}<span class="sub">${MODEL_FORMULAS[MODEL.INTERMEDIATE]}</span></td>
                <td class="right">${kcal(calc.comparison[MODEL.INTERMEDIATE])}</td>
                <td class="note">all phases as Intermediate</td>
              </tr>
              <tr>
                <td>${MODEL_LABELS[MODEL.KRI]}<span class="sub">${MODEL_FORMULAS[MODEL.KRI]}</span></td>
                <td class="right">${kcal(calc.comparison[MODEL.KRI])}</td>
                <td class="note">all phases as KRI</td>
              </tr>
              <tr class="used-row">
                <td><strong>Used</strong><span class="sub">${calc.comparison.mixed ? 'mixed per-phase selection' : 'single model across all phases'}</span></td>
                <td class="right strong">${kcal(calc.comparison.used)}</td>
                <td class="note">✓ applied to TDEE</td>
              </tr>
            </tbody>
          </table>
        </div>`
      : ''
  }

  ${
    calc.flags.length
      ? `<div class="flags">
          <h3>Data quality <span class="sec-ref">§12.12</span></h3>
          ${calc.flags.map((f) => `<div class="flag ${f.level}"><span class="flag-dot"></span>${esc(f.text)}</div>`).join('')}
        </div>`
      : '<div class="flags"><div class="flag ok"><span class="flag-dot"></span>No data-quality flags for this day.</div></div>'
  }
  `;
}

export function refreshResults() {
  const host = document.getElementById('results');
  if (!host || !draft) return null;
  const calc = calculateDay(withResolvedWeight(draft), store.getSettings());
  host.innerHTML = resultsTemplate(calc);
  const stackHost = document.getElementById('stack-host');
  if (stackHost) {
    stackHost.appendChild(
      stackedBar([
        { label: 'BMR', value: calc.components.bmr, color: 'var(--c-bmr)' },
        { label: 'Active work', value: calc.components.active, color: 'var(--c-active)' },
        { label: 'Post-work NEAT', value: calc.components.neat, color: 'var(--c-neat)', estimate: true },
        { label: 'TEF', value: calc.components.tef, color: 'var(--c-tef)' },
        { label: 'Background', value: calc.components.background, color: 'var(--c-bg)', estimate: true },
      ]),
    );
  }
  // Derived values embedded in the form re-render in place, so the form itself
  // never has to be rebuilt (which would steal focus mid-edit).
  for (const p of calc.phases) {
    const headline = document.querySelector(`[data-phase-card="${p.id}"] .phase-kcal`);
    if (headline) headline.textContent = `${kcal(p.kcal)} kcal`;
    const alloc = document.querySelector(`[data-alloc="${p.id}"]`);
    if (alloc) alloc.textContent = allocText(p);
    const reasons = document.querySelector(`[data-reasons="${p.id}"]`);
    if (reasons) {
      reasons.textContent = p.kriReasons.length
        ? p.kriReasons.join(' · ')
        : 'No KRI trigger — Intermediate applies';
    }
    const autoOption = document.querySelector(`[data-automodel="${p.id}"]`);
    if (autoOption) autoOption.textContent = `Auto — ${MODEL_LABELS[p.autoModel]}`;
  }
  return calc;
}

/** The engine takes an explicit weight; fall back to the log value for the date. */
function withResolvedWeight(entry) {
  if (entry.weightKg !== '' && Number(entry.weightKg) > 0) return entry;
  return { ...entry, weightKg: store.weightForDate(entry.date) };
}

/* --------------------------------- render -------------------------------- */

export function render(root) {
  if (!draft) loadDate(todayIso());
  root.innerHTML = `
    <div class="log-layout">
      <form id="entry-form" class="entry-form" autocomplete="off"></form>
      <aside class="results-panel"><div id="results"></div></aside>
    </div>`;

  const form = root.querySelector('#entry-form');
  rebuildForm(form);

  form.addEventListener('input', (e) => onFieldEvent(e, form));
  form.addEventListener('change', (e) => onFieldEvent(e, form));
  form.addEventListener('click', (e) => onClick(e, form));
}

function rebuildForm(form) {
  const calc = calculateDay(withResolvedWeight(draft), store.getSettings());
  form.innerHTML = formTemplate(draft, calc);
  refreshResults();
}

function onFieldEvent(e, form) {
  const target = e.target;
  if (target.id === 'entry-date') {
    if (dirty) store.saveEntry(draft);
    loadDate(target.value);
    rebuildForm(form);
    return;
  }
  const fieldName = target.dataset.field;
  if (!fieldName) return;

  const value = target.type === 'checkbox' ? target.checked : target.value;
  const phaseId = target.dataset.phase;

  if (phaseId) {
    const phase = draft.phases.find((p) => p.id === phaseId);
    if (!phase) return;
    phase[fieldName] = value;
    // Auto-fill MET and capture category the first time a description is typed.
    if (fieldName === 'description' && (phase.met === '' || phase.met === null)) {
      const s = suggestMet(value, phase.soilCode);
      if (s) {
        phase.met = s.met;
        if (!phase.captureCategory) phase.captureCategory = s.capture;
        const metInput = form.querySelector(`[data-phase="${phaseId}"][data-field="met"]`);
        if (metInput) metInput.value = s.met;
        const capInput = form.querySelector(`[data-phase="${phaseId}"][data-field="captureCategory"]`);
        if (capInput) capInput.value = phase.captureCategory;
      }
    }
    if (fieldName === 'soilCode' && value) {
      const soil = SOIL_CLASSES.find((sc) => sc.code === value);
      if (soil && (phase.met === '' || phase.met === null)) {
        phase.met = Math.round(((soil.metMin + soil.metMax) / 2) * 10) / 10;
        const metInput = form.querySelector(`[data-phase="${phaseId}"][data-field="met"]`);
        if (metInput) metInput.value = phase.met;
      }
    }
  } else {
    draft[fieldName] = value;
    if (fieldName === 'restDay') {
      markDirty();
      rebuildForm(form);
      return;
    }
  }

  markDirty();
  refreshResults();
  refreshSuggestionsAndHints(form);
}

/** Re-render only the small derived bits embedded in the form. */
function refreshSuggestionsAndHints(form) {
  const calc = calculateDay(withResolvedWeight(draft), store.getSettings());
  const strip = form.querySelector('.timing-strip');
  if (strip) {
    strip.innerHTML = `
      <span>Gross shift <strong>${formatDuration(durationMinutes(draft.shiftStart, draft.shiftEnd))}</strong></span>
      <span>− eating <strong>${formatDuration(calc.timing.eatingMinutes)}</strong></span>
      <span>− breaks <strong>${formatDuration(calc.timing.breakMinutes)}</strong>${calc.timing.breakEstimated && Number(draft.breakCount) > 0 ? ' <em>est.</em>' : ''}</span>
      <span>− transit <strong>${formatDuration(calc.timing.transitMinutes)}</strong></span>
      <span class="net">= net work <strong>${formatDuration(calc.timing.netWorkMinutes)}</strong></span>`;
  }
}

function onClick(e, form) {
  const action = e.target.dataset.action;
  if (!action) return;
  e.preventDefault();

  if (action === 'add-phase') {
    draft.phases.push(store.newPhase());
    markDirty();
    rebuildForm(form);
  } else if (action === 'remove-phase') {
    const id = e.target.dataset.phase;
    draft.phases = draft.phases.filter((p) => p.id !== id);
    if (draft.phases.length === 0) draft.phases.push(store.newPhase());
    markDirty();
    rebuildForm(form);
  } else if (action === 'apply-met') {
    const id = e.target.dataset.phase;
    const phase = draft.phases.find((p) => p.id === id);
    if (phase) {
      phase.met = Number(e.target.dataset.met);
      if (!phase.captureCategory) phase.captureCategory = e.target.dataset.capture || '';
      markDirty();
      rebuildForm(form);
    }
  } else if (action === 'delete-entry') {
    if (confirm(`Delete the entry for ${draft.date}? This cannot be undone.`)) {
      store.deleteEntry(draft.date);
      loadDate(draft.date);
      rebuildForm(form);
      toast('Entry deleted', 'warn');
    }
  }
}
