/**
 * Samsung Health heart-rate exports (HTML or PDF) → timestamped readings, and
 * the window statistics the engine cross-checks MET against (§4, §5 step 2).
 *
 * The export's exact layout isn't fixed, so parsing works line by line on the
 * extracted text: a line (or table row) that carries a clock time and a heart
 * rate becomes a reading, dated by the most recent date seen above it or on
 * the same line. Anything else is ignored rather than guessed at.
 *
 * Pure functions only — no DOM — so the whole path is testable under Node.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const BPM_MIN = 30;
const BPM_MAX = 230;
/** A reading stands for the time until the next one, capped so a gap in the export isn't counted as one long reading. */
const MAX_READING_WEIGHT_MIN = 15;

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', middot: '·' };

/** HTML → text with one line per row/paragraph and " | " between table cells. */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(tr|p|div|li|h[1-6]|section|article|header|footer|table|thead|tbody)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
      if (code[0] === '#') {
        const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[code.toLowerCase()] ?? m;
    })
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').replace(/^[ |]+|[ |]+$/g, '').trim())
    .filter(Boolean)
    .join('\n');
}

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Find a date on a line; returns { date, rest } with the date text removed. */
function takeDate(line, fallbackYear) {
  const patterns = [
    [/\b(\d{4})-(\d{1,2})-(\d{1,2})(?:T|\b)/, (m) => iso(m[1], m[2], m[3])],
    [/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/, (m) => iso(m[3].length === 2 ? `20${m[3]}` : m[3], m[1], m[2])],
    [new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?(?:\\s+(\\d{4}))?\\b`, 'i'),
      (m) => iso(m[3] || fallbackYear, MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, m[2])],
    [new RegExp(`\\b(\\d{1,2})\\s+${MONTH_RE},?(?:\\s+(\\d{4}))?\\b`, 'i'),
      (m) => iso(m[3] || fallbackYear, MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, m[1])],
  ];
  for (const [re, build] of patterns) {
    const m = line.match(re);
    if (m) return { date: build(m), rest: line.replace(m[0], ' ') };
  }
  return { date: null, rest: line };
}

const TIME_RE = /\b(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*([ap])\.?\s?m\.?)?(?![\d:])/gi;

function toMinutes(h, m, ap) {
  let hour = Number(h);
  if (hour > 23 || Number(m) > 59) return null;
  if (ap) {
    const pm = ap.toLowerCase() === 'p';
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }
  return hour * 60 + Number(m);
}

const TAG_RE = /\b(exercis\w*|workout|walking|running|resting|sleep\w*|high|low)\b/i;

/**
 * Pull heart-rate readings out of export text.
 * @returns {{ date: string, t: number, bpm: number, min?: number, max?: number, tag?: string }[]}
 */
export function parseHeartRateText(text, { year = new Date().getFullYear() } = {}) {
  const readings = [];
  const seen = new Set();
  let currentDate = null;
  let header = null;

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const { date, rest } = takeDate(line, currentDate ? currentDate.slice(0, 4) : year);
    if (date) currentDate = date;

    const times = [...rest.matchAll(TIME_RE)];
    // A table header ("Time | Avg | Min | Max") tells us which cell is which.
    if (!times.length && /\|/.test(line) && /\b(min|max|avg|average|heart rate|bpm)\b/i.test(line) && !/\d{2,3}\s*bpm/i.test(line)) {
      header = line.split('|').map((c) => c.trim().toLowerCase());
      continue;
    }
    if (!times.length || !currentDate) continue;

    const t = toMinutes(times[0][1], times[0][2], times[0][3]);
    if (t === null) continue;
    let body = rest;
    for (const tm of times) body = body.replace(tm[0], ' ');

    let bpm = null;
    let min = null;
    let max = null;
    const labelled = body.match(/(\d{2,3})(?:\s*[-–~]\s*(\d{2,3}))?\s*bpm\b/i);
    if (labelled) {
      if (labelled[2]) {
        min = Number(labelled[1]);
        max = Number(labelled[2]);
      } else {
        bpm = Number(labelled[1]);
      }
    }
    if (header && /\|/.test(line)) {
      const cells = line.split('|').map((c) => c.trim());
      const col = (re) => {
        const i = header.findIndex((h) => re.test(h));
        const v = i >= 0 ? Number((cells[i] || '').match(/\d{2,3}/)?.[0]) : NaN;
        return Number.isFinite(v) ? v : null;
      };
      if (bpm === null && min === null) bpm = col(/avg|average|heart rate|bpm/);
      min ??= col(/\bmin/);
      max ??= col(/\bmax/);
    }
    if (bpm === null && min === null) {
      // Unlabelled: a lone plausible number is the reading; two are a range.
      const nums = (body.match(/\b\d{2,3}\b/g) || []).map(Number).filter((n) => n >= BPM_MIN && n <= BPM_MAX);
      if (nums.length === 1) bpm = nums[0];
      else if (nums.length === 2) [min, max] = nums[0] <= nums[1] ? nums : [nums[1], nums[0]];
      else continue;
    }
    if (bpm === null) bpm = Math.round((min + max) / 2);
    if (bpm < BPM_MIN || bpm > BPM_MAX) continue;

    const key = `${currentDate} ${t} ${bpm} ${min} ${max}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reading = { date: currentDate, t, bpm };
    if (min !== null) reading.min = min;
    if (max !== null) reading.max = max;
    const tag = body.match(TAG_RE);
    if (tag) reading.tag = tag[1].toLowerCase().startsWith('exercis') ? 'exercising' : tag[1].toLowerCase();
    readings.push(reading);
  }
  return readings;
}

/** Group readings by date, each list sorted by time. */
export function groupByDate(readings) {
  const out = {};
  for (const r of readings) (out[r.date] ||= []).push({ t: r.t, bpm: r.bpm, ...(r.min !== undefined && { min: r.min }), ...(r.max !== undefined && { max: r.max }), ...(r.tag && { tag: r.tag }) });
  for (const list of Object.values(out)) list.sort((a, b) => a.t - b.t);
  return out;
}

/** "HH:MM" → minutes past midnight, or null. */
export function clockMinutes(value) {
  const m = typeof value === 'string' && value.match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Time-weighted statistics for the readings inside [start, end), minus any
 * excluded intervals (lunch). Samsung samples far more densely during a
 * tagged workout than at rest, so each reading counts for the minutes until
 * the next one (capped) rather than once — otherwise a short exercising
 * stretch would dominate the median.
 */
export function windowStats(readings, start, end, exclude = []) {
  if (!Array.isArray(readings) || start === null || end === null || end <= start) return null;
  const outside = (t) => exclude.some(([a, b]) => a !== null && b !== null && t >= a && t < b);
  const inside = readings.filter((r) => r.t >= start && r.t < end && !outside(r.t));
  if (!inside.length) return { n: 0 };
  const weighted = inside.map((r, i) => {
    const next = inside[i + 1] ? inside[i + 1].t : end;
    return { bpm: r.bpm, w: Math.max(1, Math.min(MAX_READING_WEIGHT_MIN, next - r.t)) };
  });
  const quantile = (q) => {
    const sorted = [...weighted].sort((a, b) => a.bpm - b.bpm);
    const total = sorted.reduce((s, x) => s + x.w, 0);
    let acc = 0;
    for (const x of sorted) {
      acc += x.w;
      if (acc >= total * q) return x.bpm;
    }
    return sorted.at(-1).bpm;
  };
  return {
    n: inside.length,
    median: quantile(0.5),
    p90: quantile(0.9),
    peak: Math.max(...inside.map((r) => r.max ?? r.bpm)),
    low: Math.min(...inside.map((r) => r.min ?? r.bpm)),
    exercising: inside.filter((r) => r.tag === 'exercising').length,
    firstT: inside[0].t,
    lastT: inside.at(-1).t,
  };
}
