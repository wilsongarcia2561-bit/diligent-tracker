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
import { COMPONENTS, trailingAverage } from '../analytics.js';
import { parseCalendarLog, splitDayBlocks } from '../calendarImport.js';
import * as store from '../store.js';
import { confirmClick, debounce, esc, kcal, num, pct, toast, todayIso } from '../ui.js';
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

const save = debounce(() => {
  if (!draft || !draft.date) return;
  store.saveEntry(draft);
  dirty = false;
  setSaveState('saved');
}, 500);

function markDirty() {
  dirty = true;
  setSaveState('pending');
  save();
}

export function loadDate(date) {
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
      ${field('Soil class', `<select id="p-${phase.id}-soilCode" data-phase="${phase.id}" data-field="soilCode">${soilOptions(phase.soilCode)}</select>`)}
      ${field('MET', phaseInput(phase.id, 'met', phase.met, 'type="number" step="0.1" min="0" max="16" placeholder="6.5"'))}
      ${field('Start', phaseInput(phase.id, 'start', phase.start, 'type="time"'))}
      ${field('End', phaseInput(phase.id, 'end', phase.end, 'type="time"'))}
    </div>

    <div class="grid grid-3">
      ${field(
        'Model',
        `<select id="p-${phase.id}-modelOverride" data-phase="${phase.id}" data-field="modelOverride">
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
        `<label class="check"><input type="checkbox" id="p-${phase.id}-vigorous" data-phase="${phase.id}" data-field="vigorous" ${phase.vigorous ? 'checked' : ''}> Forces KRI</label>`,
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
      <label class="check"><input type="checkbox" id="f-restDay" data-field="restDay" ${entry.restDay ? 'checked' : ''}> Rest day</label>
      <button type="button" class="btn ghost" data-action="import-file">Import from file</button>
      <input type="file" id="import-file-input" accept=".md,.markdown,.txt,.pdf" hidden>
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
      <label class="check"><input type="checkbox" id="f-heatInferred" data-field="heatInferred" ${entry.heatInferred ? 'checked' : ''}> Heat ≥88°F inferred (not documented) — flags the day</label>
      <label class="check"><input type="checkbox" id="f-outOfStateSupplyRun" data-field="outOfStateSupplyRun" ${entry.outOfStateSupplyRun ? 'checked' : ''}> Out-of-state supply run</label>
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

  const maxNet = Math.max(1, ...calc.phases.map((p) => p.netMinutes));
  const phaseRows = calc.phases.map((p, i) => `
    <li class="phase-row">
      <div class="phase-row-head">
        <span class="idx">${String(i + 1).padStart(2, '0')}</span>
        <span class="phase-name">${esc(p.description || 'Untitled phase')}</span>
        <span class="pill model-${p.model}">${MODEL_LABELS[p.model]}</span>
        <span class="phase-burn">${kcal(p.kcal)}</span>
      </div>
      <div class="phase-row-meta">
        <span>${p.soilCode ? `${p.soilCode} · ${esc(soilName(p.soilCode))}` : '—'}</span>
        <span>${hm(p.netMinutes)}</span>
        <span class="meter"><span style="width:${((p.netMinutes / maxNet) * 100).toFixed(1)}%"></span></span>
        <span>MET ${num(p.met, 1)}</span>
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
        ${COMPONENTS.map((c) => `<span class="${c.estimate ? 'est' : ''}" style="flex:${Math.max(0.001, calc.components[c.key] || 0)};--sw:${c.color}" title="${c.label}: ${kcal(calc.components[c.key])} kcal"></span>`).join('')}
      </div>
      <ul class="legend-grid">
        ${COMPONENTS.map((c) => `<li><span class="swatch" style="--sw:${c.color}"></span><span>${c.label}${c.estimate ? ' <span class="est-tag">EST</span>' : ''}</span><strong>${kcal(calc.components[c.key])}</strong></li>`).join('')}
      </ul>
    </div>

    <div class="result-side">
      <div class="strip">
        <div><span class="mini-label">Shift</span><span class="strip-val">${calc.restDay ? 'Rest day' : draft.shiftStart && draft.shiftEnd ? `${clock(draft.shiftStart)}–${clock(draft.shiftEnd)}` : '—'}</span></div>
        <div><span class="mini-label">Net work</span><span class="strip-val">${calc.restDay ? '—' : hm(calc.timing.netWorkMinutes)}</span></div>
        <div><span class="mini-label">Feels-like</span><span class="strip-val">${calc.feelsLikeF === null ? '—' : `${calc.feelsLikeF}°F`}</span></div>
        <div><span class="mini-label">Sites</span><span class="strip-val">${calc.siteCount}</span></div>
      </div>

      <div class="side-head">
        <h3>Task phases</h3>
        ${calc.restDay ? '' : '<button type="button" class="btn ghost sm" data-action="add-phase">+ Add phase</button>'}
      </div>
      ${calc.restDay
        ? '<p class="side-empty">Rest day — no active work. NEAT, TEF and background daily life still count.</p>'
        : calc.phases.length
          ? `<ol class="phase-list">${phaseRows}</ol>`
          : '<p class="side-empty">No task phases yet. Describe the work below and a MET is suggested automatically.</p>'}

      ${calc.phases.length ? `
      <details class="side-block">
        <summary>Model comparison <span class="meta">§12.11</span></summary>
        <table class="mini-table">
          <tbody>
            <tr class="raw-row"><td>${MODEL_LABELS[MODEL.RAW]}<span class="sub">${MODEL_FORMULAS[MODEL.RAW]} · QA only, never added to BMR</span></td><td class="num">${kcal(calc.comparison[MODEL.RAW])}</td></tr>
            <tr><td>${MODEL_LABELS[MODEL.INTERMEDIATE]}<span class="sub">${MODEL_FORMULAS[MODEL.INTERMEDIATE]} · all phases</span></td><td class="num">${kcal(calc.comparison[MODEL.INTERMEDIATE])}</td></tr>
            <tr><td>${MODEL_LABELS[MODEL.KRI]}<span class="sub">${MODEL_FORMULAS[MODEL.KRI]} · all phases</span></td><td class="num">${kcal(calc.comparison[MODEL.KRI])}</td></tr>
            <tr class="used-row"><td>Used<span class="sub">${calc.comparison.mixed ? 'mixed per-phase selection' : 'single model across phases'} · applied to TDEE</span></td><td class="num strong">${kcal(calc.comparison.used)}</td></tr>
          </tbody>
        </table>
      </details>` : ''}

      <details class="side-block" ${warnCount ? 'open' : ''}>
        <summary>Data quality <span class="meta">${warnCount ? `${warnCount} warning${warnCount === 1 ? '' : 's'}` : `${calc.flags.length} note${calc.flags.length === 1 ? '' : 's'}`}</span></summary>
        <ul class="flags">${flags}</ul>
      </details>
    </div>
  </div>`;
}

export function refreshResults() {
  const host = document.getElementById('results');
  if (!host || !draft) return null;
  const calc = calculateDay(withResolvedWeight(draft), store.getSettings());
  const open = [...host.querySelectorAll('details')].map((d) => d.open);
  host.innerHTML = resultsTemplate(calc);
  // Keep the reader's expanded/collapsed choice across live recalculation.
  host.querySelectorAll('details').forEach((d, i) => {
    if (open[i] !== undefined) d.open = open[i];
  });
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
    <section id="results" class="entry-result" aria-live="polite"></section>
    <form id="entry-form" class="entry-form" autocomplete="off"></form>`;

  const form = root.querySelector('#entry-form');
  rebuildForm(form);

  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('input', (e) => onFieldEvent(e, form));
  form.addEventListener('change', (e) => onFieldEvent(e, form));
  form.addEventListener('click', (e) => onClick(e, form));
  // "+ Add phase" in the result summary lives outside the form.
  root.querySelector('#results').addEventListener('click', (e) => {
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

/**
 * A file with one or more "---"-separated day blocks is bulk-imported: every
 * block with a parseable date is saved directly as its own entry (full
 * create, overwriting anything already stored for that date), with no
 * per-field merge step — this is the "plug and play, don't make me click
 * through each day" path. A block with no date at all is skipped and
 * reported rather than guessed at.
 */
function handleBulkImport(blocks, filename, form) {
  const savedDates = [];
  let skipped = 0;
  const unmatchedByDate = {};

  for (const block of blocks) {
    const { patch, unmatched } = parseCalendarLog(block, { filename });
    if (!patch.date) {
      skipped += 1;
      continue;
    }
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
    if (unmatched.length) unmatchedByDate[patch.date] = unmatched;
  }

  savedDates.sort();
  const daysWithGaps = savedDates.filter((d) => (unmatchedByDate[d] || []).length > 2);

  toast(
    savedDates.length
      ? `Imported ${savedDates.length} day${savedDates.length === 1 ? '' : 's'}` +
          `${savedDates.length > 1 ? ` (${savedDates[0]} to ${savedDates.at(-1)})` : ` (${savedDates[0]})`}.` +
          ` Existing entries for those dates were overwritten.`
      : 'No day blocks had a readable date — nothing was imported.',
  );
  if (skipped) toast(`${skipped} block(s) had no "Date:" line and were skipped entirely.`, 'warn');
  if (daysWithGaps.length) {
    toast(`${daysWithGaps.length} day(s) are missing several fields — check them in History.`, 'warn');
  }

  if (savedDates.length) {
    loadDate(savedDates.at(-1));
    rebuildForm(form);
  }
  location.hash = 'history';
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
    }
  } catch (err) {
    toast(err.message || 'Could not read that file.', 'warn');
    return;
  }

  const blocks = splitDayBlocks(text);
  if (blocks.length > 1) {
    handleBulkImport(blocks, file.name, form);
    return;
  }

  const { patch, matched, unmatched } = parseCalendarLog(text, {
    filename: file.name,
    fallbackDate: draft.date,
  });

  if (patch.date && patch.date !== draft.date) {
    if (dirty) store.saveEntry(draft);
    loadDate(patch.date);
  }

  for (const [key, value] of Object.entries(patch)) {
    if (key === 'phases' || key === 'notes' || key === 'date') continue;
    if (value !== undefined && value !== null) draft[key] = value;
  }
  if (patch.phases && patch.phases.length) {
    draft.phases = patch.phases.map((p) => ({ ...store.newPhase(), ...p }));
  }
  draft.notes = draft.notes ? `${patch.notes}\n\n--- previous notes ---\n${draft.notes}` : patch.notes;

  markDirty();
  rebuildForm(form);

  toast(
    matched.length
      ? `Imported ${draft.date}: ${matched.join(', ')} parsed.`
      : `Imported ${draft.date}, but nothing matched a known pattern — see the format guide and original text in Notes.`,
  );
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
    if (confirmClick(e.target, 'Delete this day?')) {
      store.deleteEntry(draft.date);
      loadDate(draft.date);
      rebuildForm(form);
      toast(`Deleted ${draft.date}`, 'warn');
    }
  }
}
