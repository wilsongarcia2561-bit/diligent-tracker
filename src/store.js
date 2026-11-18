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
  weightKg: DEFAULT_WEIGHT_KG,
  restingHr: RESTING_HR,
  maxHr: MAX_HR,
};

function emptyState() {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    entries: {},
    weightLog: SEED_WEIGHT_LOG.map((w) => ({ ...w })),
    // Samsung watch heart rate by date: { rows: [[start, end, lo, hi, tag]…], source, at }.
    watchHr: {},
    // When each synced item last changed on this device: key → { at, del? }.
    // Keys: e:<date> a day, r:<date> that day's watch heart rate, w the weight
    // log, s the settings. `del` marks a deletion so it can travel to other devices.
    sync: {},
  };
}

let state = emptyState();

/** Saved settings over the defaults, with heart-rate baselines kept only when they are plausible. */
function cleanSettings(saved) {
  const out = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  const rest = Number(out.restingHr);
  const max = Number(out.maxHr);
  out.restingHr = rest >= 30 && rest <= 110 ? rest : RESTING_HR;
  out.maxHr = max >= 120 && max <= 240 && max > out.restingHr ? max : MAX_HR;
  return out;
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
  for (const [date, day] of Object.entries(state.watchHr)) {
    state.sync[`r:${date}`] ||= { at: day.at || EPOCH };
  }
  // "h:" readings belonged to the retired corrected-BPM framework.
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
        watchHr: cleanWatchHr(parsed.watchHr),
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
  // A half-typed heart-rate baseline ("4" on the way to "49") falls back to the default.
  state.settings = cleanSettings({ ...state.settings, ...patch });
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

/* ---------------------------- watch heart rate ---------------------------- */

const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
const validDay = (day) => day && typeof day === 'object' && Array.isArray(day.rows)
  && day.rows.every((r) => Array.isArray(r) && r.length >= 4 && r.slice(0, 4).every(Number.isFinite));

function cleanWatchHr(saved) {
  const out = {};
  for (const [date, day] of Object.entries(saved || {})) if (isDate(date) && validDay(day)) out[date] = day;
  return out;
}

/**
 * Store a heart-rate export, one record per date. A date already on file is
 * replaced by the new export's readings for it — an export covers whole days.
 * @param {Record<string, any[]>} byDate rows per date, as heartRate.groupByDate gives them
 */
export function saveHeartRate(byDate, { source = '' } = {}) {
  const at = nowIso();
  const dates = Object.keys(byDate).filter(isDate).sort();
  for (const date of dates) {
    state.watchHr[date] = { rows: byDate[date], source, at };
    touch(`r:${date}`, { at });
  }
  persist();
  return dates;
}

/** That day's watch readings, or null. */
export function getHeartRate(date) {
  return state.watchHr[date]?.rows || null;
}

export const heartRateDates = () => Object.keys(state.watchHr).sort();

/** Remove every stored heart-rate day (and tell other devices to). */
export function clearHeartRate() {
  const at = nowIso();
  for (const date of Object.keys(state.watchHr)) touch(`r:${date}`, { del: true, at });
  state.watchHr = {};
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

/**
 * An entry with what the engine needs resolved: the bodyweight in effect that
 * day, and that day's watch heart rate. For calculating only — never saved.
 */
export function resolveEntry(entry) {
  const weightKg = entry.weightKg !== '' && Number(entry.weightKg) > 0 ? entry.weightKg : weightForDate(entry.date);
  return { ...entry, weightKg, watchHr: getHeartRate(entry.date) };
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
    watchHr: cleanWatchHr(parsed.watchHr),
    sync: {},
  };
  delete state.heartRate;
  // A restore is the newest word on everything it contains, and anything it
  // leaves out was deliberately dropped.
  const at = nowIso();
  for (const date of Object.keys(state.entries)) touch(`e:${date}`, { at });
  for (const date of Object.keys(state.watchHr)) touch(`r:${date}`, { at });
  touch('w', { at });
  touch('s', { at });
  for (const key of Object.keys(before.sync || {})) {
    if (!state.sync[key] && (key.startsWith('e:') || key.startsWith('r:'))) touch(key, { del: true, at });
  }
  persist();
}

export function clearAll() {
  const before = state;
  state = emptyState();
  // Erase means erase everywhere: tombstones stop other devices restoring it.
  const at = nowIso();
  for (const date of Object.keys(before.entries)) touch(`e:${date}`, { del: true, at });
  for (const date of Object.keys(before.watchHr || {})) touch(`r:${date}`, { del: true, at });
  for (const key of Object.keys(before.sync || {})) {
    if ((key.startsWith('e:') || key.startsWith('r:')) && !state.sync[key]) touch(key, { del: true, at });
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
    else if (kind === 'r') value = state.watchHr[date];
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
    if (kind === 'e' && isDate(date)) {
      if (doc.del) delete state.entries[date];
      else if (doc.v && typeof doc.v === 'object') state.entries[date] = doc.v;
      else continue;
    } else if (kind === 'r' && doc.k[1] === ':' && isDate(date)) {
      if (doc.del) delete state.watchHr[date];
      else if (validDay(doc.v)) state.watchHr[date] = doc.v;
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
