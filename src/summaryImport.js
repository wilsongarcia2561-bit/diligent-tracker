/**
 * Day-by-day TDEE tables (CSV, or rows pasted from a spreadsheet) → day entries.
 *
 * A summary row has already done the shift arithmetic: it gives net work
 * minutes, the active kcal and the estimated lines. Each row becomes a day the
 * engine computes itself — one phase at the MET that reproduces the row's
 * active kcal, `netWorkMinutesOverride` for the time, and NEAT, TEF and
 * background carried as given — so the app's TDEE for that day can be checked
 * against the file's instead of copied from it.
 *
 * Accepts the app's own CSV export, comma- or tab-separated text (a copy from
 * Google Sheets or Excel), a header row or none (then the export's column
 * order is assumed), TRUE/FALSE or yes/no, ISO or M/D/YYYY dates, and
 * "3,000"-style numbers. Pure functions — no DOM.
 */

/** The app's own CSV export, which is also the order a headerless paste is read in. */
export const EXPORT_COLUMNS = [
  'date', 'rest_day', 'main_task', 'net_work_minutes', 'feels_like_f', 'sites', 'weight_kg',
  'bmr', 'active_kcal', 'neat_kcal', 'tef_kcal', 'background_kcal', 'tdee_kcal',
  'kcal_raw_comparison', 'intake_kcal', 'balance_kcal', 'diligent_iv_tdee', 'flags',
];

const ALIASES = {
  date: ['date', 'day'],
  rest_day: ['rest_day', 'rest', 'restday', 'non_work', 'non_work_day', 'nonwork'],
  main_task: ['main_task', 'task', 'tasks', 'description', 'work'],
  net_work_minutes: ['net_work_minutes', 'net_minutes', 'net_work_min', 'net_work', 'active_minutes', 'active_min'],
  active_hours: ['active_hrs', 'active_hours', 'net_work_hours', 'net_hours', 'hours', 'hrs'],
  met: ['met', 'blended_met'],
  feels_like_f: ['feels_like_f', 'feels_like', 'feels', 'heat_index'],
  temp_f: ['temp_f', 'temp', 'temperature'],
  sites: ['sites', 'site_count'],
  weight_kg: ['weight_kg', 'weight', 'kg', 'bodyweight_kg'],
  bmr: ['bmr', 'bmr_kcal'],
  active_kcal: ['active_kcal', 'active', 'active_work', 'active_work_kcal'],
  neat_kcal: ['neat_kcal', 'neat', 'post_work_neat'],
  tef_kcal: ['tef_kcal', 'tef'],
  background_kcal: ['background_kcal', 'background', 'background_daily_life'],
  tdee_kcal: ['tdee_kcal', 'tdee'],
  kcal_raw: ['kcal_raw_comparison', 'kcal_raw', 'raw'],
  intake_kcal: ['intake_kcal', 'intake'],
  steps: ['steps', 'step_count'],
  flags: ['flags', 'notes', 'note', 'comments'],
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const normalize = (h) => String(h || '').replace(/^﻿/, '').trim().toLowerCase()
  .replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** RFC 4180-style parsing: quoted fields may hold the delimiter, "" and newlines. */
export function parseDelimited(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function firstLine(text) {
  return String(text || '').replace(/^﻿/, '').split(/\r?\n/).find((l) => l.trim()) || '';
}

function detectDelimiter(text) {
  const line = firstLine(text);
  const counts = { '\t': (line.match(/\t/g) || []).length, ',': (line.match(/,/g) || []).length, ';': (line.match(/;/g) || []).length };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',';
}

export function parseDate(value) {
  const v = String(value || '').trim();
  let m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  m = v.match(/^(?:[a-z]{3,9},?\s+)?([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (m && MONTHS[m[1].toLowerCase()]) return iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  return null;
}

function iso(y, mo, d) {
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100)) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "3,000" / " 1009 kcal" / "" → number or null. */
export function parseNumber(value) {
  const v = String(value ?? '').replace(/kcal|min|kg|°f?/gi, '').replace(/[,\s]/g, '');
  if (v === '' || v === '-' || v === '—') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const parseBool = (value) => /^(true|yes|y|1|x|✓|rest)$/i.test(String(value || '').trim());

/** Map each known field to its column index from a header row. */
function mapHeader(cells) {
  const names = cells.map(normalize);
  const map = {};
  for (const [field, aliases] of Object.entries(ALIASES)) {
    const i = names.findIndex((n) => aliases.includes(n));
    if (i >= 0) map[field] = i;
  }
  return map;
}

/**
 * Is this a day-by-day TDEE table? A header row needs a date column plus at
 * least two TDEE-ish columns; a headerless paste needs a date first and the
 * export's column count.
 */
export function looksLikeSummaryTable(text) {
  if (/^[ \t]*shift[ \t]*:/im.test(text)) return false;
  const delimiter = detectDelimiter(text);
  const rows = parseDelimited(text, delimiter).slice(0, 3);
  if (!rows.length || rows[0].length < 3) return false;
  const map = mapHeader(rows[0]);
  const numeric = ['tdee_kcal', 'active_kcal', 'net_work_minutes', 'active_hours', 'neat_kcal', 'tef_kcal', 'background_kcal', 'met'];
  if (map.date !== undefined && numeric.filter((k) => map[k] !== undefined).length >= 2) return true;
  return Boolean(parseDate(rows[0][0])) && rows[0].length === EXPORT_COLUMNS.length;
}

const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * @param {string} text
 * @param {{ filename?: string }} opts
 * @returns {{ days: object[], skipped: {line: number, reason: string}[], duplicates: string[], headerless: boolean }}
 */
export function parseSummaryTable(text, { filename = 'the file' } = {}) {
  const delimiter = detectDelimiter(text);
  const rows = parseDelimited(text, delimiter);
  let map = mapHeader(rows[0] || []);
  let start = 1;
  let headerless = false;
  if (map.date === undefined) {
    map = mapHeader(EXPORT_COLUMNS);
    start = 0;
    headerless = true;
  }
  const cell = (row, field) => (map[field] === undefined ? '' : (row[map[field]] ?? '').trim());
  const num = (row, field) => parseNumber(cell(row, field));

  const days = [];
  const skipped = [];
  const seen = new Map();
  const duplicates = [];

  rows.slice(start).forEach((row, i) => {
    const line = i + start + 1;
    const date = parseDate(cell(row, 'date'));
    if (!date) {
      skipped.push({ line, reason: `no readable date ("${cell(row, 'date').slice(0, 20)}")` });
      return;
    }
    const rest = parseBool(cell(row, 'rest_day'));
    const task = cell(row, 'main_task');
    const flagText = cell(row, 'flags');
    const tdee = num(row, 'tdee_kcal');
    const active = num(row, 'active_kcal');
    const kg = num(row, 'weight_kg');
    const hours = num(row, 'active_hours');
    const net = num(row, 'net_work_minutes') ?? (hours !== null ? Math.round(hours * 60) : null);
    const given = {
      neatKcal: num(row, 'neat_kcal'),
      tefKcal: num(row, 'tef_kcal'),
      backgroundKcal: num(row, 'background_kcal'),
      intakeKcal: num(row, 'intake_kcal'),
    };
    const common = {
      date,
      source: 'summary',
      summaryTdee: tdee,
      taskLabel: task,
      feelsLikeF: num(row, 'feels_like_f') ?? '',
      tempF: num(row, 'temp_f') ?? '',
      siteCount: num(row, 'sites') || '',
      weightKg: kg ?? '',
      neatKcal: given.neatKcal ?? '',
      tefKcal: given.tefKcal ?? '',
      backgroundKcal: given.backgroundKcal ?? '',
      intakeKcal: given.intakeKcal ?? '',
      importFlags: flagText ? [{ level: 'info', text: `From ${filename}: ${flagText}` }] : [],
      notes: [`Imported from ${filename} (summary row).`, task ? `Task: ${task}` : null, flagText ? `Notes: ${flagText}` : null,
        tdee !== null ? `File figures: TDEE ${tdee}, active ${active ?? '—'}, NEAT ${given.neatKcal ?? '—'}, TEF ${given.tefKcal ?? '—'}, background ${given.backgroundKcal ?? '—'}.` : null]
        .filter(Boolean).join('\n'),
    };

    let day;
    let kind;
    if (rest) {
      kind = 'rest';
      day = { ...common, restDay: true, phases: [], walkingKcal: active ?? '', steps: num(row, 'steps') ?? '' };
    } else if ((tdee === null && active === null && !net) || (tdee === null && /\bunusable\b/i.test(flagText))) {
      kind = 'unusable';
      day = { ...common, restDay: false, unusable: true, phases: [], neatKcal: '', tefKcal: '', backgroundKcal: '' };
    } else {
      kind = 'work';
      const metGiven = num(row, 'met');
      const raw = num(row, 'kcal_raw');
      const h = net ? net / 60 : 0;
      const w = kg || 0;
      let met = null;
      let how = '';
      if (metGiven !== null) {
        met = metGiven;
        how = 'MET column';
      } else if (active !== null && h > 0 && w > 0) {
        met = round(active / (w * h) + 1);
        how = `active ${active} kcal ÷ (${w} kg × ${round(h, 2)} hr) + 1`;
      } else if (raw !== null && h > 0 && w > 0) {
        met = round(raw / (w * h));
        how = `raw ${raw} kcal ÷ (${w} kg × ${round(h, 2)} hr)`;
      }
      if (met === null) common.importFlags.push({ level: 'warn', text: 'The row gives no net work time or bodyweight to place its active kcal on, so no MET could be set — enter one by hand.' });
      day = {
        ...common,
        restDay: false,
        netWorkMinutesOverride: net ?? '',
        phases: [{
          description: task || 'Imported day',
          met: met ?? '',
          netMinutesOverride: net ?? '',
          metAuto: false,
          metSource: 'summary',
          metConfidence: 'high',
          metBasis: met === null ? '' : `MET ${met} from the imported row (${how}), so the app's active kcal matches the file.`,
        }],
      };
    }
    if (seen.has(date)) duplicates.push(date);
    seen.set(date, days.length);
    days.push({ date, kind, line, patch: day, fileTdee: tdee });
  });

  // A date listed twice keeps its last row.
  const last = new Map(days.map((d, i) => [d.date, i]));
  return { days: days.filter((d, i) => last.get(d.date) === i), skipped, duplicates, headerless };
}
