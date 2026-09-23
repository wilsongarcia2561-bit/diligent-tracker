# Diligent IV — TDEE Tracker

A local web app implementing **DILIGENT IV — TDEE Methodology & Dataset** (revised Sept 23, 2026),
which supersedes the Diligent III framework spec. Everything runs
in the browser: no build step, no dependencies, no network calls, no accounts. Data lives in the
browser's `localStorage`.

```
TDEE = BMR + Active Work Calories + Post-Work NEAT + TEF + Background Daily Life
```

## Running it

```bash
python3 server.py          # http://localhost:8000
python3 server.py 9000     # or pick a port
```

The app uses ES modules, which browsers refuse to load over `file://`, so it needs to be served.
`server.py` is a stdlib-only static server bound to `127.0.0.1`. Any other static server works
too (`npx serve`, `python3 -m http.server`).

## Tests

```bash
npm test          # or: node --test "tests/**/*.test.mjs"
```

58 tests covering the calculation engine — model selection, the three kcal formulas, net work
time, phase allocation, BPM correction and HRR, MET suggestion, the estimated lines, full-day
totals and trend aggregation. No dependencies; uses Node's built-in test runner.

## How the calculation works

**BMR — 1,436 kcal/day, fixed (§2).** Measured on an 8-electrode segmental BIA scale. Never
recalculated from Mifflin-St Jeor or any other population formula. Editable in Settings only for
when a new DEXA or working BIA reading supersedes it.

**Active work calories (§3).** Intermediate, `(MET − 1.0) × kg × hrs`, is the only active model —
all intensities, all work days. KRI was retired on Sept 3, 2026 and every day is restated under
Intermediate; the model-comparison panel shows what KRI would have given (≈ 29 kcal per active
hour more), and a phase stored with a forced-KRI override from before is restated and flagged.
Heat ≥ 88°F only confirms upper-range MET picks; it no longer changes the model.

**Kcal Raw is never added to BMR.** It appears only in the model-comparison table, greyed out and
labelled "QA only", because it double-counts the ~113 kcal/hr resting floor.

**Net work time (§8).** `(shift end − shift start) − lunch − breaks − non-work transit`. Breaks
default to ~10 min per session when only a count is logged, and every day that relies on it says
so. Only the part of a logged lunch that falls inside the shift is subtracted, so an afternoon
shift that starts as lunch ends loses nothing to it. Net time is then allocated
across phases proportionally by gross phase length — matching the spec's rule for spreading
breaks and lunch across multi-site days — unless a phase has exact net minutes entered, in which
case only the remainder is prorated. Work embedded in a lunch block is split out via the
"working minutes inside lunch" field and logged as its own phase with its own MET.

**Estimated lines (§9, §11).** NEAT and background daily life auto-select a tier from day
intensity and site count, and both are overridable. They are visually distinguished throughout —
dashed segments in the breakdown bar, an `est.` marker in the legend, a separate column in the
history table — because they're the lowest-confidence lines in the framework.

**Non-work / university days (§7).** Tick *Non-work day*: BMR + walking (MET 3.3, from the step
count, 8,500 steps ≈ 1.4 hr when blank) + ~95 general-day NEAT + ~200 TEF, with no background
bucket — ~1,950 kcal, still unvalidated.

**BPM cross-check (§5).** Runs both directions: a corrected HRR below the task MET is a
`revise-down` verdict with the same warning weight as `revise-up`.

**Reconciling with the document (§6, §12).** Days listed in DILIGENT IV's hand-computed dataset
show the document's figure and the difference in their data-quality panel (a warning past
±300 kcal), and the CSV export carries a `diligent_iv_tdee` column. The importer also flags the
§8 standing problems it can see in calendar text: a `"half."` title, a start_time inside the
logged lunch or before 4 AM, an empty `1.)` task item, and a downward BPM revision.

**Heart-rate exports (§4, §5).** *Import from file* also takes a Samsung Health heart-rate
export as `.html` or `.pdf` (any file with readings and no `Shift:` line). Readings are stored by
date, apart from day entries, so they survive a calendar re-import and every check stays live as
shift or phase times change. Each logged day's work window (shift minus lunch), and each phase
with a start/end, is summarized as a time-weighted median — dense sampling during a tagged
workout doesn't dominate it — then corrected (+30/+35), turned into HRR = (corrected − 49) / 152,
mapped to the MET band and compared with the minute-blended MET. A disagreement in either
direction is a warning with a one-click revision (to the band midpoint, in half-MET steps) that
records which way it went. After import, a copyable report lists every day's verdict.

The parser works line by line (a table row or line with a clock time and a heart rate, dated by
the nearest date above it), so it has only been checked against synthetic exports in the
layouts Samsung is likely to use — `tests/fixtures/sample-hr-export.html` — not a real one yet.

**TEF (§2).** 210 kcal standard. If a daily intake is logged and differs from the 2,000 kcal
baseline by more than 15%, TEF is re-suggested at 10% of actual intake. Overridable.

**Bodyweight (§4).** Seeded with the documented history (56.6 → 55.7 → 57.6 kg). Each day's
calculation uses the most recent reading on or before that date, so back-filling old days uses
the weight that was actually in effect. A per-entry fasted-morning weight also writes to the log.

## Features

| Spec | Feature | Status |
|---|---|---|
| §12.1 | Daily entry form — shift, lunch, breaks, weather, sites, tasks, bodyweight | ✅ |
| §12.2 | Auto MET suggestion from task keywords, editable | ✅ |
| §3 | Intermediate on every phase (KRI retired Sept 3; restatement shown) | ✅ |
| §12.4 | Full TDEE calculation engine | ✅ |
| §12.5 | History log, persistent and editable after the fact | ✅ |
| — | Calendar-log import (.md/.txt/.pdf) — fills known fields, leaves the rest blank | ✅ |
| §12.6 | Trend view — TDEE, weight, work vs rest, rolling 7-day | ✅ |
| §12.7 | Multi-site / multi-phase splitting with independent MET/model/time | ✅ |
| §12.8 | BPM/HRR calculator with correction factors and implied MET | ✅ |
| §12.9 | Samsung Health screenshot OCR | ❌ enter active minutes per phase by hand |
| §12.10 | MyFitnessPal-style food log | ⚠️ single daily intake field for deficit/surplus + TEF |
| §12.11 | Model comparison display with the used model flagged | ✅ |
| §12.12 | Data-quality flags | ✅ |

The two stretch goals (§12.9 OCR, §12.10 full food-log integration) are not built — both need
either an OCR pipeline or a third-party API, neither of which fits a dependency-free local app.
The manual fields cover the same inputs.

Data-quality flags fire on: missing BPM data, capture-rate mismatches against the §7 expected
bands, inferential (undocumented) heat triggers, estimated break time, phase windows that don't
reconcile with the shift, deductions exceeding the shift length, missing bodyweight, manual model
overrides, and BPM readings implying a higher MET than the task assignment.

## Calendar-log import

The Daily entry tab has an **Import from file** button (`.md`, `.txt`, or `.pdf`). It reads
whatever labeled fields it can confidently find — date, shift, lunch, breaks, temp/feels-like,
site count, weight, intake, and bulleted tasks (auto-MET-suggested the same way manual typing
is, with a leading `(HH:MM - HH:MM)` on a bullet read as that task's own start/end) — and leaves
everything else blank for manual entry, exactly as asked. The full original text is always kept
in the Notes field, and the app shows a summary of what was parsed vs. what still needs a human.
See the "What format does the import file need to be?" toggle on the entry form for the expected
layout, or `src/calendarImport.js`, which documents and implements it (covered by
`tests/calendarImport.test.mjs`, including a sanitized fixture built from real calendar data with
fake addresses).

**One file can hold many days.** Separate each day's block with a line containing only `---`;
every dated block is saved as its own entry directly — no per-day clicking through — and the app
lands on History so you can review what came in. A file with no `---` is treated as a single day
and merges onto whatever's currently open instead of creating a new entry.

**MET is read from the text, not typed.** `src/metGlossary.js` implements the MET glossary
(`MET_GLOSSARY.md`): soil tier for digs (including soil named in a day's NOTE line), tool and
material anchors, the heat rule (feels-like ≥ 88°F picks the upper end of a range, never adds
MET), wheelbarrow / pickaxe / machete / rush / incline deltas, dingo machine-vs-manual splitting,
and the 3.5–9.0 sanity clamp. Each phase records its reasoning and a confidence level. The
importer also reads relative times ("Beginning", "after lunch", "end shift"), "Arrived 1:45 … left
4:23" windows (AM/PM inferred from the shift), job-title bullets ("Patio job"), post-shift lunches,
and excludes non-labor blocks (wrong-item returns, lectures) from active time. A BPM-confirmed
revision written in a day's NOTE ("revised to MET 7.5", "Blended MET 7.12") overrides the
task-based estimate, and a MET typed by hand always wins. Covered by `tests/metGlossary.test.mjs`.

Two correctness details worth knowing about, both found and fixed against real data during
development:
- A bulleted `NOTE: ...` line is treated as commentary, not a task — it stays in Notes but isn't
  turned into a phantom zero-duration phase.
- When some tasks in a day have a clean `(HH:MM - HH:MM)` prefix and others don't, the untimed
  ones get the *average* duration of their timed siblings rather than being silently zeroed out
  by the proportional time-split (`allocatePhaseMinutes` in `src/engine.js`) — flagged in the
  day's data-quality notes either way.

PDF import works the same way but needs `pdfjs-dist` fetched from a CDN at runtime (there's no
pure-JS way to read PDF text otherwise) — `.md`/`.txt` have no such dependency and work fully
offline. If PDF import fails, save the file as `.md` or `.txt` instead.



```
index.html            shell
styles.css            single stylesheet, light + dark
server.py             stdlib static server
src/
  data.js             spec constants and tables (§2–§11)
  engine.js           pure calculation functions — no DOM, no storage
  store.js            localStorage persistence
  charts.js           hand-rolled SVG charts
  ui.js               formatting helpers
  app.js              tab routing
  views/              log, history, trends, tools (HRR), reference, settings
tests/engine.test.mjs
```

Every function in `engine.js` is pure and cites its spec section. To change a framework number,
edit `src/data.js` — nothing is hard-coded in the views.

## Limitations carried from the spec (§13)

- MET values are population averages. Single-day precision is roughly **±300–500 kcal** — shown
  under the TDEE figure on every day.
- BPM correction factors (+30/+35) come from a small number of manual pulse checks, not a
  validated device. HRR-derived MET is directional confirmation, not ground truth.
- NEAT and background are low-confidence estimates, visually distinguished from active kcal.
- Body composition is not tracked — the Scale MD Pro trunk/arm electrodes are non-functional.
  DEXA recommended as ground truth.

This is a calculation tool. It is not medical advice, it makes no diagnostic claims, and it
offers no weight-change recommendations.

## Backups

All data is in one browser's `localStorage` — clearing site data erases it. Settings → **Export
JSON backup** writes the full state (entries, weight log, settings); **Import** restores it.
History → **Export CSV** produces one row per day with every component broken out.
