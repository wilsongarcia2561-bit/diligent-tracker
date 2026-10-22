/**
 * Persistence layer — localStorage only. No network, no accounts.
 * Everything the app knows lives under a single versioned key.
 */

import {
  BMR_KCAL,
  DEFAULT_BREAK_MINUTES,
  DEFAULT_WEIGHT_KG,
  SEED_WEIGHT_LOG,
} from './data.js';

const KEY = 'diligent3.v1';

export const DEFAULT_SETTINGS = {
  bmr: BMR_KCAL,
  breakMinutesDefault: DEFAULT_BREAK_MINUTES,
  weightKg: DEFAULT_WEIGHT_KG,
};

function emptyState() {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    entries: {},
    weightLog: SEED_WEIGHT_LOG.map((w) => ({ ...w })),
    // When each synced item last changed on this device: key → { at, del? }.
    // Keys: e:<date> a day, w the weight log, s the settings. `del` marks a
    // deletion so it can travel to other devices.
    sync: {},
  };
}

let state = emptyState();

/** Saved settings minus anything the app no longer uses (the old HRR baselines). */
function cleanSettings(saved) {
  const { restingHr, maxHr, ...rest } = saved || {};
  return { ...DEFAULT_SETTINGS, ...rest };
}
const listeners = new Set();
const EPOCH = '1970-01-01T00:00:00.000Z';

/* Storage health: a phone's in-app browser can block or fill localStorage, and
   a failed write must be visible instead of silently losing the day. */
let storage = { ok: true, error: '' };
export const storageStatus = () => ({ ...storage });

/* Sync hooks — see sync.js. Local edits report the key they touched. */
const localChangeHandlers = new Set();
export function onLocalChange(fn) {
  localChangeHandlers.add(fn);
  return () => localChangeHandlers.delete(fn);
}
const nowIso = () => new Date().toISOString();

function touch(key, { del = false, at = nowIso() } = {}) {
  state.sync[key] = del ? { at, del: true } : { at };
  localChangeHandlers.forEach((fn) => fn(key));
}

/** Give data from before sync existed a timestamp, without inventing writes for untouched defaults. */
function migrateSync() {
  state.sync ||= {};
  for (const [date, entry] of Object.entries(state.entries)) {
    state.sync[`e:${date}`] ||= { at: entry.updatedAt || EPOCH };
  }
  // Heart-rate readings belonged to the retired BPM/HRR framework.
  for (const key of Object.keys(state.sync)) if (key.startsWith('h:')) delete state.sync[key];
  if (!state.sync.w && JSON.stringify(state.weightLog) !== JSON.stringify(SEED_WEIGHT_LOG)) state.sync.w = { at: EPOCH };
  if (!state.sync.s && JSON.stringify({ ...state.settings, weightKg: 0 }) !== JSON.stringify({ ...DEFAULT_SETTINGS, weightKg: 0 })) state.sync.s = { at: EPOCH };
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state = {
        ...emptyState(),
        ...parsed,
        settings: cleanSettings(parsed.settings),
        entries: parsed.entries || {},
        weightLog: parsed.weightLog || [],
        sync: parsed.sync || {},
      };
      delete state.heartRate;
    }
  } catch (err) {
    console.error('Could not read saved data; starting fresh.', err);
    storage = { ok: false, error: `This browser would not let the app read its saved data (${err.message || err}).` };
    state = emptyState();
  }
  migrateSync();
  return state;
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    storage = { ok: true, error: '' };
  } catch (err) {
    console.error('Could not save data.', err);
    const full = /quota|exceeded|full/i.test(`${err.name} ${err.message}`);
    storage = {
      ok: false,
      error: full
        ? 'This browser’s storage is full, so the latest changes are not being saved on this device.'
        : 'This browser is blocking storage, so changes are not being saved on this device.',
    };
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
  touch('s');
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
    steps: '',
    notes: '',
    importFlags: [],
    nonLaborWindows: [],
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

export function saveEntry(entry, { logWeight = true } = {}) {
  const at = nowIso();
  const before = state.entries[entry.date];
  state.entries[entry.date] = { ...entry, updatedAt: at };
  touch(`e:${entry.date}`, { at });
  // §4 — a per-entry fasted-morning weight also updates the weight log, but
  // only when it was just entered or changed. An imported summary row carries
  // the weight it was computed with, and re-saving a day (any edit) must not
  // log that weight again as a new weigh-in.
  const weight = Number(entry.weightKg);
  const changed = !before || Number(before.weightKg) !== weight;
  if (logWeight && changed && entry.weightKg !== '' && entry.weightKg !== null && weight > 0) {
    upsertWeight({ date: entry.date, kg: Number(entry.weightKg), note: 'From daily entry' }, { silent: true });
  }
  persist();
  return state.entries[entry.date];
}

export function deleteEntry(date) {
  delete state.entries[date];
  touch(`e:${date}`, { del: true });
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
  touch('w');
  // The bodyweight constant tracks the most recent reading (§4).
  const latest = listWeights().at(-1);
  if (latest) state.settings.weightKg = latest.kg;
  if (!silent) persist();
}

export function deleteWeight(date) {
  state.weightLog = state.weightLog.filter((w) => w.date !== date);
  touch('w');
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

/** An entry with what the engine needs resolved: the bodyweight in effect that day. */
export function resolveEntry(entry) {
  return entry.weightKg !== '' && Number(entry.weightKg) > 0 ? entry : { ...entry, weightKg: weightForDate(entry.date) };
}

/* ------------------------------ import/export -------------------------- */

export function exportJson() {
  return JSON.stringify(state, null, 2);
}

export function importJson(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || !('entries' in parsed)) {
    throw new Error('That file does not look like a Diligent export.');
  }
  const before = state;
  state = {
    ...emptyState(),
    ...parsed,
    settings: cleanSettings(parsed.settings),
    entries: parsed.entries || {},
    weightLog: parsed.weightLog || [],
    sync: {},
  };
  delete state.heartRate;
  // A restore is the newest word on everything it contains, and anything it
  // leaves out was deliberately dropped.
  const at = nowIso();
  for (const date of Object.keys(state.entries)) touch(`e:${date}`, { at });
  touch('w', { at });
  touch('s', { at });
  for (const key of Object.keys(before.sync || {})) {
    if (!state.sync[key] && key.startsWith('e:')) touch(key, { del: true, at });
  }
  persist();
}

export function clearAll() {
  const before = state;
  state = emptyState();
  // Erase means erase everywhere: tombstones stop other devices restoring it.
  const at = nowIso();
  for (const date of Object.keys(before.entries)) touch(`e:${date}`, { del: true, at });
  for (const key of Object.keys(before.sync || {})) {
    if (key.startsWith('e:') && !state.sync[key]) touch(key, { del: true, at });
  }
  touch('w', { at });
  touch('s', { at });
  persist();
}

/* ------------------------------- syncing ------------------------------- */

/** Everything the sync layer needs to know about one item, or null if it has no state. */
export function syncRecord(key) {
  const meta = state.sync[key];
  if (!meta) return null;
  const [kind, date] = [key[0], key.slice(2)];
  let value = null;
  if (!meta.del) {
    if (kind === 'e') value = state.entries[date];
    else if (key === 'w') value = state.weightLog;
    else if (key === 's') value = state.settings;
  }
  if (!meta.del && value === undefined) return null;
  return { k: key, at: meta.at, del: Boolean(meta.del), v: meta.del ? null : JSON.parse(JSON.stringify(value)) };
}

export const syncKeys = () => Object.keys(state.sync);
export const syncAt = (key) => (state.sync[key] ? state.sync[key].at : null);

/**
 * Take newer documents from another device. Returns the keys that changed.
 * Nothing here counts as a local edit, so nothing is sent back out.
 */
export function applyRemote(docs) {
  const changed = [];
  for (const doc of docs) {
    if (!doc || typeof doc.k !== 'string' || typeof doc.at !== 'string') continue;
    const mine = state.sync[doc.k];
    if (mine && mine.at >= doc.at) continue;
    const kind = doc.k[0];
    const date = doc.k.slice(2);
    if (kind === 'e' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      if (doc.del) delete state.entries[date];
      else if (doc.v && typeof doc.v === 'object') state.entries[date] = doc.v;
      else continue;
    } else if (doc.k === 'w' && Array.isArray(doc.v)) {
      state.weightLog = doc.v;
      const latest = listWeights().at(-1);
      if (latest) state.settings.weightKg = latest.kg;
    } else if (doc.k === 's' && doc.v && typeof doc.v === 'object') {
      state.settings = cleanSettings(doc.v);
      const latest = listWeights().at(-1);
      if (latest) state.settings.weightKg = latest.kg;
    } else {
      continue;
    }
    state.sync[doc.k] = doc.del ? { at: doc.at, del: true } : { at: doc.at };
    changed.push(doc.k);
  }
  if (changed.length) persist();
  return changed;
}
