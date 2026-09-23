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
  BPM_CORRECTIONS,
  CAPTURE_CATEGORIES,
  DATASET_IV,
  DEFAULT_BREAK_MINUTES,
  HEAT_TRIGGER_F,
  HRR_MET_TABLE,
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
import { clockMinutes, windowStats } from './heartRate.js';

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
        capture: task.capture,
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
        capture: soil.code === 'SRW' ? 'staticForce' : 'digging',
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
        capture: soil.code === 'SRW' ? 'staticForce' : 'digging',
      };
    }
  }

  if (!best) return null;
  const mid = Math.round(((best.metMin + best.metMax) / 2) * 10) / 10;
  return { ...best, met: mid };
}

/* ------------------------------------------------------------------ *
 * §6 — BPM correction, HRR and implied MET
 * ------------------------------------------------------------------ */

/** Correction factor to add to a Samsung watch reading, by intensity band. */
export function bpmCorrection(watchBpm) {
  const bpm = Number(watchBpm);
  if (!Number.isFinite(bpm)) return null;
  const band = BPM_CORRECTIONS.find((b) => bpm >= b.watchMin && bpm <= b.watchMax);
  if (!band) {
    return {
      band: null,
      add: 0,
      addMax: 0,
      note: `Watch reading ${bpm} falls outside the documented correction bands (${BPM_CORRECTIONS[0].watchMin}–${BPM_CORRECTIONS[BPM_CORRECTIONS.length - 1].watchMax}). No correction applied.`,
    };
  }
  return {
    band: band.id,
    label: band.label,
    add: band.add,
    addMax: band.addMax,
    note:
      band.add === band.addMax
        ? `${band.label}: +${band.add} BPM`
        : `${band.label}: +${band.add} to +${band.addMax} BPM`,
  };
}

/** HRR% = (corrected BPM − 49) / (201 − 49). */
export function hrrPercent(correctedBpm, resting = RESTING_HR, max = MAX_HR) {
  const bpm = Number(correctedBpm);
  if (!Number.isFinite(bpm)) return null;
  return (bpm - resting) / (max - resting);
}

/** HRR% → approximate MET band from the Section 6 reference table. */
export function metFromHrr(hrr) {
  if (!Number.isFinite(hrr)) return null;
  for (const row of HRR_MET_TABLE) {
    if (hrr >= row.hrrMin && hrr < row.hrrMax) return { ...row };
  }
  if (hrr >= 0.95) return { ...HRR_MET_TABLE[HRR_MET_TABLE.length - 1], aboveTable: true };
  return null;
}

/**
 * Full validation chain for one BPM observation (feature §12.8):
 * watch reading → correction → HRR% → implied MET → comparison against the task MET.
 *
 * §5 step 3: BPM agrees → keep. BPM disagrees → revise and state the revision.
 * Revision runs both directions; a downward revision is recorded with the same
 * prominence as an upward one.
 */
export function validateWithBpm({ watchBpm, taskMet = null, resting = RESTING_HR, max = MAX_HR }) {
  const correction = bpmCorrection(watchBpm);
  if (!correction) return null;
  const corrected = Number(watchBpm) + correction.add;
  const correctedMax = Number(watchBpm) + correction.addMax;
  const hrr = hrrPercent(corrected, resting, max);
  const hrrMax = hrrPercent(correctedMax, resting, max);
  const implied = metFromHrr(hrr);
  const impliedMax = metFromHrr(hrrMax);

  let verdict = 'no-reference';
  let message = 'No MET band matched — HRR% is below the reference table floor (35%).';
  if (implied) {
    if (taskMet === null || taskMet === '' || !Number.isFinite(Number(taskMet))) {
      verdict = 'no-task-met';
      message = `Implied MET ${implied.metMin}–${implied.metMax}. Enter a task MET to cross-check.`;
    } else {
      const met = Number(taskMet);
      const ceiling = impliedMax ? impliedMax.metMax : implied.metMax;
      if (met >= implied.metMin && met <= ceiling) {
        verdict = 'validates';
        message = `BPM validates the task MET — use task MET ${met}.`;
      } else if (implied.metMin > met) {
        verdict = 'revise-up';
        message = `BPM suggests higher (${implied.metMin}–${implied.metMax}). Revise task MET upward from ${met} and note the revision.`;
      } else {
        verdict = 'revise-down';
        message = `BPM suggests lower (${implied.metMin}–${implied.metMax}). Revise task MET downward from ${met} and note the revision — a cross-check that can only raise values isn't a cross-check.`;
      }
    }
  }

  return {
    watchBpm: Number(watchBpm),
    correction,
    correctedBpm: corrected,
    correctedBpmMax: correctedMax,
    hrr,
    hrrMax,
    implied,
    impliedMax,
    verdict,
    message,
  };
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
 * §7 / §12.12 — data-quality flags
 * ------------------------------------------------------------------ */

export function captureRateCheck({ samsungActiveMinutes, netWorkMinutes, captureCategory }) {
  const active = Number(samsungActiveMinutes);
  if (!Number.isFinite(active) || active <= 0 || netWorkMinutes <= 0) return null;
  const rate = active / netWorkMinutes;
  const band = CAPTURE_CATEGORIES[captureCategory] || null;
  if (!band) return { rate, band: null, status: 'unknown' };
  // "Far outside" — allow a 10 percentage-point cushion before flagging.
  const status = rate < band.min - 0.1 ? 'low' : rate > band.max + 0.1 ? 'high' : 'expected';
  return { rate, band, status, categoryLabel: band.label };
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
    captureCategory: phase.captureCategory || '',
    watchBpm: phase.watchBpm ?? '',
    samsungActiveMinutes: phase.samsungActiveMinutes ?? '',
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
 * @param {object} settings  { bmr, breakMinutesDefault, restingHr, maxHr, weightKg }
 * @returns {object} components, per-phase breakdown, model comparison, flags
 */
/** §7 — walking kcal for a non-work day, Intermediate model at MET 3.3. */
export function walkingKcal({ steps, kg }) {
  const count = Number(steps);
  const hours = (Number.isFinite(count) && count > 0 ? count : NON_WORK_DAY.defaultSteps) / NON_WORK_DAY.stepsPerHour;
  return { hours, kcal: activeKcal({ met: NON_WORK_DAY.walkingMet, model: MODEL.INTERMEDIATE, kg, hours }) };
}

/** Midpoint of an HRR-implied MET band, rounded to the half-MET steps the dataset uses. */
export function hrSuggestedMet(check) {
  if (!check || !check.implied) return null;
  const hi = check.impliedMax ? check.impliedMax.metMax : check.implied.metMax;
  return Math.round(((check.implied.metMin + hi) / 2) * 2) / 2;
}

/**
 * §4/§5 — cross-check against an imported heart-rate export. The day check
 * compares the work window (shift minus lunch) against the minute-blended
 * MET; each phase with a start/end is checked against its own window.
 */
function heartRateCheck(entry, phases, blendedMet, restingHr, maxHr) {
  const readings = Array.isArray(entry.hrSamples) ? entry.hrSamples : [];
  if (!readings.length) return null;
  const start = clockMinutes(entry.shiftStart);
  let end = clockMinutes(entry.shiftEnd);
  if (start !== null && end !== null && end <= start) end += 1440;
  const lunch = [[clockMinutes(entry.lunchStart), clockMinutes(entry.lunchEnd)]];
  const verify = (stats, met) => {
    if (!stats || stats.n < 3) return null;
    const check = validateWithBpm({ watchBpm: stats.median, taskMet: met || null, resting: restingHr, max: maxHr });
    return check && { ...check, stats, suggestedMet: hrSuggestedMet(check) };
  };
  const dayStats = windowStats(readings, start, end, lunch);
  const byPhase = {};
  for (const p of phases) {
    const s = clockMinutes(p.start);
    let e = clockMinutes(p.end);
    if (s === null || e === null) continue;
    if (e <= s) e += 1440;
    const check = verify(windowStats(readings, s, e, lunch), p.met);
    if (check) byPhase[p.id] = check;
  }
  return { readings: readings.length, dayStats, day: verify(dayStats, blendedMet), byPhase };
}

/** §6 — the document-of-record figure for a date, if DILIGENT IV lists one. */
export function datasetFigure(date) {
  return DATASET_IV.find((d) => d.date === date) || null;
}

export function calculateDay(entry, settings = {}) {
  const bmr = Number(settings.bmr ?? BMR_KCAL);
  const breakMinutesDefault = Number(settings.breakMinutesDefault ?? DEFAULT_BREAK_MINUTES);
  const restingHr = Number(settings.restingHr ?? RESTING_HR);
  const maxHr = Number(settings.maxHr ?? MAX_HR);
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

    const bpm = phase.watchBpm === '' || phase.watchBpm === null
      ? null
      : validateWithBpm({ watchBpm: phase.watchBpm, taskMet: phase.met, resting: restingHr, max: maxHr });

    const capture = captureRateCheck({
      samsungActiveMinutes: phase.samsungActiveMinutes,
      netWorkMinutes: netMinutes,
      captureCategory: phase.captureCategory,
    });

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
      bpm,
      capture,
    };
  });

  // §7 — a non-work day's only activity line is walking.
  const walking = restDay ? walkingKcal({ steps: entry.steps, kg }) : null;
  const activeTotal = walking ? walking.kcal : phases.reduce((sum, p) => sum + p.kcal, 0);

  const workedPhases = phases.filter((p) => p.met > 0 && p.netMinutes > 0);
  const workedMinutes = workedPhases.reduce((s, p) => s + p.netMinutes, 0);
  const blendedMet = workedMinutes ? workedPhases.reduce((s, p) => s + p.met * p.netMinutes, 0) / workedMinutes : null;
  const hr = restDay ? null : heartRateCheck(entry, phases, blendedMet, restingHr, maxHr);
  if (hr) {
    // A hand-typed watch BPM stays the phase's cross-check; otherwise the export's.
    for (const p of phases) if (!p.bpm && hr.byPhase[p.id]) p.bpm = { ...hr.byPhase[p.id], fromExport: true };
  }
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
  if (!restDay && rawPhases.length === 0) {
    const shifted = Boolean(entry.shiftStart && entry.shiftEnd);
    flags.push(shifted
      ? { level: 'error', text: 'Shift logged with no task description — the Aug 28 / Sept 4 failure. Active work is zero; without HR to reconstruct it, this day is unusable. Describe resistance and continuity, not just the verb.' }
      : { level: 'warn', text: 'No task phases logged, so active work calories are zero for this day.' });
  }
  if (restDay) {
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
      text: 'Heat ≥88°F inferred, not documented — upper-range MET confirmations for this day are inferential. Cross-check against BPM data where available.',
    });
  }
  if (!restDay && feelsLikeF === null && !entry.heatInferred && phases.length > 0) {
    flags.push({
      level: 'info',
      text: 'No feels-like temperature logged, so heat could not confirm upper-range MET assignments for this day.',
    });
  }
  if (!restDay && phases.length > 0 && !hr && phases.every((p) => p.watchBpm === '' || p.watchBpm === null)) {
    flags.push({ level: 'info', text: 'No BPM data logged — MET assignments are unvalidated for this day.' });
  }
  for (const p of phases) {
    if (p.capture && p.capture.status === 'low') {
      flags.push({
        level: 'warn',
        text: `"${p.description || 'Untitled phase'}": Samsung capture rate ${(p.capture.rate * 100).toFixed(0)}% is below the expected ${(p.capture.band.min * 100).toFixed(0)}–${(p.capture.band.max * 100).toFixed(0)}% for ${p.capture.categoryLabel}. Data-quality note only — calendar net work time stands.`,
      });
    }
    if (p.capture && p.capture.status === 'high') {
      flags.push({
        level: 'warn',
        text: `"${p.description || 'Untitled phase'}": Samsung capture rate ${(p.capture.rate * 100).toFixed(0)}% is above the expected ${(p.capture.band.min * 100).toFixed(0)}–${(p.capture.band.max * 100).toFixed(0)}% for ${p.capture.categoryLabel}. Data-quality note only — calendar net work time stands.`,
      });
    }
    if (p.bpm && (p.bpm.verdict === 'revise-up' || p.bpm.verdict === 'revise-down')) {
      flags.push({
        level: 'warn',
        text: p.bpm.fromExport
          ? `"${p.description || 'Untitled phase'}" (${p.start}–${p.end}): heart-rate export median ${p.bpm.stats.median} bpm over ${p.bpm.stats.n} readings → ${p.bpm.message}`
          : `"${p.description || 'Untitled phase'}": ${p.bpm.message}`,
      });
    }
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

  // §4/§5 — the day's work window against the minute-blended MET.
  if (hr) {
    const d = hr.day;
    const s = hr.dayStats;
    if (!s || s.n === 0) {
      flags.push({ level: 'info', text: `The heart-rate export has ${hr.readings} readings for this date, but none inside the shift window — check the shift times.` });
    } else if (!d) {
      flags.push({ level: 'info', text: `Only ${s.n} heart-rate reading${s.n === 1 ? '' : 's'} inside the shift window — too few to cross-check MET.` });
    } else {
      const chain = `median ${s.median} bpm over ${s.n} readings → corrected ${d.correctedBpm}${d.correctedBpmMax !== d.correctedBpm ? `–${d.correctedBpmMax}` : ''} → HRR ${Math.round(d.hrr * 100)}%`;
      const band = d.implied ? ` → MET ${d.implied.metMin}–${(d.impliedMax || d.implied).metMax}` : '';
      if (d.verdict === 'no-reference') {
        flags.push({ level: 'warn', text: `Heart rate stayed near resting across the shift (${chain}, below the 35% table floor). Check the shift times, or whether the watch was worn.` });
      } else if (d.verdict === 'validates') {
        flags.push({ level: 'info', text: `Heart-rate export confirms the day: ${chain}${band}, and the blended MET is ${blendedMet.toFixed(2)}.` });
      } else if (d.verdict === 'revise-up' || d.verdict === 'revise-down') {
        flags.push({ level: 'warn', text: `Heart-rate export disagrees (${d.verdict === 'revise-up' ? 'higher' : 'lower'}): ${chain}${band}, but the blended MET is ${blendedMet.toFixed(2)}. Revise ${d.verdict === 'revise-up' ? 'up' : 'down'} toward ~${d.suggestedMet} and state the revision.` });
      }
    }
  }

  // §6 — reconcile against the document of record, never assume they're in sync.
  const doc = datasetFigure(entry.date);
  if (doc) {
    if (doc.tdee === null) {
      flags.push({ level: 'warn', text: `DILIGENT IV §6 marks this day unusable: ${doc.note || doc.task}` });
    } else {
      const delta = tdee - doc.tdee;
      const off = Math.abs(delta) > 300;
      flags.push({
        level: off ? 'warn' : 'info',
        text: `DILIGENT IV §6 records ~${doc.tdee.toLocaleString()} kcal (MET ${doc.met}, ${doc.hours} active hr) for this day; the app computes ${Math.round(tdee).toLocaleString()} (${delta >= 0 ? '+' : '−'}${Math.abs(Math.round(delta)).toLocaleString()}).${off ? ' Outside the ±300 kcal precision floor — re-verify the stored day.' : ''}${doc.note ? ` ${doc.note}` : ''}`,
      });
    }
  }

  return {
    date: entry.date,
    restDay,
    walking,
    blendedMet,
    hr,
    dataset: doc,
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
  RESTING_HR,
  MAX_HR,
};
