/** Reference tab — the spec's tables and standing disclaimers, always at hand. */

import {
  BACKGROUND_TIERS,
  BMR_KCAL,
  CAPTURE_CATEGORIES,
  DATASET_IV,
  KNOWN_LIMITATIONS,
  NEAT_TIERS,
  NON_WORK_DAY,
  OUT_OF_SCOPE,
  SOIL_CLASSES,
  TASK_METS,
  TEF_BASELINE_KCAL,
} from '../data.js';
import { MODEL_FORMULAS, MODEL_LABELS, MODEL } from '../engine.js';
import { ANCHORS, NON_LABOR, SOIL_TIERS } from '../metGlossary.js';
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
        <li><strong>BMR — ${BMR_KCAL.toLocaleString()} kcal/day, fixed constant.</strong> Never recalculated per day. <span class="sec-ref">§2</span></li>
        <li><strong>TEF — ~205–215 kcal</strong> (${TEF_BASELINE_KCAL} standard, ~10% of a ~2,000 kcal typical intake), adjusted only when logged intake differs significantly. <span class="sec-ref">§2</span></li>
        <li><strong>Samsung "Total burned calories" is not TDEE.</strong> Never reference it. <span class="sec-ref">§4</span></li>
      </ul>
    </section>

    <section class="card">
      <h3>Active work calorie model <span class="sec-ref">§3</span></h3>
      <table class="table">
        <thead><tr><th>Model</th><th>Formula</th><th>Status</th></tr></thead>
        <tbody>
          <tr>
            <td>${MODEL_LABELS[MODEL.INTERMEDIATE]}</td>
            <td class="mono">${MODEL_FORMULAS[MODEL.INTERMEDIATE]}</td>
            <td><strong>The only active model</strong> — all intensities, all work days</td>
          </tr>
          <tr class="raw-row">
            <td>${MODEL_LABELS[MODEL.RAW]}</td>
            <td class="mono">${MODEL_FORMULAS[MODEL.RAW]}</td>
            <td>Comparison only — never a TDEE input (double-counts ~113 kcal/hr with BMR added separately)</td>
          </tr>
          <tr class="raw-row">
            <td>${MODEL_LABELS[MODEL.KRI]}</td>
            <td class="mono">${MODEL_FORMULAS[MODEL.KRI]}</td>
            <td>Retired Sept 3, 2026 — overlapped Intermediate too heavily. Restatement impact ≈ 29 kcal per active hour.</td>
          </tr>
        </tbody>
      </table>
      <p class="muted">
        Every day, before or after Sept 3, is computed under Intermediate. Do not average restated figures against
        pre-restatement ones.
      </p>
      <p class="formula small">Net active = (shift end − shift start) − lunch − breaks − documented idle/travel</p>
      <p class="muted">Idle and travel are excluded outright, not assigned a low MET. Multi-task days get a blended MET weighted by minutes per task.</p>
    </section>

    <section class="card">
      <h3>Soil / task classification <span class="sec-ref">§5</span></h3>
      <table class="table">
        <thead><tr><th>Code</th><th>Classification</th><th>Description</th><th class="right">MET</th></tr></thead>
        <tbody>
          ${SOIL_CLASSES.map(
            (s) => `<tr>
              <td class="mono">${s.code}</td>
              <td>${esc(s.name)}</td>
              <td class="muted">${esc(s.description)}</td>
              <td class="right">${metRange(s.metMin, s.metMax)}</td>
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
        <li>BPM agrees → keep. BPM disagrees → <strong>revise and state the revision</strong>.</li>
        <li>Revision runs both directions. Sept 5 was the first downward revision (7.5 → 6.0); record downward revisions with the same prominence as upward ones.</li>
        <li>Heat index 88°F+ confirms upper-range MET assignments but does not independently raise the MET value.</li>
        <li>Multi-task days: split into phases by task description and calendar timestamps, assign MET per phase, and weight active kcal by net time per phase.</li>
      </ol>
    </section>

    <section class="card">
      <h3>Automatic MET from calendar text <span class="sec-ref">MET glossary</span></h3>
      <p class="muted">
        Imported days, and any task you describe on the Daily entry tab, get their MET from the MET glossary rather
        than by hand. The first rule that applies wins:
      </p>
      <ol class="ref-list numbered">
        <li><strong>A BPM-confirmed revision in the day's NOTE line</strong> ("revised to MET 7.5", "Blended MET 7.12") — the glossary never overrides BPM.</li>
        <li><strong>A MET you typed by hand</strong> — the glossary's own reading is shown beside it with a <em>Use</em> button.</li>
        <li><strong>Glossary terms</strong> — soil for digs, then tools and materials; several in one task are averaged, a dingo task splits machine/manual evenly.</li>
        <li><strong>The spec §5 task table</strong> for work the glossary doesn't cover (mulch, pine straw…), then plain verbs (haul, install, spread).</li>
        <li><strong>No match</strong> — left blank and flagged, never guessed.</li>
      </ol>
      <p class="muted">
        Feels-like ≥ 88°F picks the <em>upper end</em> of a range instead of the midpoint; it never adds MET on its own, and
        "under shade" switches that off. Loaded wheelbarrow +0.75, pickaxe outside a dig +0.75, machete on sod +0.5,
        rush +0.5, steep hill/incline +1.25, glue at the tail −0.25. Results stay inside 3.5–9.0. Each phase shows its
        reasoning and a confidence tag — <em>low</em> means an unstated soil, a spec/verb fallback, or phrasing that BPM
        has previously caught as under-described.
      </p>
      <div class="grid grid-2">
        <div>
          <h4>Soil for digs (§1)</h4>
          <table class="table compact">
            <tbody>
              ${SOIL_TIERS.map((t) => `<tr><td>${esc(t.code)} · ${esc(t.label)}</td><td class="right">${metRange(t.lo, t.hi)}</td></tr>`).join('')}
            </tbody>
          </table>
          <p class="muted small">A dig with no soil named anywhere in the day defaults to MC at low confidence.</p>
          <h4 style="margin-top:18px">Excluded as non-labor (§6)</h4>
          <ul class="ref-list">${NON_LABOR.map((n) => `<li>${esc(n.reason)}</li>`).join('')}</ul>
        </div>
        <div>
          <h4>Tools &amp; materials (§2 · §3)</h4>
          <table class="table compact">
            <tbody>
              ${ANCHORS.map((a) => `<tr><td>${esc(a.label)}${a.risk ? ' <span class="est-tag">RISK</span>' : ''}</td><td class="right">${metRange(a.lo, a.hi)}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="card">
      <h3>Active time &amp; net work time <span class="sec-ref">§7 · §8</span></h3>
      <p class="formula small">Net work time = (shift end − shift start) − lunch − documented breaks − explicit non-work transit</p>
      <ul class="ref-list">
        <li>Calendar-documented pure work windows are the preferred input. When timestamps are explicit, no further capture-rate adjustment is applied.</li>
        <li>Samsung "active minutes" is a cross-check floor, not a primary input. A capture rate far outside the expected band is a data-quality note — it never overrides calendar-based net work time.</li>
        <li>Breaks default to ~10 min per session when only a count is logged — a working assumption, stated on every day it's used. Start/end timestamps remain the highest-value logging fix.</li>
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
      <h3>Estimated lines <span class="sec-ref">§2</span></h3>
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

    <section class="card">
      <h3>University / non-work days <span class="sec-ref">§7</span></h3>
      <p class="muted">No task or soil to classify. Built additively, with no separate background bucket — with no labor block, it folds into general NEAT. Tick <em>Non-work day</em> on the Daily entry tab and log the step count.</p>
      <table class="table compact">
        <tbody>
          <tr><td>BMR</td><td class="right">${BMR_KCAL.toLocaleString()}</td></tr>
          <tr><td>Walking, 8–9k steps @ MET ${NON_WORK_DAY.walkingMet}, ~1.4 hr</td><td class="right">~185–200</td></tr>
          <tr><td>General day NEAT</td><td class="right">~90–100</td></tr>
          <tr><td>TEF</td><td class="right">~190–210</td></tr>
          <tr><td><strong>Total</strong></td><td class="right"><strong>~${NON_WORK_DAY.expectedTotal.toLocaleString()}</strong></td></tr>
        </tbody>
      </table>
      <p class="muted small">Still unvalidated. Priority: a full uni-day HR export paired with that day's step count.</p>
    </section>

    <section class="card">
      <h3>Standing data-quality problems <span class="sec-ref">§8</span></h3>
      <ol class="ref-list numbered">
        <li><strong>Calendar start_time is unreliable</strong> (broken Aug 19, Aug 24). end_time has held up on every broken entry. When they conflict with the task or a logged lunch, trust HR.</li>
        <li><strong>A "half." title carries no duration information.</strong> Both broken-timestamp days were titled "half." and were full shifts.</li>
        <li><strong>Break logging degraded</strong> — counts replaced timestamps. ~10 min/break assumed and stated every time.</li>
        <li><strong>Missing task descriptions</strong> (Aug 28, Sept 4). Aug 28 was a total loss; Sept 4 survived only because HR existed.</li>
        <li><strong>Vague descriptions understate load.</strong> Aug 31 read as light material moving and was a 7.5. Describe resistance and continuity, not just the verb.</li>
        <li><strong>Hybrid work/uni days exist.</strong> Segment them; don't average across the lecture block.</li>
        <li><strong>HR coverage runs through Sept 10.</strong> Keep a weekly export cadence.</li>
      </ol>
      <p class="muted small">The importer flags the first four automatically when the calendar text shows them.</p>
    </section>

    <section class="card">
      <h3>Dataset of record — Intermediate <span class="sec-ref">§6</span></h3>
      <p class="muted">Hand-computed in DILIGENT IV. When a stored day falls on one of these dates, its data-quality panel shows the difference, so the two can be reconciled rather than assumed in sync.</p>
      <table class="table compact">
        <thead><tr><th>Date</th><th>Task</th><th class="right">MET</th><th class="right">Active hr</th><th class="right">TDEE</th></tr></thead>
        <tbody>
          ${DATASET_IV.map((d) => `<tr><td class="mono">${d.date.slice(5)}</td><td>${esc(d.task)}${d.note ? `<span class="sub muted small"> — ${esc(d.note)}</span>` : ''}</td><td class="right">${d.met ?? '—'}</td><td class="right">${d.hours ?? '—'}</td><td class="right">${d.tdee === null ? 'unusable' : `~${d.tdee.toLocaleString()}`}</td></tr>`).join('')}
        </tbody>
      </table>
    </section>

    <section class="card limitations">
      <h3>Known limitations</h3>
      <ul class="ref-list">${KNOWN_LIMITATIONS.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
      <h4>Explicitly out of scope</h4>
      <ul class="ref-list">${OUT_OF_SCOPE.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
      <p class="muted small">This app is a calculation tool, not medical advice.</p>
    </section>
  `;
}
