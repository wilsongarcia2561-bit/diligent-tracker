/**
 * Persistence layer — localStorage only. No network, no accounts.
 * Everything the app knows lives under a single versioned key.
 */

import {
  BMR_KCAL,
  DEFAULT_BREAK_MINUTES,
  DEFAULT_WEIGHT_KG,
  MAX_HR,
  RESTING_HR,
  SEED_WEIGHT_LOG,
} from './data.js';

const KEY = 'diligent3.v1';

export const DEFAULT_SETTINGS = {
  bmr: BMR_KCAL,
  breakMinutesDefault: DEFAULT_BREAK_MINUTES,
  restingHr: RESTING_HR,
  maxHr: MAX_HR,
  weightKg: DEFAULT_WEIGHT_KG,
};

function emptyState() {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    entries: {},
    weightLog: SEED_WEIGHT_LOG.map((w) => ({ ...w })),
  };
}

let state = emptyState();
const listeners = new Set();

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state = {
        ...emptyState(),
        ...parsed,
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
        entries: parsed.entries || {},
        weightLog: parsed.weightLog || [],
      };
    }
  } catch (err) {
    console.error('Could not read saved data; starting fresh.', err);
    state = emptyState();
  }
  return state;
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    console.error('Could not save data.', err);
  }
  listeners.forEach((fn) => fn(state));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getState() {
  return state;
}

export function getSettings() {
  return state.settings;
}

export function updateSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  persist();
}

/* ------------------------------- entries ------------------------------- */

export function newPhase(overrides = {}) {
  return {
    id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    description: '',
    site: '',
    soilCode: '',
    met: '',
    start: '',
    end: '',
    netMinutesOverride: '',
    modelOverride: '',
    vigorous: false,
    captureCategory: '',
    watchBpm: '',
    samsungActiveMinutes: '',
    metRevisionNote: '',
    ...overrides,
  };
}

export function newEntry(date) {
  return {
    date,
    restDay: false,
    shiftStart: '',
    shiftEnd: '',
    lunchStart: '',
    lunchEnd: '',
    lunchMinutes: '',
    lunchEmbeddedMinutes: '',
    breakCount: '',
    breakMinutesActual: '',
    transitMinutes: '',
    tempF: '',
    feelsLikeF: '',
    heatInferred: false,
    siteCount: '',
    outOfStateSupplyRun: false,
    weightKg: '',
    neatTier: '',
    neatKcal: '',
    backgroundTier: '',
    backgroundKcal: '',
    tefKcal: '',
    intakeKcal: '',
    notes: '',
    phases: [newPhase()],
    updatedAt: null,
  };
}

export function getEntry(date) {
  return state.entries[date] || null;
}

export function listEntries() {
  return Object.values(state.entries).sort((a, b) => b.date.localeCompare(a.date));
}

export function saveEntry(entry) {
  state.entries[entry.date] = { ...entry, updatedAt: new Date().toISOString() };
  // §4 — a per-entry fasted-morning weight also updates the weight log.
  if (entry.weightKg !== '' && entry.weightKg !== null && Number(entry.weightKg) > 0) {
    upsertWeight({ date: entry.date, kg: Number(entry.weightKg), note: 'From daily entry' }, { silent: true });
  }
  persist();
  return state.entries[entry.date];
}

export function deleteEntry(date) {
  delete state.entries[date];
  persist();
}

/* ------------------------------ weight log ----------------------------- */

export function listWeights() {
  return [...state.weightLog].sort((a, b) => a.date.localeCompare(b.date));
}

export function upsertWeight(record, { silent = false } = {}) {
  const existing = state.weightLog.findIndex((w) => w.date === record.date);
  if (existing >= 0) {
    state.weightLog[existing] = { ...state.weightLog[existing], ...record };
  } else {
    state.weightLog.push({ ...record });
  }
  // The bodyweight constant tracks the most recent reading (§4).
  const latest = listWeights().at(-1);
  if (latest) state.settings.weightKg = latest.kg;
  if (!silent) persist();
}

export function deleteWeight(date) {
  state.weightLog = state.weightLog.filter((w) => w.date !== date);
  const latest = listWeights().at(-1);
  if (latest) state.settings.weightKg = latest.kg;
  persist();
}

/** Bodyweight in effect on a given date — the most recent reading on or before it. */
export function weightForDate(date) {
  const applicable = listWeights().filter((w) => w.date <= date);
  if (applicable.length) return applicable.at(-1).kg;
  const all = listWeights();
  return all.length ? all[0].kg : state.settings.weightKg;
}

/* ------------------------------ import/export -------------------------- */

export function exportJson() {
  return JSON.stringify(state, null, 2);
}

export function importJson(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || !('entries' in parsed)) {
    throw new Error('That file does not look like a Diligent III export.');
  }
  state = {
    ...emptyState(),
    ...parsed,
    settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
    entries: parsed.entries || {},
    weightLog: parsed.weightLog || [],
  };
  persist();
}

export function clearAll() {
  state = emptyState();
  persist();
}
