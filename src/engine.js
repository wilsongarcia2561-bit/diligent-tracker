/**
 * Diligent IV — TDEE calculation engine.
 *
 * Pure functions only: no DOM, no storage. Everything here implements the spec
 * directly and is covered by tests/engine.test.mjs.
 *
 *   TDEE = BMR + Active Work Calories + Post-Work NEAT + TEF + Background Daily Life   (§1)
 *
 * Every component is additive and none double-counts another: BMR is MET 1.0 for
 * 24 hours, and every other component represents calories above that resting floor.
 */

import {
  BACKGROUND_TIERS,
  BMR_KCAL,
  DATASET_IV,
  DEFAULT_BREAK_MINUTES,
  HEAT_TRIGGER_F,
  HR_AGREEMENT_MET,
  HR_MIN_COVERAGE,
  KRI_RETIRED_ON,
  MAX_HR,
  NEAT_TIERS,
  NON_WORK_DAY,
  RESTING_HR,
  SOIL_CLASSES,
  SOIL_KEYWORDS,
  TASK_METS,
  TEF_BASELINE_INTAKE_KCAL,
  TEF_BASELINE_KCAL,
} from './data.js';
import { rawHrCheck } from './heartRate.js';

export const MODEL = {
  RAW: 'raw',
  INTERMEDIATE: 'intermediate',
  KRI: 'kri',
};

export const MODEL_LABELS = {
  [MODEL.RAW]: 'Kcal Raw',
  [MODEL.INTERMEDIATE]: 'Intermediate',
  [MODEL.KRI]: 'KRI (retired)',
};

export const MODEL_FORMULAS = {
  [MODEL.RAW]: 'MET × kg × hrs',
  [MODEL.INTERMEDIATE]: '(MET − 1.0) × kg × hrs',
  [MODEL.KRI]: '(MET − 0.5) × kg × hrs',
};

/* ------------------------------------------------------------------ *
 * Time helpers
 * ------------------------------------------------------------------ */

/** "HH:MM" → minutes past midnight. Returns null for blank/invalid input. */
export function parseTime(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Minutes between two "HH:MM" values, rolling past midnight if end <= start. */
export function durationMinutes(start, end) {
  const s = parseTime(start);
  const e = parseTime(end);
  if (s === null || e === null) return 0;
  return e <= s ? e + 1440 - s : e - s;
}

export function minutesToHours(minutes) {
  return (Number(minutes) || 0) / 60;
}

export function formatDuration(minutes) {
  const total = Math.round(Number(minutes) || 0);
  const sign = total < 0 ? '−' : '';
  const abs = Math.abs(total);
  return `${sign}${Math.floor(abs / 60)}h ${String(abs % 60).padStart(2, '0')}m`;
}

/* ------------------------------------------------------------------ *
 * §3 — Model selection and active kcal
 * ------------------------------------------------------------------ */

/** MET offset subtracted before multiplying by kg × hrs. */
export function modelOffset(model) {
  if (model === MODEL.RAW) return 0;
  if (model === MODEL.INTERMEDIATE) return 1.0;
  return 0.5; // KRI
}

/**
 * §3.1 — Intermediate is the only active model: applied at all intensities, on
 * all work days. KRI was retired on Sept 3, 2026 and every day is restated
 * under Intermediate; it survives here only to show the restatement impact
 * (≈ 0.5 × kg per active hour, ~29 kcal/hr at 57.6 kg).
 */
export const ACTIVE_MODEL = MODEL.INTERMEDIATE;

/**
 * Active work calories for one phase under one model.
 * Kcal Raw is comparison only and must never be added to BMR (§3.2).
 */
export function activeKcal({ met, model, kg, hours }) {
  const effectiveMet = Number(met) - modelOffset(model);
  if (!Number.isFinite(effectiveMet) || effectiveMet <= 0) return 0;
  const weight = Number(kg) || 0;
  const h = Number(hours) || 0;
  return effectiveMet * weight * h;
}

/* ------------------------------------------------------------------ *
 * §5 — MET auto-suggestion from task text
 * ------------------------------------------------------------------ */

/**
 * Cumulative match score: every matching keyword contributes its length, so an
 * entry that matches on several descriptors outranks one that matches on a single
 * long phrase. This is what separates HCP ("hard clay" + "pickaxe") from HC
 * ("hard clay" alone) when the description mentions both.
 */
function scoreKeywords(text, keywords) {
  const haystack = text.toLowerCase();
  let score = 0;
  for (const kw of new Set(keywords.map((k) => k.toLowerCase()))) {
    if (haystack.includes(kw)) score += kw.length;
  }
  return score;
}

/**
 * Feature §12.2 — suggest a MET from the task description by keyword matching
 * against the Section 5 tables. Always user-editable; returns null on no match.
 */
export function suggestMet(description = '', soilCode = '') {
  const text = String(description || '');
  let best = null;

  for (const task of TASK_METS) {
    const score = scoreKeywords(text, [task.label, ...task.keywords]);
    if (score > (best?.score ?? 0)) {
      best = {
        score,
        source: 'task',
        id: task.id,
        label: task.label,
        metMin: task.metMin,
        metMax: task.metMax,
      };
    }
  }

  for (const soil of SOIL_CLASSES) {
    const keywords = [soil.name, ...(SOIL_KEYWORDS[soil.code] || [])];
    const score = scoreKeywords(text, keywords);
    if (score > (best?.score ?? 0)) {
      best = {
        score,
        source: 'soil',
        id: soil.code,
        label: `${soil.code} — ${soil.name}`,
        metMin: soil.metMin,
        metMax: soil.metMax,
      };
    }
  }

  // An explicit soil classification beats a text guess when the text matched nothing.
  if (!best && soilCode) {
    const soil = SOIL_CLASSES.find((s) => s.code === soilCode);
    if (soil) {
      best = {
        score: 1,
        source: 'soil',
        id: soil.code,
        label: `${soil.code} — ${soil.name}`,
        metMin: soil.metMin,
        metMax: soil.metMax,
      };
    }
  }

  if (!best) return null;
  const mid = Math.round(((best.metMin + best.metMax) / 2) * 10) / 10;
  return { ...best, met: mid };
}

/* ------------------------------------------------------------------ *
 * §8 — Net work time
 * ------------------------------------------------------------------ */

/**
 * Net work time = (shift end − shift start) − lunch − documented breaks −
 * explicit non-work transit (supply runs, equipment drop-off, etc.).
 *
 * Breaks default to ~10 min per session (§8.3) when exact timestamps aren't logged.
 */
export function computeNetWorkMinutes(entry, breakMinutesDefault = DEFAULT_BREAK_MINUTES) {
  // A summary row (an imported TDEE dataset) already did this arithmetic:
  // its net work minutes are the answer, not something to rebuild from times.
  const known = entry.netWorkMinutesOverride;
  if (known !== '' && known !== null && known !== undefined && Number.isFinite(Number(known))) {
    const net = Number(known);
    return {
      grossMinutes: net, lunchMinutes: 0, lunchEmbeddedMinutes: 0, eatingMinutes: 0,
      breakMinutes: 0, breakEstimated: false, transitMinutes: 0, netWorkMinutes: net, fromSummary: true,
    };
  }
  const gross = durationMinutes(entry.shiftStart, entry.shiftEnd);

  let lunch = 0;
  if (entry.lunchStart && entry.lunchEnd) {
    lunch = durationMinutes(entry.lunchStart, entry.lunchEnd);
    // Only the part of lunch inside the shift comes off work time: an
    // afternoon shift that starts when lunch ends (12:22–1:16, shift 1:16 PM)
    // loses nothing to it.
    const s = parseTime(entry.shiftStart);
    const ls = parseTime(entry.lunchStart);
    if (s !== null && ls !== null && gross > 0) {
      const shiftEnd = s + gross;
      const lStart = ls < s && s - ls > 720 ? ls + 1440 : ls;
      const lEnd = lStart + lunch;
      lunch = Math.max(0, Math.min(shiftEnd, lEnd) - Math.max(s, lStart));
    }
  } else if (Number.isFinite(Number(entry.lunchMinutes))) {
    lunch = Number(entry.lunchMinutes) || 0;
  }

  // §8 — an "embedded task" inside the lunch block is not eating time. It is
  // subtracted from lunch here and re-entered as its own phase with its own MET.
  const lunchEmbedded = Number(entry.lunchEmbeddedMinutes) || 0;
  const eatingMinutes = Math.max(0, lunch - lunchEmbedded);

  const breakCount = Number(entry.breakCount) || 0;
  const breaks = Number.isFinite(Number(entry.breakMinutesActual)) && entry.breakMinutesActual !== ''
    ? Number(entry.breakMinutesActual)
    : breakCount * breakMinutesDefault;

  const transit = Number(entry.transitMinutes) || 0;

  return {
    grossMinutes: gross,
    lunchMinutes: lunch,
    lunchEmbeddedMinutes: lunchEmbedded,
    eatingMinutes,
    breakMinutes: breaks,
    breakEstimated: !(entry.breakMinutesActual !== '' && Number.isFinite(Number(entry.breakMinutesActual))),
    transitMinutes: transit,
    netWorkMinutes: gross - eatingMinutes - breaks - transit,
  };
}

/**
 * Distribute net work time across phases.
 *
 * §5 step 6 / §8: phases are split by task description and calendar timestamps;
 * breaks and lunch are allocated proportionally across sites by gross on-site time
 * unless exact timestamps pin them to a specific phase (netMinutesOverride).
 */
export function allocatePhaseMinutes(phases, netWorkMinutes) {
  const list = phases.map((p) => {
    const gross = Number.isFinite(Number(p.grossMinutes)) && p.grossMinutes !== ''
      ? Number(p.grossMinutes)
      : durationMinutes(p.start, p.end);
    const override = p.netMinutesOverride !== '' && Number.isFinite(Number(p.netMinutesOverride))
      ? Number(p.netMinutesOverride)
      : null;
    return { phase: p, grossMinutes: gross, override };
  });

  const overrideTotal = list.reduce((sum, p) => sum + (p.override ?? 0), 0);
  const flexible = list.filter((p) => p.override === null);
  const remaining = netWorkMinutes - overrideTotal;

  // When some flexible phases have a real timestamped duration and others
  // don't (e.g. one task logged as "8:24-11:09" and another with no times at
  // all), a phase with no timestamp still represents real work — giving it
  // literal zero weight in the proportional split below would erase it
  // entirely. It gets the average weight of its timed siblings instead, so
  // it reads as "an average-sized task" rather than nothing. When every
  // flexible phase is untimed (the common case), this reduces to the
  // original equal split unchanged.
  const timedFlexible = flexible.filter((p) => p.grossMinutes > 0);
  const averageTimedGross = timedFlexible.length
    ? timedFlexible.reduce((sum, p) => sum + p.grossMinutes, 0) / timedFlexible.length
    : 0;
  const weight = (p) => (p.grossMinutes > 0 ? p.grossMinutes : averageTimedGross);
  const flexibleWeightTotal = flexible.reduce((sum, p) => sum + weight(p), 0);

  return list.map((p) => {
    if (p.override !== null) {
      return { ...p, netMinutes: p.override, exact: true };
    }
    if (flexibleWeightTotal <= 0) {
      // No usable phase timestamps: split what's left evenly.
      return { ...p, netMinutes: flexible.length ? remaining / flexible.length : 0, exact: false };
    }
    return { ...p, netMinutes: (remaining * weight(p)) / flexibleWeightTotal, exact: false };
  });
}

/* ------------------------------------------------------------------ *
 * §2 — NEAT, TEF, background
 * ------------------------------------------------------------------ */

/** §2 — post-work NEAT scales with day intensity. */
export function suggestNeatTier({ netWorkMinutes = 0, feelsLikeF = null, maxMet = 0, restDay = false }) {
  if (restDay) return NEAT_TIERS[0];
  const hours = netWorkMinutes / 60;
  const hot = feelsLikeF !== null && feelsLikeF !== '' && Number(feelsLikeF) >= HEAT_TRIGGER_F;
  if (hours >= 8.5 || (hot && hours >= 6) || maxMet >= 8) return NEAT_TIERS[2];
  if (hours < 5) return NEAT_TIERS[0];
  return NEAT_TIERS[1];
}

/** Background daily life scales with commute load, not work intensity. */
export function suggestBackgroundTier({ siteCount = 1, outOfStateSupplyRun = false }) {
  if (outOfStateSupplyRun || Number(siteCount) >= 3) return BACKGROUND_TIERS[2];
  if (Number(siteCount) === 2) return BACKGROUND_TIERS[1];
  return BACKGROUND_TIERS[0];
}

/**
 * §2 — standard TEF is ~210 kcal (~10% of ~2,000 kcal). Adjust only when actual
 * intake is known to differ significantly (here: more than 15% off baseline).
 */
export function suggestTef(intakeKcal) {
  const intake = Number(intakeKcal);
  if (!Number.isFinite(intake) || intake <= 0) {
    return { kcal: TEF_BASELINE_KCAL, adjusted: false, reason: 'Standard baseline (~2,000 kcal intake)' };
  }
  const drift = Math.abs(intake - TEF_BASELINE_INTAKE_KCAL) / TEF_BASELINE_INTAKE_KCAL;
  if (drift <= 0.15) {
    return { kcal: TEF_BASELINE_KCAL, adjusted: false, reason: 'Logged intake is within 15% of baseline' };
  }
  return {
    kcal: Math.round(intake * 0.1),
    adjusted: true,
    reason: `Logged intake ${Math.round(intake)} kcal differs from the 2,000 kcal baseline by more than 15%`,
  };
}

/* ------------------------------------------------------------------ *
 * Main calculation
 * ------------------------------------------------------------------ */

/**
 * Normalize a stored phase into the shape the engine expects.
 */
function normalizePhase(phase) {
  return {
    id: phase.id,
    description: phase.description || '',
    site: phase.site || '',
    soilCode: phase.soilCode || '',
    met: Number(phase.met) || 0,
    start: phase.start || '',
    end: phase.end || '',
    grossMinutes: phase.grossMinutes ?? '',
    netMinutesOverride: phase.netMinutesOverride ?? '',
    modelOverride: phase.modelOverride || '',
    metRevisionNote: phase.metRevisionNote || '',
    metAuto: Boolean(phase.metAuto),
    metSource: phase.metSource || '',
    metConfidence: phase.metConfidence || '',
    metBasis: phase.metBasis || '',
    metNotes: Array.isArray(phase.metNotes) ? phase.metNotes : [],
  };
}

/**
 * Calculate a full day.
 *
 * @param {object} entry   stored day entry
 * @param {object} settings  { bmr, breakMinutesDefault, weightKg }
 * @returns {object} components, per-phase breakdown, model comparison, flags
 */
/** §7 — walking kcal for a non-work day, Intermediate model at MET 3.3. */
export function walkingKcal({ steps, kg, kcal = null }) {
  // A known figure (an imported summary row) wins; hours follow from it.
  if (kcal !== null && kcal !== '' && Number.isFinite(Number(kcal))) {
    const perHour = (NON_WORK_DAY.walkingMet - 1) * (Number(kg) || 0);
    return { hours: perHour ? Number(kcal) / perHour : 0, kcal: Number(kcal), given: true };
  }
  const count = Number(steps);
  const hours = (Number.isFinite(count) && count > 0 ? count : NON_WORK_DAY.defaultSteps) / NON_WORK_DAY.stepsPerHour;
  return { hours, kcal: activeKcal({ met: NON_WORK_DAY.walkingMet, model: MODEL.INTERMEDIATE, kg, hours }) };
}

/* ------------------------------------------------------------------ *
 * §5 — raw watch heart rate against the day's MET
 * ------------------------------------------------------------------ */

const clock = (m) => `${Math.floor(m / 60) % 24}:${String(m % 60).padStart(2, '0')}`;

/**
 * The minutes of the day that were work, for lining up watch readings.
 * Timed phases (each with a start and an end) give it exactly, with the gaps
 * between them left out; otherwise the shift does, minus lunch and any
 * documented non-work windows. Null when the day has neither.
 */
export function workWindow(entry) {
  const exclude = [];
  const pair = (a, b) => {
    const s = parseTime(a);
    let e = parseTime(b);
    if (s === null || e === null) return null;
    if (e <= s) e += 1440;
    return [s, e];
  };
  const lunch = pair(entry.lunchStart, entry.lunchEnd);
  if (lunch) exclude.push(lunch);
  for (const w of Array.isArray(entry.nonLaborWindows) ? entry.nonLaborWindows : []) {
    const p = pair(w && w.start, w && w.end);
    if (p) exclude.push(p);
  }
  const labor = (entry.phases || []).filter((p) => p.description || (p.met !== '' && p.met !== null && p.met !== undefined));
  const timed = labor.map((p) => pair(p.start, p.end));
  if (labor.length && timed.every(Boolean)) {
    const spans = timed.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i += 1) if (spans[i][0] > spans[i - 1][1]) exclude.push([spans[i - 1][1], spans[i][0]]);
    const start = spans[0][0];
    const end = Math.max(...spans.map((x) => x[1]));
    return { start, end, exclude, source: 'phases', label: `${clock(start)}–${clock(end)}` };
  }
  const shift = pair(entry.shiftStart, entry.shiftEnd);
  if (!shift) return null;
  return { start: shift[0], end: shift[1], exclude, source: 'shift', label: `${clock(shift[0])}–${clock(shift[1])}` };
}

/** The data-quality line for a day's heart-rate check. */
function heartRateFlag(hr, settings) {
  if (hr.status === 'no-window') {
    return { level: 'info', text: 'Watch heart rate is on file for this day, but there are no shift or phase times to line it up with work, so the MET can’t be checked against it. Add the shift start and end.' };
  }
  if (hr.status === 'no-readings') {
    return { level: 'info', text: `The watch has no heart-rate readings during this day’s work time (${hr.window.label}), so the MET can’t be checked.` };
  }
  const base = `Raw watch heart rate (no correction): ${Math.round(hr.minutes)} of ${Math.round(hr.span)} work min recorded, average ${hr.hr.toFixed(0)} bpm → HRR ${Math.round(hr.hrr * 100)}% (resting ${settings.restingHr}, max ${settings.maxHr}) → MET ${hr.met.toFixed(2)}`;
  if (hr.status === 'sparse') {
    return { level: 'info', text: `${base}. That covers only ${Math.round(hr.coverage * 100)}% of the work time — too little to check the MET against (needs ${Math.round(HR_MIN_COVERAGE * 100)}%).` };
  }
  if (hr.verdict === 'hr-only') {
    return { level: 'info', text: `${base}. No task MET to compare it with; reconstructed from heart rate alone, this day would be MET ${hr.suggested}.` };
  }
  if (hr.verdict === 'agree') {
    return { level: 'info', text: `${base}. Agrees with the day’s MET ${hr.dayMet.toFixed(2)} (within ${HR_AGREEMENT_MET}) — keep it (§5).` };
  }
  return {
    level: 'warn',
    text: `${base}, ${Math.abs(hr.diff).toFixed(2)} ${hr.verdict === 'down' ? 'below' : 'above'} the day’s MET ${hr.dayMet.toFixed(2)}. §5: revise ${hr.verdict} to ${hr.suggested} — “Use MET ${hr.suggested}” in the day’s heart-rate panel does it.`,
  };
}

/**
 * §5 — apply a heart-rate verdict: the day's phases move together so they
 * blend to the heart-rate MET (each keeps its difference from the others).
 * Returns the revised entry, or null when the check doesn't call for a change.
 */
export function reviseToHeartRate(entry, hr) {
  if (!hr || hr.status !== 'ok' || (hr.verdict !== 'up' && hr.verdict !== 'down')) return null;
  const delta = hr.suggested - hr.dayMet;
  const worked = (entry.phases || []).filter((p) => Number(p.met) > 0).length;
  const why = `raw watch heart rate (no correction): average ${hr.hr.toFixed(0)} bpm over ${Math.round(hr.minutes)} work min → HRR ${Math.round(hr.hrr * 100)}% → MET ${hr.met.toFixed(2)}`;
  const phases = entry.phases.map((p) => {
    const met = Number(p.met);
    if (!(met > 0)) return p;
    const next = Math.max(1.5, Math.round((met + delta) * 100) / 100);
    return {
      ...p,
      met: next,
      metAuto: false,
      metSource: 'hr-raw',
      metConfidence: 'high',
      metNotes: [],
      metBasis: `Revised ${hr.verdict} ${met} → ${next} on ${why}${worked > 1 ? `; every phase moved ${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(2)} so the day blends to ${hr.suggested}` : ''} (§5).`,
      metRevisionNote: `${met} → ${next} on raw heart rate`,
    };
  });
  return { ...entry, phases };
}

/** §6 — the document-of-record figure for a date, if DILIGENT IV lists one. */
export function datasetFigure(date) {
  return DATASET_IV.find((d) => d.date === date) || null;
}

export function calculateDay(entry, settings = {}) {
  const bmr = Number(settings.bmr ?? BMR_KCAL);
  const restingHr = Number(settings.restingHr) || RESTING_HR;
  const maxHr = Number(settings.maxHr) || MAX_HR;
  const breakMinutesDefault = Number(settings.breakMinutesDefault ?? DEFAULT_BREAK_MINUTES);
  const kg = Number(entry.weightKg || settings.weightKg || 0);
  const feelsLikeF = entry.feelsLikeF === '' || entry.feelsLikeF === undefined || entry.feelsLikeF === null
    ? null
    : Number(entry.feelsLikeF);
  const restDay = Boolean(entry.restDay);

  const timing = computeNetWorkMinutes(entry, breakMinutesDefault);
  const netWorkMinutes = restDay ? 0 : Math.max(0, timing.netWorkMinutes);

  const rawPhases = (entry.phases || []).map(normalizePhase);
  const allocated = restDay || rawPhases.length === 0
    ? []
    : allocatePhaseMinutes(rawPhases, netWorkMinutes);

  const flags = [];
  const phases = allocated.map(({ phase, grossMinutes, netMinutes, exact }) => {
    const hours = minutesToHours(netMinutes);
    const model = ACTIVE_MODEL;

    const byModel = {
      [MODEL.RAW]: activeKcal({ met: phase.met, model: MODEL.RAW, kg, hours }),
      [MODEL.INTERMEDIATE]: activeKcal({ met: phase.met, model: MODEL.INTERMEDIATE, kg, hours }),
      [MODEL.KRI]: activeKcal({ met: phase.met, model: MODEL.KRI, kg, hours }),
    };

    return {
      ...phase,
      grossMinutes,
      netMinutes,
      hours,
      exactNet: exact,
      model,
      restatedFromKri: phase.modelOverride === MODEL.KRI,
      kcal: byModel[model],
      byModel,
    };
  });

  // §7 — a non-work day's only activity line is walking.
  const walking = restDay ? walkingKcal({ steps: entry.steps, kg, kcal: entry.walkingKcal ?? null }) : null;
  const activeTotal = walking ? walking.kcal : phases.reduce((sum, p) => sum + p.kcal, 0);

  const workedPhases = phases.filter((p) => p.met > 0 && p.netMinutes > 0);
  const workedMinutes = workedPhases.reduce((s, p) => s + p.netMinutes, 0);
  const blendedMet = workedMinutes ? workedPhases.reduce((s, p) => s + p.met * p.netMinutes, 0) / workedMinutes : null;
  const maxMet = phases.reduce((max, p) => Math.max(max, Number(p.met) || 0), 0);

  // NEAT (§9)
  const neatSuggestion = suggestNeatTier({ netWorkMinutes, feelsLikeF, maxMet, restDay });
  const neatTier = entry.neatTier || neatSuggestion.id;
  const neatDefault = (NEAT_TIERS.find((t) => t.id === neatTier) || neatSuggestion).default;
  const neat = Number.isFinite(Number(entry.neatKcal)) && entry.neatKcal !== '' && entry.neatKcal !== null
    ? Number(entry.neatKcal)
    : restDay ? NON_WORK_DAY.neatKcal : neatDefault;

  // Background (§11)
  const siteCount = Number(entry.siteCount) || (new Set(phases.map((p) => p.site).filter(Boolean)).size || 1);
  const bgSuggestion = suggestBackgroundTier({
    siteCount,
    outOfStateSupplyRun: Boolean(entry.outOfStateSupplyRun),
  });
  const bgTier = entry.backgroundTier || bgSuggestion.id;
  const bgDefault = (BACKGROUND_TIERS.find((t) => t.id === bgTier) || bgSuggestion).kcal;
  // §7 — no separate background bucket on a non-work day; it folds into NEAT.
  const background = Number.isFinite(Number(entry.backgroundKcal)) && entry.backgroundKcal !== '' && entry.backgroundKcal !== null
    ? Number(entry.backgroundKcal)
    : restDay ? 0 : bgDefault;

  // TEF (§10)
  const tefSuggestion = suggestTef(entry.intakeKcal);
  if (restDay && !tefSuggestion.adjusted) {
    tefSuggestion.kcal = NON_WORK_DAY.tefKcal;
    tefSuggestion.reason = 'Non-work day baseline (~190–210 kcal)';
  }
  const tef = Number.isFinite(Number(entry.tefKcal)) && entry.tefKcal !== '' && entry.tefKcal !== null
    ? Number(entry.tefKcal)
    : tefSuggestion.kcal;

  const components = {
    bmr,
    active: activeTotal,
    neat,
    tef,
    background,
  };
  const tdee = components.bmr + components.active + components.neat + components.tef + components.background;

  // §12.11 — model comparison across the whole day.
  const comparison = {
    [MODEL.RAW]: phases.reduce((s, p) => s + p.byModel[MODEL.RAW], 0),
    [MODEL.INTERMEDIATE]: phases.reduce((s, p) => s + p.byModel[MODEL.INTERMEDIATE], 0),
    [MODEL.KRI]: phases.reduce((s, p) => s + p.byModel[MODEL.KRI], 0),
    used: activeTotal,
  };

  /* ---------------- data-quality flags (§12.12) ---------------- */

  if (!restDay && kg <= 0) {
    flags.push({ level: 'error', text: 'No bodyweight set — active calories cannot be calculated.' });
  }
  if (entry.unusable) {
    flags.push({ level: 'error', text: 'Marked unusable in the imported data, so it is left out of Trends and every average. Add a task description (and its time) to bring it back.' });
  } else if (!restDay && rawPhases.length === 0) {
    const shifted = Boolean(entry.shiftStart && entry.shiftEnd);
    flags.push(shifted
      ? { level: 'error', text: 'Shift logged with no task description — the Aug 28 / Sept 4 failure. Active work is zero, so this day is unusable as it stands. Describe resistance and continuity, not just the verb.' }
      : { level: 'warn', text: 'No task phases logged, so active work calories are zero for this day.' });
  }
  if (restDay && walking.given) {
    flags.push({
      level: 'info',
      text: `Non-work day (§7): walking ${Math.round(walking.kcal)} kcal as given by the imported data (≈ ${walking.hours.toFixed(1)} hr at MET ${NON_WORK_DAY.walkingMet}), no background bucket. Clear it and log a step count to compute it instead.`,
    });
  } else if (restDay) {
    flags.push({
      level: 'info',
      text: `Non-work day (§7): walking ${Number(entry.steps) > 0 ? `${Number(entry.steps).toLocaleString()} steps` : `assumed ${NON_WORK_DAY.defaultSteps.toLocaleString()} steps (log the day's step count to tighten this)`} ≈ ${walking.hours.toFixed(1)} hr at MET ${NON_WORK_DAY.walkingMet}, no background bucket. The ~${NON_WORK_DAY.expectedTotal.toLocaleString()} kcal estimate is still unvalidated.`,
    });
  }
  for (const f of Array.isArray(entry.importFlags) ? entry.importFlags : []) flags.push(f);
  if (!restDay && timing.netWorkMinutes < 0) {
    flags.push({
      level: 'error',
      text: `Deductions (lunch + breaks + transit) exceed the shift length. Net work time computed as ${formatDuration(timing.netWorkMinutes)}.`,
    });
  }
  if (!restDay && timing.breakEstimated && Number(entry.breakCount) > 0) {
    flags.push({
      level: 'info',
      text: `Break time assumed at ~${breakMinutesDefault} min × ${entry.breakCount} break(s) = ${timing.breakMinutes} min${timing.grossMinutes ? ` (${Math.round((timing.breakMinutes / timing.grossMinutes) * 100)}% of the shift)` : ''}. Start/end break timestamps are still the highest-value logging fix.`,
    });
  }
  if (!restDay && phases.length > 0) {
    const phaseGross = allocated.reduce((s, p) => s + p.grossMinutes, 0);
    // Phase windows may either span the whole shift or bracket the lunch gap out.
    // Only flag a total that is far from both readings.
    const expected = [timing.grossMinutes, timing.grossMinutes - timing.eatingMinutes];
    const drift = Math.min(...expected.map((e) => Math.abs(phaseGross - e)));
    if (phaseGross > 0 && timing.grossMinutes > 0 && drift > 20) {
      flags.push({
        level: 'warn',
        text: `Phase windows total ${formatDuration(phaseGross)} but the shift spans ${formatDuration(timing.grossMinutes)}. Net time was scaled proportionally — check the phase timestamps.`,
      });
    }
  }
  if (!restDay && entry.heatInferred && feelsLikeF === null) {
    flags.push({
      level: 'warn',
      text: 'Heat ≥88°F inferred, not documented — upper-range MET confirmations for this day are inferential.',
    });
  }
  if (!restDay && feelsLikeF === null && !entry.heatInferred && phases.length > 0) {
    flags.push({
      level: 'info',
      text: 'No feels-like temperature logged, so heat could not confirm upper-range MET assignments for this day.',
    });
  }
  for (const p of phases) {
    if (p.restatedFromKri) {
      flags.push({
        level: 'info',
        text: `"${p.description || 'Untitled phase'}" was forced to KRI before its retirement on ${KRI_RETIRED_ON}; restated under Intermediate (${Math.round(p.byModel[MODEL.KRI] - p.kcal)} kcal lower). Don't average against pre-restatement figures.`,
      });
    }
    // Notes from the MET glossary (risky phrasing, unmatched terms, defaults)
    // travel with an auto-assigned MET until someone enters one by hand.
    if (p.metAuto) for (const n of p.metNotes) flags.push({ level: n.level === 'warn' ? 'warn' : 'info', text: n.text });
    if (!p.exactNet && p.grossMinutes === 0 && phases.some((sib) => sib.grossMinutes > 0)) {
      flags.push({
        level: 'info',
        text: `"${p.description || 'Untitled phase'}" has no start/end time — given an average-sized share of net work time from its timed sibling phases. Add exact start/end or exact net minutes for a tighter split.`,
      });
    }
  }

  // §5 — the day's MET against its raw watch heart rate, when there is any.
  let heartRate = null;
  if (!restDay && Array.isArray(entry.watchHr) && entry.watchHr.length) {
    const window = workWindow(entry);
    heartRate = window
      ? { ...rawHrCheck(entry.watchHr, window, { dayMet: blendedMet, restingHr, maxHr, agreement: HR_AGREEMENT_MET, minCoverage: HR_MIN_COVERAGE }), window }
      : { status: 'no-window' };
    flags.push(heartRateFlag(heartRate, { restingHr, maxHr }));
  }

  // §6 — reconcile against the document of record, never assume they're in sync.
  const doc = datasetFigure(entry.date);
  if (doc) {
    if (doc.tdee === null) {
      flags.push({ level: 'warn', text: `DILIGENT IV §6 marks this day unusable: ${doc.note || doc.task}` });
    } else {
      const delta = tdee - doc.tdee;
      const off = Math.abs(delta) > 300;
      // §6 figures were checked against corrected heart rate (+30/+35), which
      // is retired: a day revised on raw heart rate is expected to land lower.
      const lowerOnRawHr = off && delta < 0 && blendedMet !== null && blendedMet < doc.met;
      flags.push({
        level: off && !lowerOnRawHr ? 'warn' : 'info',
        text: `DILIGENT IV §6 records ~${doc.tdee.toLocaleString()} kcal (MET ${doc.met}, ${doc.hours} active hr) for this day; the app computes ${Math.round(tdee).toLocaleString()} (${delta >= 0 ? '+' : '−'}${Math.abs(Math.round(delta)).toLocaleString()}).${lowerOnRawHr ? ' The §6 figure was checked against corrected heart rate (+30/+35), which is no longer used — a lower MET on raw heart rate explains the gap.' : off ? ' Outside the ±300 kcal precision floor — re-verify the stored day.' : ''}${doc.note ? ` ${doc.note}` : ''}`,
      });
    }
  }

  return {
    date: entry.date,
    restDay,
    walking,
    blendedMet,
    unusable: Boolean(entry.unusable),
    dataset: doc,
    heartRate,
    weightKg: kg,
    feelsLikeF,
    timing: { ...timing, netWorkMinutes },
    phases,
    components,
    tdee,
    comparison,
    siteCount,
    neat: { tier: neatTier, suggestion: neatSuggestion, kcal: neat, custom: entry.neatKcal !== '' && entry.neatKcal !== null && entry.neatKcal !== undefined },
    background: { tier: bgTier, suggestion: bgSuggestion, kcal: background, custom: entry.backgroundKcal !== '' && entry.backgroundKcal !== null && entry.backgroundKcal !== undefined },
    tef: { kcal: tef, suggestion: tefSuggestion },
    intakeKcal: Number(entry.intakeKcal) || null,
    balance: Number(entry.intakeKcal) ? Number(entry.intakeKcal) - tdee : null,
    flags,
  };
}

/* ------------------------------------------------------------------ *
 * Trends (§12.6)
 * ------------------------------------------------------------------ */

export function rollingAverage(points, window = 7) {
  return points.map((point, i) => {
    const slice = points.slice(Math.max(0, i - window + 1), i + 1);
    const sum = slice.reduce((s, p) => s + p.value, 0);
    return { ...point, value: sum / slice.length, samples: slice.length };
  });
}

export function summarizeTrends(results) {
  const sorted = [...results].sort((a, b) => a.date.localeCompare(b.date));
  const work = sorted.filter((r) => !r.restDay);
  const rest = sorted.filter((r) => r.restDay);
  const mean = (arr) => (arr.length ? arr.reduce((s, r) => s + r.tdee, 0) / arr.length : null);
  const series = sorted.map((r) => ({ date: r.date, value: r.tdee, restDay: r.restDay }));
  return {
    series,
    rolling7: rollingAverage(series, 7),
    workDayAverage: mean(work),
    restDayAverage: mean(rest),
    overallAverage: mean(sorted),
    workDayCount: work.length,
    restDayCount: rest.length,
    activeAverage: work.length ? work.reduce((s, r) => s + r.components.active, 0) / work.length : null,
  };
}

export const ENGINE_CONSTANTS = {
  BMR_KCAL,
  TEF_BASELINE_KCAL,
  DEFAULT_BREAK_MINUTES,
  HEAT_TRIGGER_F,
  KRI_RETIRED_ON,
};
