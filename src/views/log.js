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
  NON_WORK_DAY,
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
} from '../engine.js';
import { COMPONENTS, trailingAverage } from '../analytics.js';
import { parseCalendarLog, parseMultiDayLog, splitDayBlocks } from '../calendarImport.js';
import { classifyTask, daySoil, isShadeDay } from '../metGlossary.js';
import { groupByDate, htmlToText, parseHeartRateText } from '../heartRate.js';
import * as store from '../store.js';
import { confirmClick, esc, kcal, num, openTextPanel, pct, toast, todayIso } from '../ui.js';
import { calculatedDays } from './history.js';

let draft = null;
let dirty = false;
/** Trailing 7-day average for the open date. Other days don't change while
 * this one is edited, so it's computed once per load, not per keystroke. */
let trailing = null;

function setSaveState(state) {
  const badge = document.getElementById('save-state');
  if (!badge) return;
  badge.dataset.state = state;
  badge.textContent = state === 'saved' ? '● Saved' : '● Saving';
}

let saveTimer = null;

/**
 * Writes any pending edit now. Saving is debounced 500ms behind typing, so
 * anything that swaps the open day or leaves this screen must flush first —
 * otherwise the reload overwrites the unsaved edit, or the late timer saves
 * it onto whichever day was opened next.
 */
export function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!dirty || !draft || !draft.date) return;
  store.saveEntry(draft);
  dirty = false;
  setSaveState('saved');
}

function markDirty() {
  dirty = true;
  setSaveState('pending');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 500);
}

export function loadDate(date) {
  flushSave();
  const existing = store.getEntry(date);
  draft = existing
    ? JSON.parse(JSON.stringify(existing))
    : { ...store.newEntry(date), weightKg: '' };
  if (!draft.phases || draft.phases.length === 0) draft.phases = [store.newPhase()];
  dirty = false;
  trailing = trailingAverage(calculatedDays(), date);
}

export function getDraft() {
  return draft;
}

/* ---------------------------- automatic MET ---------------------------- */

/** Day-level context the glossary reads: heat, shade, and soil named anywhere in the day. */
function dayContext() {
  const text = [draft.notes || '', ...draft.phases.map((p) => p.description || '')].join('\n');
  return { feelsLikeF: draft.feelsLikeF, shade: isShadeDay(text), daySoil: daySoil(text) };
}

/**
 * Re-read a phase's description through the MET glossary. Only touches a
 * phase whose MET is still automatic (or blank) unless forced — a MET typed
 * by hand, or one taken from a BPM-confirmed note, is left alone.
 */
function applyGlossary(phase, { force = false } = {}) {
  const manual = phase.met !== '' && phase.met !== null && !phase.metAuto;
  if (!force && (manual || phase.metSource === 'bpm-note')) return false;
  const c = classifyTask(phase.description, { ...dayContext(), soilCode: phase.soilManual ? phase.soilCode : '' });
  if (c.nonLabor) {
    Object.assign(phase, {
      met: '', metAuto: true, metSource: 'glossary', metConfidence: 'high',
      metBasis: `${c.basis}. Add its minutes to Non-work time and remove this phase.`,
      metNotes: [{ level: 'warn', text: `"${phase.description}" reads as non-labor (${c.nonLabor}) — it shouldn't be a phase; put its minutes under Non-work time.` }],
    });
    return true;
  }
  Object.assign(phase, {
    met: c.met, metAuto: true, metSource: c.source, metConfidence: c.confidence, metBasis: c.basis, metNotes: c.notes,
  });
  if (c.captureCategory) phase.captureCategory = c.captureCategory;
  if (!phase.soilManual) phase.soilCode = c.soilCode;
  return true;
}

function basisHtml(phase) {
  if (phase.metSource === 'bpm-note' || phase.metSource === 'bpm-export') {
    return `<span class="tag conf-high">${phase.metSource === 'bpm-note' ? 'BPM note' : 'HR export'}</span><span class="basis-text">${esc(phase.metBasis)}</span>`;
  }
  if (phase.metAuto && phase.metBasis) {
    const conf = phase.metConfidence || 'medium';
    return `<span class="tag conf-${conf}">Auto MET · ${conf}</span><span class="basis-text">${esc(phase.metBasis)}</span>`;
  }
  if (phase.met !== '' && phase.met !== null && phase.description) {
    const g = classifyTask(phase.description, dayContext());
    const differs = g.met !== '' && Math.abs(Number(g.met) - Number(phase.met)) >= 0.05;
    return `<span class="tag muted-tag">Entered by hand</span>${differs
      ? `<span class="basis-text">Glossary reads MET ${g.met} (${g.confidence}).</span><button type="button" class="link-btn" data-action="apply-met" data-phase="${phase.id}">Use ${g.met}</button>`
      : ''}`;
  }
  return '<span class="basis-text faint">Describe the work — soil, tools and materials set the MET automatically.</span>';
}

/** Push glossary results into a phase's inputs without rebuilding the form. */
function syncPhaseInputs(form, phase) {
  const set = (field, value) => {
    const el = form.querySelector(`[data-phase="${phase.id}"][data-field="${field}"]`);
    if (el && el !== document.activeElement) el.value = value ?? '';
  };
  set('met', phase.met);
  set('captureCategory', phase.captureCategory);
  set('soilCode', phase.soilCode);
  const basis = form.querySelector(`[data-basis="${phase.id}"]`);
  if (basis) basis.innerHTML = basisHtml(phase);
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
  return `<input id="f-${fieldName}" data-field="${fieldName}" value="${esc(value ?? '')}" ${attrs}>`;
}

function phaseInput(id, fieldName, value, attrs = '') {
  return `<input id="p-${id}-${fieldName}" data-phase="${id}" data-field="${fieldName}" value="${esc(value ?? '')}" ${attrs}>`;
}

function soilOptions(selected) {
  return [
    '<option value="">— none —</option>',
    ...SOIL_CLASSES.map(
      (s) =>
        `<option value="${s.code}" ${s.code === selected ? 'selected' : ''}>${s.code} — ${esc(s.name)} (MET ${s.metMin}–${s.metMax})</option>`,
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

/** A "use this MET" button for a BPM check that disagrees with the logged MET. */
function hrApplyButton(check, attrs, label = 'Use MET') {
  if (!check || !check.suggestedMet || (check.verdict !== 'revise-up' && check.verdict !== 'revise-down')) return '';
  return `<button type="button" class="btn sm" ${attrs} data-met="${check.suggestedMet}" data-verdict="${check.verdict}">${label} ${check.suggestedMet}</button>`;
}

/** Record a BPM-driven revision on a phase and say which way it went (§5). */
function applyHrMet(phase, met, source) {
  const prior = phase.met === '' ? null : Number(phase.met);
  const dir = prior === null || prior === met ? '' : prior > met ? 'downward ' : 'upward ';
  Object.assign(phase, {
    met,
    metAuto: false,
    metSource: 'bpm-export',
    metConfidence: 'high',
    metBasis: `BPM-confirmed ${dir}revision from the heart-rate export (was ${prior ?? 'blank'}): ${source}`,
    metNotes: [],
  });
}

function phaseCard(phase, index, calc) {
  const result = calc.phases.find((p) => p.id === phase.id);

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

    <div class="met-basis" data-basis="${phase.id}">${basisHtml(phase)}</div>

    <div class="grid grid-4">
      ${field('Soil class', `<select id="p-${phase.id}-soilCode" data-phase="${phase.id}" data-field="soilCode">${soilOptions(phase.soilCode)}</select>`)}
      ${field('MET', phaseInput(phase.id, 'met', phase.met, 'type="number" step="0.1" min="0" max="16" placeholder="6.5"'))}
      ${field('Start', phaseInput(phase.id, 'start', phase.start, 'type="time"'))}
      ${field('End', phaseInput(phase.id, 'end', phase.end, 'type="time"'))}
    </div>

    <div class="grid grid-2">
      ${field(
        'Exact net minutes',
        phaseInput(phase.id, 'netMinutesOverride', phase.netMinutesOverride, 'type="number" min="0" step="1" placeholder="auto"'),
        `<span data-alloc="${phase.id}">${allocText(result)}</span>`,
      )}
    </div>

    <details class="phase-extra" ${phase.watchBpm || phase.samsungActiveMinutes || phase.metRevisionNote ? 'open' : ''}>
      <summary>Validation &amp; cross-checks</summary>
      <div class="grid grid-3">
        ${field('Watch BPM (peak)', phaseInput(phase.id, 'watchBpm', phase.watchBpm, 'type="number" min="40" max="220" placeholder="uncorrected"'))}
        ${field('Samsung active min', phaseInput(phase.id, 'samsungActiveMinutes', phase.samsungActiveMinutes, 'type="number" min="0" placeholder="cross-check only"'))}
        ${field('Capture category', `<select id="p-${phase.id}-captureCategory" data-phase="${phase.id}" data-field="captureCategory">${captureOptions(phase.captureCategory)}</select>`)}
      </div>
      ${
        result && result.bpm
          ? `<div class="callout ${result.bpm.verdict === 'revise-up' || result.bpm.verdict === 'revise-down' ? 'warn' : 'info'}">
              ${result.bpm.fromExport ? `<div class="small">Heart-rate export, ${esc(phase.start)}–${esc(phase.end)}: median ${result.bpm.stats.median} bpm (90th pct ${result.bpm.stats.p90}, peak ${result.bpm.stats.peak}) over ${result.bpm.stats.n} readings</div>` : ''}
              <strong>${result.bpm.correctedBpm}${result.bpm.correctedBpmMax !== result.bpm.correctedBpm ? `–${result.bpm.correctedBpmMax}` : ''} corrected BPM</strong>
              (${esc(result.bpm.correction.note)}) → HRR ${pct(result.bpm.hrr)}${result.bpm.hrrMax !== result.bpm.hrr ? `–${pct(result.bpm.hrrMax)}` : ''}
              ${result.bpm.implied ? ` → implied MET ${result.bpm.implied.metMin}–${result.bpm.implied.metMax}` : ''}
              <div>${esc(result.bpm.message)}</div>
              ${hrApplyButton(result.bpm, `data-action="apply-hr-met" data-phase="${phase.id}"`)}
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
  <div class="edit-head">
    <div>
      <p class="eyebrow">Inputs</p>
      <h2>Edit day</h2>
    </div>
    <div class="toolbar">
      <label class="field inline">
        <span class="field-label">Date</span>
        <input type="date" id="entry-date" value="${esc(entry.date)}">
      </label>
      <label class="check"><input type="checkbox" id="f-restDay" data-field="restDay" ${entry.restDay ? 'checked' : ''}> Non-work day</label>
      <button type="button" class="btn ghost" data-action="import-file">Import from file</button>
      <input type="file" id="import-file-input" accept=".md,.markdown,.txt,.pdf,.html,.htm" hidden>
      <button type="button" class="btn danger" data-action="delete-entry">Delete day</button>
    </div>
  </div>

  <details class="import-guide">
    <summary>What format does the import file need to be?</summary>
    <p class="muted small">
      Plain text or Markdown (<code>.md</code>, <code>.txt</code>) parses instantly and works offline. A <code>.pdf</code>
      works too, but needs a one-time download of a PDF-reading library from a CDN, so it needs internet access the
      first time. Either way, only clearly-labeled fields get filled in automatically — anything ambiguous is left
      blank for you, and the full original text is always kept in the Notes field below.
    </p>
    <p class="muted small">
      One file can hold <strong>many days at once</strong> — separate each day's block with a line containing just
      <code>---</code>. Every dated block is saved as its own day automatically (no merging, no clicking through
      each one) and you land on History to review them. A file with no <code>---</code> is treated as a single day
      and merges onto whatever's currently open instead.
    </p>
    <pre class="format-sample">Date: 2026-09-18
Shift: 8:08 AM - 3:18 PM
Location: 200 Sherry Hl Trl, Madison, AL

98° (Feels 104° Sunny)
Breaks: 6
(Lunch break 12:16 - 1:04)

• Hauling gravel via wheelbarrow &amp; dump to designated area
• Repair sprinklers and inspect
• Water sod

---

Date: 2026-09-19
Shift: 7:56 AM - 11:51 AM
...</pre>
  </details>

  ${
    entry.restDay
      ? `<section class="card">
    <h2>Non-work / university day <span class="sec-ref">§7</span></h2>
    <p class="muted">No task or soil to classify. Built additively: BMR + walking (MET ${NON_WORK_DAY.walkingMet}) + general-day NEAT + TEF, with no separate background bucket. Still unvalidated against HR.</p>
    <div class="grid grid-2">
      ${field('Step count', input('steps', entry.steps, `type="number" min="0" step="100" placeholder="${NON_WORK_DAY.defaultSteps}"`), `Blank assumes ${NON_WORK_DAY.defaultSteps.toLocaleString()} (~1.4 hr walking)`)}
    </div>
  </section>`
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
      ${field('Non-work time (min)', input('transitMinutes', entry.transitMinutes, 'type="number" min="0" step="1" placeholder="0"'), 'Supply runs, wrong-item returns, lectures — excluded from active hours')}
      ${field('Working minutes inside lunch', input('lunchEmbeddedMinutes', entry.lunchEmbeddedMinutes, 'type="number" min="0" step="1" placeholder="0"'), 'Split out embedded tasks; log them as a phase')}
    </div>
    <div class="timing-strip">
      <span>Gross shift <strong>${formatDuration(shiftGross)}</strong></span>
      <span>− eating <strong>${formatDuration(calc.timing.eatingMinutes)}</strong></span>
      <span>− breaks <strong>${formatDuration(calc.timing.breakMinutes)}</strong>${calc.timing.breakEstimated && Number(entry.breakCount) > 0 ? ' <em>est.</em>' : ''}</span>
      <span>− non-work <strong>${formatDuration(calc.timing.transitMinutes)}</strong></span>
      <span class="net">= net work <strong>${formatDuration(calc.timing.netWorkMinutes)}</strong></span>
    </div>
  </section>

  <section class="card">
    <h2>Conditions &amp; sites <span class="sec-ref">§3 · §11</span></h2>
    <div class="grid grid-4">
      ${field('Temp °F', input('tempF', entry.tempF, 'type="number" step="1" placeholder="raw"'))}
      ${field('Feels-like °F', input('feelsLikeF', entry.feelsLikeF, 'type="number" step="1" placeholder="heat index"'), '≥ 88°F confirms upper-range MET')}
      ${field('Site count', input('siteCount', entry.siteCount, 'type="number" min="1" step="1" placeholder="auto"'))}
      ${field('Bodyweight kg (fasted AM)', input('weightKg', entry.weightKg, 'type="number" step="0.1" min="0" placeholder="' + num(weightInEffect, 1) + '"'), `Using ${num(calc.weightKg, 1)} kg`)}
    </div>
    <div class="check-row">
      <label class="check"><input type="checkbox" id="f-heatInferred" data-field="heatInferred" ${entry.heatInferred ? 'checked' : ''}> Heat ≥88°F inferred (not documented) — flags the day</label>
      <label class="check"><input type="checkbox" id="f-outOfStateSupplyRun" data-field="outOfStateSupplyRun" ${entry.outOfStateSupplyRun ? 'checked' : ''}> Out-of-state supply run</label>
    </div>
  </section>

  <section class="card">
    <div class="card-head">
      <h2>Task phases <span class="sec-ref">§5 · §3</span></h2>
      <button type="button" class="btn" data-action="add-phase">+ Add phase</button>
    </div>
    <p class="muted">Every phase uses the Intermediate model, (MET − 1.0) × kg × hrs (§3.1). Multi-task days blend MET by minutes, never by task count.</p>
    <div class="phases">
      ${entry.phases.map((p, i) => phaseCard(p, i, calc)).join('')}
    </div>
  </section>
  `
  }

  <section class="card">
    <h2>Estimated components <span class="sec-ref">§2</span></h2>
    <p class="muted">These three lines are lower-confidence estimates and are tagged EST and hatched in the breakdown above. Leave the kcal boxes blank to use the tier default.</p>
    <div class="grid grid-2">
      ${field(
        'Post-work NEAT tier',
        `<select id="f-neatTier" data-field="neatTier">
          <option value="">Auto — ${esc(calc.neat.suggestion.label)}</option>
          ${NEAT_TIERS.map((t) => `<option value="${t.id}" ${entry.neatTier === t.id ? 'selected' : ''}>${esc(t.label)} (${t.min}–${t.max})</option>`).join('')}
        </select>`,
      )}
      ${field('NEAT kcal override', input('neatKcal', entry.neatKcal, 'type="number" min="0" step="1" placeholder="' + kcal(calc.neat.kcal) + '"'))}
    </div>
    <div class="grid grid-2">
      ${field(
        'Background daily life tier',
        `<select id="f-backgroundTier" data-field="backgroundTier">
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
    ${field('Notes', `<textarea id="f-notes" data-field="notes" rows="3" placeholder="Calendar quirks, revisions, anything worth remembering">${esc(entry.notes)}</textarea>`)}
  </section>

  <datalist id="task-list">
    ${TASK_METS.map((t) => `<option value="${esc(t.label)}"></option>`).join('')}
    ${SOIL_CLASSES.map((s) => `<option value="${esc(s.name)}"></option>`).join('')}
  </datalist>
  `;
}

/* -------------------------------- results -------------------------------- */

function resultsTemplate(calc) {
  const soilName = (code) => SOIL_CLASSES.find((s) => s.code === code)?.name || '';
  const [y, m, d] = calc.date.split('-').map(Number);
  const when = new Date(Date.UTC(y, m - 1, d))
    .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
    .toUpperCase();

  const vs = trailing === null ? null : calc.tdee - trailing;
  const signed = (n) => `${Math.round(n) > 0 ? '+' : Math.round(n) < 0 ? '−' : ''}${Math.abs(Math.round(n)).toLocaleString()}`;
  const hm = (min) => `${Math.floor(Math.round(min) / 60)}h ${String(Math.round(min) % 60).padStart(2, '0')}m`;
  const clock = (t) => (t ? t.replace(/^0/, '') : '');

  const balance = calc.balance;
  const balanceCard = balance === null
    ? `<div class="mini"><span class="mini-label">Balance</span><span class="mini-val faint">—</span><span class="mini-sub">log intake to see it</span></div>`
    : `<div class="mini ${balance < 0 ? 'tone-down' : 'tone-up'}"><span class="mini-label">${balance < 0 ? 'Deficit' : 'Surplus'}</span><span class="mini-val">${kcal(Math.abs(balance))}</span></div>`;

  const NON_WORK_LABELS = { active: 'Walking', neat: 'General NEAT' };
  const label = (c) => (calc.restDay && NON_WORK_LABELS[c.key]) || c.label;
  const maxNet = Math.max(1, ...calc.phases.map((p) => p.netMinutes));
  // Glossary §8: blend by minutes, never by task count.
  const worked = calc.phases.filter((p) => p.met > 0 && p.netMinutes > 0);
  const workedMin = worked.reduce((sum, p) => sum + p.netMinutes, 0);
  const blended = workedMin ? worked.reduce((sum, p) => sum + p.met * p.netMinutes, 0) / workedMin : null;
  const phaseRows = calc.phases.map((p, i) => `
    <li class="phase-row">
      <div class="phase-row-head">
        <span class="idx">${String(i + 1).padStart(2, '0')}</span>
        <span class="phase-name">${esc(p.description || 'Untitled phase')}</span>
        <span class="phase-burn">${kcal(p.kcal)}</span>
      </div>
      <div class="phase-row-meta">
        <span>${p.soilCode ? `${p.soilCode} · ${esc(soilName(p.soilCode))}` : '—'}</span>
        <span>${hm(p.netMinutes)}</span>
        <span class="meter"><span style="width:${((p.netMinutes / maxNet) * 100).toFixed(1)}%"></span></span>
        <span title="${esc(p.metBasis || (p.metAuto ? '' : 'Entered by hand'))}"><span class="conf-dot conf-${p.metSource === 'bpm-note' || p.metSource === 'bpm-export' ? 'high' : p.metAuto ? p.metConfidence || 'medium' : 'manual'}"></span>MET ${num(p.met, 1)}</span>
      </div>
    </li>`).join('');

  const flags = calc.flags.length
    ? calc.flags.map((f) => `<li class="flag ${f.level}"><span class="flag-dot"></span><span>${esc(f.text)}</span></li>`).join('')
    : '<li class="flag ok"><span class="flag-dot"></span><span>No data-quality flags for this day.</span></li>';
  const warnCount = calc.flags.filter((f) => f.level !== 'info').length;

  return `
  <div class="result-grid">
    <div class="result-main">
      <p class="eyebrow">${when} · Estimated TDEE</p>
      <div class="hero-num xl">${kcal(calc.tdee)}<span class="unit">kcal</span></div>
      <p class="hero-note">±${DAY_UNCERTAINTY_KCAL.min}–${DAY_UNCERTAINTY_KCAL.max} kcal single-day precision</p>

      <div class="mini-cards">
        <div class="mini"><span class="mini-label">Intake</span><span class="mini-val${calc.intakeKcal ? '' : ' faint'}">${calc.intakeKcal ? kcal(calc.intakeKcal) : '—'}</span>${calc.intakeKcal ? '' : '<span class="mini-sub">not logged</span>'}</div>
        ${balanceCard}
        <div class="mini"><span class="mini-label">vs 7D avg</span><span class="mini-val ${vs === null ? 'faint' : vs >= 0 ? 'up' : 'down'}">${vs === null ? '—' : signed(vs)}</span>${vs === null ? '<span class="mini-sub">no days in the prior week</span>' : ''}</div>
      </div>

      <div class="stackbar tall" role="img" aria-label="Today's TDEE split by component">
        ${COMPONENTS.map((c) => `<span class="${c.estimate ? 'est' : ''}" style="flex:${Math.max(0.001, calc.components[c.key] || 0)};--sw:${c.color}" title="${label(c)}: ${kcal(calc.components[c.key])} kcal"></span>`).join('')}
      </div>
      <ul class="legend-grid">
        ${COMPONENTS.map((c) => `<li><span class="swatch" style="--sw:${c.color}"></span><span>${label(c)}${c.estimate ? ' <span class="est-tag">EST</span>' : ''}</span><strong>${kcal(calc.components[c.key])}</strong></li>`).join('')}
      </ul>
    </div>

    <div class="result-side">
      <div class="strip">
        <div><span class="mini-label">Shift</span><span class="strip-val">${calc.restDay ? 'Non-work' : draft.shiftStart && draft.shiftEnd ? `${clock(draft.shiftStart)}–${clock(draft.shiftEnd)}` : '—'}</span></div>
        <div><span class="mini-label">Net work</span><span class="strip-val">${calc.restDay ? '—' : hm(calc.timing.netWorkMinutes)}</span></div>
        <div><span class="mini-label">Feels-like</span><span class="strip-val">${calc.feelsLikeF === null ? '—' : `${calc.feelsLikeF}°F`}</span></div>
        <div><span class="mini-label">Sites</span><span class="strip-val">${calc.siteCount}</span></div>
      </div>

      <div class="side-head">
        <h3>Task phases${blended === null ? '' : ` <span class="meta">blended MET ${blended.toFixed(2)}</span>`}</h3>
        ${calc.restDay ? '' : '<button type="button" class="btn ghost sm" data-action="add-phase">+ Add phase</button>'}
      </div>
      ${calc.restDay
        ? `<p class="side-empty">Non-work day — walking ${calc.walking.hours.toFixed(1)} hr at MET ${NON_WORK_DAY.walkingMet}, plus general-day NEAT and TEF. No background bucket (§7).</p>`
        : calc.phases.length
          ? `<ol class="phase-list">${phaseRows}</ol>`
          : '<p class="side-empty">No task phases yet. Describe the work below and a MET is suggested automatically.</p>'}

      ${calc.phases.length ? `
      <details class="side-block" data-key="model">
        <summary>Model comparison <span class="meta">§12.11</span></summary>
        <table class="mini-table">
          <tbody>
            <tr class="raw-row"><td>${MODEL_LABELS[MODEL.RAW]}<span class="sub">${MODEL_FORMULAS[MODEL.RAW]} · QA only, never added to BMR</span></td><td class="num">${kcal(calc.comparison[MODEL.RAW])}</td></tr>
            <tr class="used-row"><td>${MODEL_LABELS[MODEL.INTERMEDIATE]}<span class="sub">${MODEL_FORMULAS[MODEL.INTERMEDIATE]} · the only active model, applied to TDEE</span></td><td class="num strong">${kcal(calc.comparison[MODEL.INTERMEDIATE])}</td></tr>
            <tr class="raw-row"><td>${MODEL_LABELS[MODEL.KRI]}<span class="sub">${MODEL_FORMULAS[MODEL.KRI]} · retired Sept 3 — restatement impact +${kcal(calc.comparison[MODEL.KRI] - calc.comparison[MODEL.INTERMEDIATE])}</span></td><td class="num">${kcal(calc.comparison[MODEL.KRI])}</td></tr>
          </tbody>
        </table>
      </details>` : ''}

      ${hrBlock(calc)}

      <details class="side-block" data-key="quality" ${warnCount ? 'open' : ''}>
        <summary>Data quality <span class="meta">${warnCount ? `${warnCount} warning${warnCount === 1 ? '' : 's'}` : `${calc.flags.length} note${calc.flags.length === 1 ? '' : 's'}`}</span></summary>
        <ul class="flags">${flags}</ul>
      </details>
    </div>
  </div>`;
}

function hrBlock(calc) {
  const hr = calc.hr;
  if (!hr) return '';
  const s = hr.dayStats;
  const d = hr.day;
  const verdictText = !d ? 'too few readings in the shift'
    : d.verdict === 'validates' ? 'agrees'
      : d.verdict === 'revise-up' ? `suggests higher (~${d.suggestedMet})`
        : d.verdict === 'revise-down' ? `suggests lower (~${d.suggestedMet})`
          : 'near resting';
  const rows = calc.phases.filter((p) => p.bpm && p.bpm.fromExport).map((p) => `
    <tr><td>${esc(p.description || 'Untitled phase')}<span class="sub">${esc(p.start)}–${esc(p.end)} · median ${p.bpm.stats.median} · HRR ${Math.round(p.bpm.hrr * 100)}%</span></td>
      <td class="num">${p.bpm.implied ? `${p.bpm.implied.metMin}–${(p.bpm.impliedMax || p.bpm.implied).metMax}` : '—'}<span class="sub">logged ${num(p.met, 1)}</span></td></tr>`).join('');
  return `
      <details class="side-block" data-key="hr" open>
        <summary>Heart rate <span class="meta">${d ? verdictText : `${hr.readings} readings`}</span></summary>
        ${s && s.n ? `
        <table class="mini-table">
          <tbody>
            <tr><td>Work window<span class="sub">${s.n} readings · median ${s.median} · 90th pct ${s.p90} · peak ${s.peak}${s.exercising ? ` · ${s.exercising} Exercising` : ''}</span></td>
              <td class="num">${d && d.implied ? `MET ${d.implied.metMin}–${(d.impliedMax || d.implied).metMax}` : '—'}<span class="sub">${d ? `HRR ${Math.round(d.hrr * 100)}%` : ''}</span></td></tr>
            <tr><td>Logged, blended by minutes</td><td class="num">${calc.blendedMet === null ? '—' : `MET ${calc.blendedMet.toFixed(2)}`}</td></tr>
            ${rows}
          </tbody>
        </table>
        ${hrApplyButton(d, 'data-action="apply-hr-day"', 'Use for every phase: MET')}` : '<p class="side-empty">No readings inside the shift window.</p>'}
      </details>`;
}

export function refreshResults() {
  const host = document.getElementById('results');
  if (!host || !draft) return null;
  const calc = calculateDay(withResolvedWeight(draft), store.getSettings());
  const open = new Map([...host.querySelectorAll('details[data-key]')].map((d) => [d.dataset.key, d.open]));
  host.innerHTML = resultsTemplate(calc);
  // Keep the reader's expanded/collapsed choice across live recalculation —
  // by name, since sections come and go (the heart-rate block, for one).
  host.querySelectorAll('details[data-key]').forEach((d) => {
    if (open.has(d.dataset.key)) d.open = open.get(d.dataset.key);
  });
  // Derived values embedded in the form re-render in place, so the form itself
  // never has to be rebuilt (which would steal focus mid-edit).
  for (const p of calc.phases) {
    const headline = document.querySelector(`[data-phase-card="${p.id}"] .phase-kcal`);
    if (headline) headline.textContent = `${kcal(p.kcal)} kcal`;
    const alloc = document.querySelector(`[data-alloc="${p.id}"]`);
    if (alloc) alloc.textContent = allocText(p);
  }
  return calc;
}

/** The engine takes an explicit weight and the day's heart-rate readings. */
function withResolvedWeight(entry) {
  return store.resolveEntry(entry);
}

/* --------------------------------- render -------------------------------- */

export function render(root) {
  if (!draft) loadDate(todayIso());
  root.innerHTML = `
    <section id="results" class="entry-result" aria-live="polite"></section>
    <form id="entry-form" class="entry-form" autocomplete="off"></form>`;

  const form = root.querySelector('#entry-form');
  rebuildForm(form);

  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('input', (e) => onFieldEvent(e, form));
  // Typed fields were already handled keystroke by keystroke on `input`. Their
  // blur-time `change` would re-render the results panel mid-click, swallowing
  // a click on "+ Add phase" or a disclosure made right after typing.
  const TYPED = 'input:not([type]), input[type="text"], input[type="number"], input[type="time"], textarea';
  form.addEventListener('change', (e) => {
    if (!e.target.matches(TYPED)) onFieldEvent(e, form);
  });
  form.addEventListener('click', (e) => onClick(e, form));
  // "+ Add phase" in the result summary lives outside the form.
  root.querySelector('#results').addEventListener('click', (e) => {
    const applyDay = e.target.closest('[data-action="apply-hr-day"]');
    if (applyDay) {
      const met = Number(applyDay.dataset.met);
      for (const phase of draft.phases) if (phase.description || phase.met !== '') applyHrMet(phase, met, 'day-level work-window check, applied to every phase so the day blends to it');
      markDirty();
      rebuildForm(form);
      toast(`Revised ${applyDay.dataset.verdict === 'revise-down' ? 'down' : 'up'} to MET ${met} from heart rate.`);
      return;
    }
    if (!e.target.closest('[data-action="add-phase"]')) return;
    draft.phases.push(store.newPhase());
    markDirty();
    rebuildForm(form);
    const cards = form.querySelectorAll('.phase');
    const last = cards[cards.length - 1];
    last?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    last?.querySelector('[data-field="description"]')?.focus({ preventScroll: true });
  });
}

function rebuildForm(form) {
  const calc = calculateDay(withResolvedWeight(draft), store.getSettings());
  form.innerHTML = formTemplate(draft, calc);
  refreshResults();
}

function onFieldEvent(e, form) {
  const target = e.target;
  if (target.id === 'import-file-input') {
    handleImportFile(e, form);
    return;
  }
  if (target.id === 'entry-date') {
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
    if (fieldName === 'met') {
      // A MET typed by hand always wins over the glossary.
      Object.assign(phase, { metAuto: false, metSource: 'manual', metConfidence: '', metBasis: '', metNotes: [] });
      const basis = form.querySelector(`[data-basis="${phase.id}"]`);
      if (basis) basis.innerHTML = basisHtml(phase);
    } else if (fieldName === 'description' || fieldName === 'soilCode') {
      if (fieldName === 'soilCode') phase.soilManual = Boolean(value);
      if (applyGlossary(phase)) syncPhaseInputs(form, phase);
      else {
        const basis = form.querySelector(`[data-basis="${phase.id}"]`);
        if (basis) basis.innerHTML = basisHtml(phase);
      }
    }
  } else {
    draft[fieldName] = value;
    // Heat, shade or soil named in the notes change what the glossary reads.
    if (fieldName === 'feelsLikeF' || fieldName === 'notes') {
      for (const phase of draft.phases) if (applyGlossary(phase)) syncPhaseInputs(form, phase);
    }
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
      <span>− non-work <strong>${formatDuration(calc.timing.transitMinutes)}</strong></span>
      <span class="net">= net work <strong>${formatDuration(calc.timing.netWorkMinutes)}</strong></span>`;
  }
}

/**
 * A file with one or more "---"-separated day blocks is bulk-imported: every
 * block with a parseable date is saved directly as its own entry (full
 * create, overwriting anything already stored for that date), with no
 * per-field merge step — this is the "plug and play, don't make me click
 * through each day" path. A block with no date at all is skipped and
 * reported rather than guessed at.
 */
/** One toast line summarizing what the MET glossary did across imported phases. */
function metSummary(report) {
  if (!report.phases) return '';
  const parts = [`MET set automatically for ${report.phases} phase${report.phases === 1 ? '' : 's'}`];
  if (report.fromNotes) parts.push(`${report.fromNotes} from BPM-confirmed notes`);
  if (report.low) parts.push(`${report.low} low-confidence`);
  if (report.needsMet) parts.push(`${report.needsMet} with no match (enter by hand)`);
  if (report.excludedMinutes) parts.push(`${report.excludedMinutes} min of non-labor time excluded`);
  return `${parts.join(' · ')}.`;
}

function handleBulkImport(text, filename, form) {
  const savedDates = [];
  const skipped = { payroll: 0, undated: 0 };
  const totals = { phases: 0, fromNotes: 0, low: 0, needsMet: 0, excludedMinutes: 0 };

  for (const result of parseMultiDayLog(text, { filename })) {
    if (!result.patch) {
      skipped[result.skipped === 'payroll entry' ? 'payroll' : 'undated'] += 1;
      continue;
    }
    const { patch, metReport } = result;
    const entry = {
      ...store.newEntry(patch.date),
      ...patch,
      // A genuinely task-less day stays an empty array (not a padded blank
      // phase) so the engine's "no task phases logged" flag actually fires
      // in History. loadDate() adds a blank phase for editing convenience
      // only once someone opens that day in the Daily entry tab.
      phases: patch.phases && patch.phases.length
        ? patch.phases.map((p) => ({ ...store.newPhase(), ...p }))
        : [],
    };
    store.saveEntry(entry);
    savedDates.push(patch.date);
    for (const k of Object.keys(totals)) totals[k] += metReport[k] || 0;
  }

  savedDates.sort();
  toast(
    savedDates.length
      ? `Imported ${savedDates.length} day${savedDates.length === 1 ? '' : 's'}` +
          `${savedDates.length > 1 ? ` (${savedDates[0]} to ${savedDates.at(-1)})` : ` (${savedDates[0]})`}.` +
          ' Existing entries for those dates were overwritten.'
      : 'No day blocks had a readable date — nothing was imported.',
  );
  const summary = metSummary(totals);
  if (summary) toast(summary, totals.low || totals.needsMet ? 'warn' : 'ok');
  if (skipped.payroll) toast(`Skipped ${skipped.payroll} payroll entr${skipped.payroll === 1 ? 'y' : 'ies'} — not a work log.`);
  if (skipped.undated) toast(`${skipped.undated} block(s) had no "Date:" line and were skipped entirely.`, 'warn');

  if (savedDates.length) {
    loadDate(savedDates.at(-1));
    rebuildForm(form);
  }
  location.hash = 'history';
}

/**
 * Stores a Samsung Health heart-rate export by date and reports, day by day,
 * whether corrected HR → HRR agrees with each logged day's MET (§4, §5).
 * The readings live apart from day entries, so every check stays live as
 * shift or phase times are edited, and survives a calendar re-import.
 */
function handleHeartRateImport(readings, filename, form) {
  const byDate = groupByDate(readings);
  store.saveHeartRate(byDate);
  const dates = Object.keys(byDate).sort();
  const settings = store.getSettings();
  const counts = { agree: 0, up: 0, down: 0, other: 0, unlogged: 0 };
  const lines = [];
  for (const date of dates) {
    const entry = store.getState().entries[date];
    const head = `${date} · ${byDate[date].length} readings`;
    if (!entry) {
      counts.unlogged += 1;
      lines.push(`${head} — no logged day; stored for when one is added.`);
      continue;
    }
    if (entry.restDay) {
      counts.other += 1;
      lines.push(`${head} — non-work day; stored (a uni-day HR reference for §7).`);
      continue;
    }
    const calc = calculateDay(store.resolveEntry(entry), settings);
    const d = calc.hr && calc.hr.day;
    const s = calc.hr && calc.hr.dayStats;
    if (!d) {
      counts.other += 1;
      lines.push(`${head} — ${s && s.n ? `only ${s.n} inside the shift` : 'none inside the shift window'}; no check.`);
      continue;
    }
    const band = d.implied ? `MET ${d.implied.metMin}–${(d.impliedMax || d.implied).metMax}` : 'below the table floor';
    const verdict = d.verdict === 'validates' ? 'AGREES'
      : d.verdict === 'revise-up' ? `REVISE UP → ~${d.suggestedMet}`
        : d.verdict === 'revise-down' ? `REVISE DOWN → ~${d.suggestedMet}`
          : 'NEAR RESTING — check shift times';
    counts[d.verdict === 'validates' ? 'agree' : d.verdict === 'revise-up' ? 'up' : d.verdict === 'revise-down' ? 'down' : 'other'] += 1;
    lines.push(`${head} — work window median ${s.median} bpm (p90 ${s.p90}, peak ${s.peak}) → corrected ${d.correctedBpm} → HRR ${Math.round(d.hrr * 100)}% → ${band}; logged blended MET ${calc.blendedMet === null ? '—' : calc.blendedMet.toFixed(2)} — ${verdict}`);
    for (const p of calc.phases) {
      if (!p.bpm || !p.bpm.fromExport) continue;
      lines.push(`    ${p.start}–${p.end} ${p.description}: median ${p.bpm.stats.median} → HRR ${Math.round(p.bpm.hrr * 100)}% → ${p.bpm.implied ? `MET ${p.bpm.implied.metMin}–${(p.bpm.impliedMax || p.bpm.implied).metMax}` : 'below floor'}; logged ${p.met}`);
    }
  }
  const summary = `${readings.length} readings across ${dates.length} day${dates.length === 1 ? '' : 's'} (${dates[0]} to ${dates.at(-1)}). `
    + `${counts.agree} agree, ${counts.up} suggest higher, ${counts.down} suggest lower`
    + `${counts.other ? `, ${counts.other} not checkable` : ''}${counts.unlogged ? `, ${counts.unlogged} with no logged day` : ''}.`;
  openTextPanel({
    title: 'Heart rate vs MET',
    hint: `From ${filename}. Watch BPM → +30/+35 correction → HRR = (corrected − 49) / 152 → MET band, against each day's minute-blended MET. Revisions run both directions; open a day to apply one.`,
    text: `${summary}\n\n${lines.join('\n')}`,
  });
  toast(summary, counts.up || counts.down ? 'warn' : 'ok');
  rebuildForm(form);
}

/**
 * Reads a dropped/selected calendar log file, parses it, and merges the result
 * onto the current draft — switching days first if the file names a different
 * date. Fields the parser didn't confidently find are left exactly as they
 * were (blank, or whatever was already typed in). A file containing several
 * "---"-separated days is routed to the bulk importer instead.
 */
async function handleImportFile(e, form) {
  const fileInput = e.target;
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = '';
  if (!file) return;

  const ext = (file.name.split('.').pop() || '').toLowerCase();
  let text;
  try {
    if (ext === 'pdf') {
      toast('Reading PDF…');
      const buffer = await file.arrayBuffer();
      const { extractPdfText } = await import('../pdfText.js');
      text = await extractPdfText(buffer);
    } else {
      text = await file.text();
      if (ext === 'html' || ext === 'htm' || /^\s*<(!doctype|html)/i.test(text)) text = htmlToText(text);
    }
  } catch (err) {
    toast(err.message || 'Could not read that file.', 'warn');
    return;
  }

  // A heart-rate export has readings and no calendar "Shift:" line.
  if (!/^[ \t]*shift[ \t]*:/im.test(text)) {
    const readings = parseHeartRateText(text, { year: Number(draft.date.slice(0, 4)) });
    if (readings.length >= 5) {
      flushSave();
      handleHeartRateImport(readings, file.name, form);
      return;
    }
  }

  // Land any unsaved edit before imported days are written, so a pending
  // timer can't overwrite an imported date with the older in-progress draft.
  flushSave();
  const blocks = splitDayBlocks(text);
  if (blocks.length > 1) {
    handleBulkImport(text, file.name, form);
    return;
  }

  const { patch, matched, unmatched, metReport } = parseCalendarLog(text, {
    filename: file.name,
    fallbackDate: draft.date,
  });

  if (patch.date && patch.date !== draft.date) {
    loadDate(patch.date);
  }

  for (const [key, value] of Object.entries(patch)) {
    if (key === 'phases' || key === 'notes' || key === 'date') continue;
    if (value !== undefined && value !== null) draft[key] = value;
  }
  if (patch.phases && patch.phases.length) {
    draft.phases = patch.phases.map((p) => ({ ...store.newPhase(), ...p }));
  }
  draft.importFlags = patch.importFlags || [];
  draft.notes = draft.notes ? `${patch.notes}\n\n--- previous notes ---\n${draft.notes}` : patch.notes;

  markDirty();
  rebuildForm(form);

  toast(
    matched.length
      ? `Imported ${draft.date}: ${matched.join(', ')} parsed.`
      : `Imported ${draft.date}, but nothing matched a known pattern — see the format guide and original text in Notes.`,
  );
  const summary = metSummary(metReport);
  if (summary) toast(summary, metReport.low || metReport.needsMet ? 'warn' : 'ok');
  if (unmatched.length) toast(`Fill in manually: ${unmatched.join(', ')}.`, 'warn');
}

function onClick(e, form) {
  const action = e.target.dataset.action;
  if (!action) return;
  e.preventDefault();

  if (action === 'import-file') {
    form.querySelector('#import-file-input').click();
  } else if (action === 'add-phase') {
    draft.phases.push(store.newPhase());
    markDirty();
    rebuildForm(form);
  } else if (action === 'remove-phase') {
    const id = e.target.dataset.phase;
    draft.phases = draft.phases.filter((p) => p.id !== id);
    if (draft.phases.length === 0) draft.phases.push(store.newPhase());
    markDirty();
    rebuildForm(form);
  } else if (action === 'apply-hr-met') {
    const phase = draft.phases.find((p) => p.id === e.target.dataset.phase);
    if (phase) {
      applyHrMet(phase, Number(e.target.dataset.met), `this phase's ${phase.start}–${phase.end} window`);
      markDirty();
      rebuildForm(form);
    }
  } else if (action === 'apply-met') {
    const phase = draft.phases.find((p) => p.id === e.target.dataset.phase);
    if (phase) {
      applyGlossary(phase, { force: true });
      markDirty();
      rebuildForm(form);
    }
  } else if (action === 'delete-entry') {
    if (confirmClick(e.target, 'Delete this day?')) {
      store.deleteEntry(draft.date);
      loadDate(draft.date);
      rebuildForm(form);
      toast(`Deleted ${draft.date}`, 'warn');
    }
  }
}
