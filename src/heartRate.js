/**
 * Samsung Health heart-rate exports → readings, and the raw (uncorrected)
 * HRR → MET cross-check the engine runs against each day.
 *
 * The export lists one row per time window: a date ("Oct 21"), a window
 * ("2∶30 PM - 2∶59 PM", with a ratio sign for the colon and a narrow
 * no-break space before PM), the watch's min–max for that window ("73-103"),
 * and sometimes a tag ("Exercising", or "Resting" on a single spot reading).
 * PDF text extractors lay that out either one field per line or one row per
 * line, so rows are matched across the whole text rather than line by line.
 * The same rows copied into a spreadsheet come back with the date as
 * 2026-10-21 or 10/21/2026, and those are read too.
 *
 * No correction is applied to the watch's numbers: a window's heart rate is
 * the middle of its min–max, as recorded. Pure functions — no DOM.
 */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const SP = '[\\s\\u00a0\\u2009\\u202f]';
const CLOCK = `(\\d{1,2})[:\\u2236](\\d{2})(?:[:\\u2236]\\d{2})?(?:${SP}*([AaPp])\\.?[Mm]\\.?)?`;
const ROW = new RegExp(
  `\\b(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?${SP}+(\\d{1,2})(?:,${SP}*(\\d{4}))?`
  + '|(\\d{4})-(\\d{1,2})-(\\d{1,2})|(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4}))'
  + `${SP}+${CLOCK}(?:${SP}*[-–]${SP}*${CLOCK})?${SP}+`
  + `(\\d{2,3})(?:${SP}*[-–]${SP}*(\\d{2,3}))?(?!\\d|[:\\u2236°])`
  + `(?:${SP}+(Exercising|Resting|Workout|Sleeping|Sleep))?`,
  'gi',
);
const BPM_MIN = 30;
const BPM_MAX = 230;

const minutes = (h, m, ap) => {
  let hour = Number(h);
  if (hour > 23 || Number(m) > 59) return null;
  if (ap) {
    const pm = ap.toLowerCase() === 'p';
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }
  return hour * 60 + Number(m);
};

/** The year an export covers, from its filename ("Heart_rate_Jul222026-Oct212026.pdf") or text. */
export function exportYear(filename = '', text = '') {
  const fromName = String(filename).match(/(20\d{2})/);
  if (fromName) return Number(fromName[1]);
  // Never the profile's date of birth.
  const body = String(text).replace(/date of birth[^\n]*/gi, '');
  const m = body.match(/\b(20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

/**
 * The dates an export covers, from a Samsung filename such as
 * "Heart_rate_Jul222026-Oct212026.pdf" → { from: '2026-07-22', to: '2026-10-21' }.
 * Rows only give "Oct 21", so this is what places a Dec–Jan export's rows in
 * the right year.
 */
export function exportRange(filename = '') {
  const m = String(filename).match(/([A-Za-z]{3})[a-z]*[ _-]?(\d{1,2})[ _,-]?(20\d{2})\s*[-–_]\s*([A-Za-z]{3})[a-z]*[ _-]?(\d{1,2})[ _,-]?(20\d{2})/);
  if (!m) return null;
  const iso = (mon, d, y) => {
    const mo = MONTHS[mon.toLowerCase()];
    return mo ? `${y}-${String(mo).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}` : null;
  };
  const from = iso(m[1], m[2], m[3]);
  const to = iso(m[4], m[5], m[6]);
  return from && to && from <= to ? { from, to } : null;
}

/** Does this text look like a Samsung heart-rate export? */
export function looksLikeHeartRateExport(text) {
  const t = String(text || '');
  if (/^[ \t]*shift[ \t]*:/im.test(t)) return false;
  ROW.lastIndex = 0;
  let n = 0;
  while (ROW.exec(t) && n < 5) n += 1;
  ROW.lastIndex = 0;
  return n >= 5 || (/heart rate/i.test(t) && n >= 2);
}

/**
 * @returns {{ date: string, t: number, end: number, lo: number, hi: number, tag: string }[]}
 *   sorted by date then time; duplicates dropped.
 */
export function parseHeartRate(text, { year = new Date().getFullYear(), range = null } = {}) {
  const out = [];
  const seen = new Set();
  const src = String(text || '');
  ROW.lastIndex = 0;
  let m;
  while ((m = ROW.exec(src))) {
    const [, mon, day, yr, isoY, isoM, isoD, usM, usD, usY, h1, m1, ap1, h2, m2, ap2, a, b, tagRaw] = m;
    // "12∶30 - 12∶59 PM": the end's AM/PM applies to an unmarked start.
    const t = minutes(h1, m1, ap1 || ap2);
    const end = h2 ? minutes(h2, m2, ap2 || ap1) : t;
    if (t === null || end === null) continue;
    const lo = Number(a);
    const hi = b ? Number(b) : lo;
    if (lo < BPM_MIN || hi > BPM_MAX || hi < lo) continue;
    let [y, mo, d] = mon ? [yr ? Number(yr) : year, MONTHS[mon.toLowerCase()], Number(day)]
      : isoY ? [Number(isoY), Number(isoM), Number(isoD)] : [Number(usY), Number(usM), Number(usD)];
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) continue;
    const md = `${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    // "Jan 5" in a Dec–Jan export belongs to the later year.
    if (mon && !yr && range) {
      const fits = [Number(range.from.slice(0, 4)), Number(range.to.slice(0, 4))].find((cy) => `${cy}-${md}` >= range.from && `${cy}-${md}` <= range.to);
      if (fits) y = fits;
    }
    const date = `${y}-${md}`;
    const tag = tagRaw ? (/^exer|workout/i.test(tagRaw) ? 'exercising' : /^rest/i.test(tagRaw) ? 'resting' : 'sleep') : '';
    const key = `${date} ${t} ${end} ${lo} ${hi} ${tag}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, t, end: end < t ? end + 1440 : end, lo, hi, tag });
  }
  return out.sort((x, y) => x.date.localeCompare(y.date) || x.t - y.t);
}

/** Readings by date, compact: [start, end, lo, hi, tag] per row (stored and synced as is). */
export function groupByDate(readings) {
  const out = {};
  for (const r of readings) (out[r.date] ||= []).push([r.t, r.end, r.lo, r.hi, r.tag]);
  return out;
}

const toRow = (r) => (Array.isArray(r) ? { t: r[0], end: r[1], lo: r[2], hi: r[3], tag: r[4] || '' } : r);

/** "HH:MM" → minutes past midnight, or null. */
export function clockMinutes(value) {
  const m = typeof value === 'string' && value.match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Minute-weighted heart rate over [start, end) minus excluded intervals
 * (lunch, documented non-work). Each regular window counts for the minutes
 * it overlaps; its heart rate is the middle of its min–max, uncorrected.
 * "Exercising" segments overlap the regular windows, so they are counted as
 * markers, not averaged in twice; "Resting" spot readings are ignored.
 */
export function windowStats(readings, start, end, exclude = []) {
  if (!Array.isArray(readings) || start === null || end === null || end <= start) return null;
  let w = 0;
  let sum = 0;
  let peak = 0;
  let low = Infinity;
  let exercising = 0;
  let covered = 0;
  for (const raw of readings) {
    const r = toRow(raw);
    if (r.tag === 'resting' || r.tag === 'sleep') continue;
    const rEnd = r.end > r.t ? r.end + 1 : r.t + 1;
    if (r.tag === 'exercising') {
      if (r.t < end && rEnd > start) exercising += 1;
      continue;
    }
    let ov = Math.max(0, Math.min(end, rEnd) - Math.max(start, r.t));
    for (const [a, b] of exclude) {
      if (a === null || b === null) continue;
      ov -= Math.max(0, Math.min(end, rEnd, b) - Math.max(start, r.t, a));
    }
    if (ov <= 0) continue;
    w += ov;
    sum += ((r.lo + r.hi) / 2) * ov;
    peak = Math.max(peak, r.hi);
    low = Math.min(low, r.lo);
    covered += 1;
  }
  if (!w) return { minutes: 0, windows: 0, exercising };
  return { minutes: w, windows: covered, hr: sum / w, peak, low, exercising };
}

/**
 * §5 check of a day's MET against its raw watch heart rate over its work time.
 * `window` is { start, end, exclude } in minutes past midnight. Below
 * `minCoverage` of the work minutes recorded, the day is too thin to judge.
 * The verdict runs both ways: a heart-rate MET more than `agreement` away
 * from the day's MET suggests revising it, up or down.
 */
export function rawHrCheck(rows, window, { dayMet = null, restingHr, maxHr, agreement = 0.5, minCoverage = 0.6 }) {
  const exclude = window.exclude || [];
  const span = window.end - window.start - exclude.reduce((t, [a, b]) => t + Math.max(0, Math.min(window.end, b) - Math.max(window.start, a)), 0);
  const st = windowStats(rows, window.start, window.end, exclude);
  if (!st || !st.minutes) return { status: 'no-readings', span, minutes: 0, coverage: 0 };
  const hrr = hrrOf(st.hr, restingHr, maxHr);
  const met = metFromHrr(hrr);
  const out = { ...st, span, coverage: span > 0 ? st.minutes / span : 0, hrr, met, suggested: Math.round(met * 4) / 4 };
  if (out.coverage < minCoverage) return { ...out, status: 'sparse' };
  const known = dayMet !== null && dayMet !== '' && Number(dayMet) > 0;
  if (!known) return { ...out, status: 'ok', verdict: 'hr-only' };
  const diff = met - Number(dayMet);
  const verdict = Math.abs(diff) <= agreement ? 'agree' : diff > 0 ? 'up' : 'down';
  return { ...out, status: 'ok', verdict, diff, dayMet: Number(dayMet) };
}

/** HRR = (heart rate − resting) / (max − resting). */
export const hrrOf = (hr, resting, max) => (hr - resting) / (max - resting);

/**
 * DILIGENT IV §4 HRR → MET table as one curve: 35–45% → 4.5–5.5 … 75–85% →
 * 8.5–9.5 is MET = 1 + 10 × HRR (which also gives MET 1 at rest), and
 * 85–95% → 9.5–12 continues at the steeper slope the table gives there.
 */
export function metFromHrr(hrr) {
  if (!Number.isFinite(hrr)) return null;
  const h = Math.max(0, hrr);
  return h <= 0.85 ? 1 + 10 * h : Math.min(12, 9.5 + (h - 0.85) * 25);
}
