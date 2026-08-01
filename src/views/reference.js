/** Reference tab — the spec's tables and standing disclaimers, always at hand. */

import {
  BACKGROUND_TIERS,
  BMR_KCAL,
  CAPTURE_CATEGORIES,
  KNOWN_LIMITATIONS,
  NEAT_TIERS,
  OUT_OF_SCOPE,
  SOIL_CLASSES,
  TASK_METS,
  TEF_BASELINE_KCAL,
} from '../data.js';
import { MODEL_FORMULAS, MODEL_LABELS, MODEL } from '../engine.js';
import { esc } from '../ui.js';

function metRange(min, max) {
  return min === max ? String(min) : `${min}–${max}`;
}

export function render(root) {
  root.innerHTML = `
    <div class="card-head"><h2>Framework reference</h2></div>

    <section class="card">
      <h3>Core formula <span class="sec-ref">§1</span></h3>
      <p class="formula">TDEE = BMR + Active Work Calories + Post-Work NEAT + TEF + Background Daily Life</p>
      <p class="muted">
        Every component is additive and none double-counts another. BMR represents MET 1.0 (resting) for 24 hours;
        all other components represent calories above that resting floor.
      </p>
      <ul class="ref-list">
        <li><strong>BMR — ${BMR_KCAL.toLocaleString()} kcal/day (fixed).</strong> Measured on an Oxiline Scale MD Pro (8-electrode segmental BIA). Not recalculated from Mifflin-St Jeor or any other population formula; stays fixed unless a new DEXA or working BIA device provides an update. <span class="sec-ref">§2</span></li>
        <li><strong>TEF — ${TEF_BASELINE_KCAL} kcal standard</strong> (~10% of a ~2,000 kcal typical intake), adjusted only when logged intake differs significantly. <span class="sec-ref">§10</span></li>
      </ul>
    </section>

    <section class="card">
      <h3>Active work calorie models <span class="sec-ref">§3</span></h3>
      <table class="table">
        <thead><tr><th>Model</th><th>Formula</th><th>Use when</th></tr></thead>
        <tbody>
          <tr class="raw-row">
            <td>${MODEL_LABELS[MODEL.RAW]}</td>
            <td class="mono">${MODEL_FORMULAS[MODEL.RAW]}</td>
            <td>Comparison only — never a TDEE input (double-counts the ~113 kcal/hr resting floor)</td>
          </tr>
          <tr>
            <td>${MODEL_LABELS[MODEL.INTERMEDIATE]}</td>
            <td class="mono">${MODEL_FORMULAS[MODEL.INTERMEDIATE]}</td>
            <td>MET &lt; 6.5 <strong>and</strong> feels-like temp &lt; 88°F</td>
          </tr>
          <tr>
            <td>${MODEL_LABELS[MODEL.KRI]}</td>
            <td class="mono">${MODEL_FORMULAS[MODEL.KRI]}</td>
            <td>MET ≥ 6.5, <strong>or</strong> feels-like ≥ 88°F, <strong>or</strong> HC/HCP/SRW soil, <strong>or</strong> any sustained vigorous day</td>
          </tr>
        </tbody>
      </table>
      <p class="muted">
        Model selection is per-task, not per-day — a single day can have multiple task phases, each independently assigned.
        The 88°F threshold applies to feels-like / heat index, not raw temperature. Where feels-like isn't documented but
        conditions strongly imply ≥88°F, apply KRI and mark the day as inferential rather than skipping it.
      </p>
    </section>

    <section class="card">
      <h3>Soil / task classification <span class="sec-ref">§5</span></h3>
      <table class="table">
        <thead><tr><th>Code</th><th>Classification</th><th>Description</th><th class="right">MET</th><th></th></tr></thead>
        <tbody>
          ${SOIL_CLASSES.map(
            (s) => `<tr>
              <td class="mono">${s.code}</td>
              <td>${esc(s.name)}</td>
              <td class="muted">${esc(s.description)}</td>
              <td class="right">${metRange(s.metMin, s.metMax)}</td>
              <td>${s.kriTrigger ? '<span class="pill kri">KRI</span>' : ''}</td>
            </tr>`,
          ).join('')}
        </tbody>
      </table>
    </section>

    <section class="card">
      <h3>Other tasks <span class="sec-ref">§5</span></h3>
      <table class="table">
        <thead><tr><th>Task</th><th class="right">MET</th><th>Capture band <span class="sec-ref">§7</span></th></tr></thead>
        <tbody>
          ${TASK_METS.map(
            (t) => `<tr>
              <td>${esc(t.label)}</td>
              <td class="right">${metRange(t.metMin, t.metMax)}</td>
              <td class="muted small">${esc(CAPTURE_CATEGORIES[t.capture].label)} · ${Math.round(CAPTURE_CATEGORIES[t.capture].min * 100)}–${Math.round(CAPTURE_CATEGORIES[t.capture].max * 100)}%</td>
            </tr>`,
          ).join('')}
        </tbody>
      </table>
    </section>

    <section class="card">
      <h3>MET assignment process <span class="sec-ref">§5</span></h3>
      <ol class="ref-list numbered">
        <li>Primary input: task description + soil classification from the calendar log.</li>
        <li>Validation: corrected BPM → HRR → cross-check against the MET-HRR table.</li>
        <li>If BPM validates the task MET, use the task MET.</li>
        <li>If BPM suggests higher, revise the task MET upward and note the revision.</li>
        <li>Heat index confirms upper-range MET assignments but does not independently raise the MET value.</li>
        <li>Multi-task days: split into phases by task description and calendar timestamps, assign MET per phase, and weight active kcal by net time per phase.</li>
      </ol>
    </section>

    <section class="card">
      <h3>Active time &amp; net work time <span class="sec-ref">§7 · §8</span></h3>
      <p class="formula small">Net work time = (shift end − shift start) − lunch − documented breaks − explicit non-work transit</p>
      <ul class="ref-list">
        <li>Calendar-documented pure work windows are the preferred input. When timestamps are explicit, no further capture-rate adjustment is applied.</li>
        <li>Samsung "active minutes" is a cross-check floor, not a primary input. A capture rate far outside the expected band is a data-quality note — it never overrides calendar-based net work time.</li>
        <li>Breaks default to 11 min per session when exact timestamps aren't logged, multiplied by the day's break count.</li>
        <li>Multi-site days allocate breaks and lunch proportionally across sites by gross on-site time, unless exact timestamps pin them to one site.</li>
        <li>Activity embedded in a lunch block (e.g. a landfill run) is split out: ~30–40 min of true eating time, with the embedded task logged as its own phase and MET.</li>
      </ul>
      <table class="table compact">
        <thead><tr><th>Task type</th><th class="right">Expected capture rate</th></tr></thead>
        <tbody>
          ${Object.values(CAPTURE_CATEGORIES)
            .map((c) => `<tr><td>${esc(c.label)}</td><td class="right">${Math.round(c.min * 100)}–${Math.round(c.max * 100)}%</td></tr>`)
            .join('')}
        </tbody>
      </table>
    </section>

    <section class="card">
      <h3>Estimated lines <span class="sec-ref">§9 · §11</span></h3>
      <div class="grid grid-2">
        <div>
          <h4>Post-work NEAT</h4>
          <table class="table compact">
            <tbody>${NEAT_TIERS.map((t) => `<tr><td>${esc(t.label)}</td><td class="right">${t.min}–${t.max} kcal</td></tr>`).join('')}</tbody>
          </table>
        </div>
        <div>
          <h4>Background daily life</h4>
          <table class="table compact">
            <tbody>${BACKGROUND_TIERS.map((t) => `<tr><td>${esc(t.label)}</td><td class="right">${t.kcal} kcal</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </div>
      <p class="muted">
        Background daily life covers wake/dress/bathroom, commute, sitting during breaks and lunch (the eating itself is
        covered by TEF), and the evening routine. It is the least rigorous line in the framework — roughly ±30–40% internal
        error, but small enough in absolute terms to contribute only ~±75–100 kcal of total TDEE uncertainty. Do not
        over-invest precision here relative to the active-kcal calculation.
      </p>
    </section>

    <section class="card limitations">
      <h3>Known limitations <span class="sec-ref">§13</span></h3>
      <ul class="ref-list">${KNOWN_LIMITATIONS.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
      <h4>Explicitly out of scope</h4>
      <ul class="ref-list">${OUT_OF_SCOPE.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
      <p class="muted small">This app is a calculation tool, not medical advice.</p>
    </section>
  `;
}
