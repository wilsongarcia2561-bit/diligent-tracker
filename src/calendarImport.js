/**
 * Parses a plain-text (or Markdown) calendar log into a day-entry patch.
 *
 * Text-in, patch-out, no DOM — this is the same shape as engine.js so it can
 * be unit tested directly. PDF files go through src/pdfText.js first to become
 * plain text, then land here too; this module never sees a binary.
 *
 * Design goal: precision over recall. A field is only filled when a pattern
 * confidently matches; anything ambiguous is left blank for the user to fill
 * in by hand, per their own request. Every parse also keeps the original text
 * in the entry's notes field, so nothing is silently discarded.
 *
 * Recognized format (labels are case-insensitive, order doesn't matter):
 *
 *   Date: 2026-09-18
 *   Shift: 08:08 - 15:18            (24h, or "8:08 AM - 3:18 PM")
 *   Location: 200 Sherry Hl Trl     (repeat for multiple sites)
 *
 *   98° (Feels 104° Sunny)          (or "Temp: 98F" / "Feels-like: 104F")
 *   Breaks: 6
 *   (Lunch break 12:16 - 1:04)
 *
 *   • Task description one
 *   • Task description two
 *
 * Anything not on this list (weight, intake, notes) is left for manual entry.
 */

import { suggestMet } from './engine.js';

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const CHECKLIST = ['date', 'shift', 'lunch', 'breaks', 'heat', 'siteCount', 'tasks', 'weight', 'intake'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** "8:08 AM" / "15:18" / "3:18pm" → "HH:MM" (24h), or null if unparseable. */
function normalizeClockTime(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp]\.?[Mm]\.?)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return null;
  const suffix = m[3] ? m[3][0].toLowerCase() : null;
  if (suffix === 'a') {
    if (h === 12) h = 0;
  } else if (suffix === 'p') {
    if (h !== 12) h += 12;
  }
  if (h > 23) return null;
  return `${pad2(h)}:${pad2(min)}`;
}

/**
 * A lunch break's bare hour (no AM/PM given) is read as midday: 12 stays
 * noon, 1-6 roll to afternoon. This matches how a landscaper's own calendar
 * actually writes it ("12:16 - 1:04") and is not applied to shift times,
 * which are far less safe to guess at.
 */
function normalizeLunchTime(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp]\.?[Mm]\.?)?$/);
  if (!m) return null;
  if (m[3]) return normalizeClockTime(raw);
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 12) return null;
  if (h >= 1 && h <= 6) h += 12;
  return `${pad2(h)}:${pad2(min)}`;
}

const RANGE_JOIN = '(?:-|–|—|to)';
const TIME = '(\\d{1,2}:\\d{2}\\s*(?:[AaPp]\\.?[Mm]\\.?)?)';

function findLabeled(text, ...keys) {
  const alt = keys.join('|');
  const re = new RegExp(`^[ \\t]*(?:${alt})[ \\t]*:[ \\t]*(.+)$`, 'im');
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

function parseDate(text, filename) {
  const labeled = findLabeled(text, 'date');
  if (labeled) {
    const iso = labeled.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const named = labeled.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(20\d{2})\b/);
    if (named) {
      const mon = MONTHS[named[1].slice(0, 3).toLowerCase()];
      if (mon) return `${named[3]}-${pad2(mon)}-${pad2(Number(named[2]))}`;
    }
  }
  const bareIso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (bareIso) return `${bareIso[1]}-${bareIso[2]}-${bareIso[3]}`;
  const bareNamed = text.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(20\d{2})\b/);
  if (bareNamed) {
    const mon = MONTHS[bareNamed[1].slice(0, 3).toLowerCase()];
    if (mon) return `${bareNamed[3]}-${pad2(mon)}-${pad2(Number(bareNamed[2]))}`;
  }
  const fromFilename = String(filename || '').match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (fromFilename) return `${fromFilename[1]}-${fromFilename[2]}-${fromFilename[3]}`;
  return null;
}

/**
 * Shift times require an explicit label ("Shift:", "Hours:", "Work hours:").
 * Unlike lunch, there's no safe way to guess which bare time range in free
 * text is the shift — scanning the whole body would happily misread an
 * unrelated time mentioned anywhere else, so an unlabeled day leaves shift
 * start/end blank for manual entry instead.
 */
function parseShift(text) {
  const labeled = findLabeled(text, 'shift', 'work\\s*hours', 'hours');
  if (!labeled) return null;
  const re = new RegExp(`${TIME}\\s*${RANGE_JOIN}\\s*${TIME}`);
  const m = labeled.match(re);
  if (!m) return null;
  const start = normalizeClockTime(m[1]);
  const end = normalizeClockTime(m[2]);
  if (!start || !end) return null;
  return { start, end };
}

function parseLunch(text) {
  const re = new RegExp(`lunch(?:\\s*break)?[ \\t]*:?[ \\t]*${TIME}\\s*${RANGE_JOIN}\\s*${TIME}`, 'i');
  const m = text.match(re);
  if (!m) return null;
  const start = normalizeLunchTime(m[1]);
  const end = normalizeLunchTime(m[2]);
  if (!start || !end) return null;
  return { start, end };
}

function parseBreakCount(text) {
  const labeled = findLabeled(text, 'breaks?');
  if (labeled) {
    const n = labeled.match(/\d+/);
    if (n) return Number(n[0]);
  }
  const inline = text.match(/\bbreaks?\s*[:\-]?\s*(\d+)\b/i) || text.match(/\b(\d+)\s*breaks?\b/i);
  return inline ? Number(inline[1]) : null;
}

function parseHeat(text) {
  const combined = text.match(/(\d{2,3})\s*°?\s*F?\s*\(?\s*feels?(?:[\s-]*like)?\s*[:\-]?\s*(\d{2,3})/i);
  if (combined) return { temp: Number(combined[1]), feelsLike: Number(combined[2]) };
  const feelsLabeled = findLabeled(text, 'feels?[\\s-]*like');
  const tempLabeled = findLabeled(text, 'temp(?:erature)?');
  const feelsLike = feelsLabeled ? Number((feelsLabeled.match(/\d{2,3}/) || [])[0]) : null;
  const temp = tempLabeled ? Number((tempLabeled.match(/\d{2,3}/) || [])[0]) : null;
  if (temp || feelsLike) return { temp: temp || null, feelsLike: feelsLike || null };
  return null;
}

function parseSiteCount(text) {
  const labeled = findLabeled(text, 'site\\s*count', 'sites?');
  if (labeled) {
    const n = labeled.match(/\d+/);
    if (n) return Number(n[0]);
  }
  const locations = text.match(/^[ \t]*location[ \t]*:/gim);
  if (locations && locations.length) return locations.length;
  return null;
}

function parseWeight(text) {
  const labeled = findLabeled(text, 'weight', 'bodyweight');
  if (!labeled) return null;
  const m = labeled.match(/([\d.]+)\s*(kg|lb|lbs)?/i);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  return m[2] && /lb/i.test(m[2]) ? Math.round((value / 2.2046226218) * 100) / 100 : value;
}

function parseIntake(text) {
  const labeled = findLabeled(text, 'intake');
  if (!labeled) return null;
  const m = labeled.match(/[\d,]+/);
  return m ? Number(m[0].replace(/,/g, '')) : null;
}

/** Bullet or numbered lines become task phases. The bullet char and the text
 * needn't have a space between them — real calendar exports are inconsistent
 * about it ("•REPAIR SPRINKLERS" with no space is a real example). */
function parseTasks(text) {
  const lines = text.split(/\r?\n/);
  const tasks = [];
  for (const line of lines) {
    const bullet = line.match(/^[ \t]*(?:[•\-*+]|\d+[.)])[ \t]*(.+?)[ \t]*$/);
    if (bullet) {
      const description = bullet[1].trim();
      if (description) tasks.push(description);
    }
  }
  return tasks;
}

/**
 * @param {string} text        extracted plain text
 * @param {object} opts        { filename, fallbackDate }
 * @returns {{patch: object, matched: string[], unmatched: string[]}}
 */
export function parseCalendarLog(text, opts = {}) {
  const body = String(text || '');
  const matched = [];
  const patch = {};

  const parsedDate = parseDate(body, opts.filename);
  patch.date = parsedDate || opts.fallbackDate || null;
  if (parsedDate) matched.push('date');

  const shift = parseShift(body);
  if (shift) {
    patch.shiftStart = shift.start;
    patch.shiftEnd = shift.end;
    matched.push('shift');
  }

  const lunch = parseLunch(body);
  if (lunch) {
    patch.lunchStart = lunch.start;
    patch.lunchEnd = lunch.end;
    matched.push('lunch');
  }

  const breakCount = parseBreakCount(body);
  if (breakCount !== null) {
    patch.breakCount = breakCount;
    matched.push('breaks');
  }

  const heat = parseHeat(body);
  if (heat) {
    if (heat.temp) patch.tempF = heat.temp;
    if (heat.feelsLike) patch.feelsLikeF = heat.feelsLike;
    matched.push('heat');
  }

  const siteCount = parseSiteCount(body);
  if (siteCount !== null) {
    patch.siteCount = siteCount;
    matched.push('siteCount');
  }

  const weight = parseWeight(body);
  if (weight !== null) {
    patch.weightKg = weight;
    matched.push('weight');
  }

  const intake = parseIntake(body);
  if (intake !== null) {
    patch.intakeKcal = intake;
    matched.push('intake');
  }

  const tasks = parseTasks(body);
  if (tasks.length) {
    patch.phases = tasks.map((description) => {
      const suggestion = suggestMet(description);
      return {
        description,
        met: suggestion ? suggestion.met : '',
        captureCategory: suggestion ? suggestion.capture : '',
      };
    });
    matched.push('tasks');
  }

  const filenameNote = opts.filename ? ` from ${opts.filename}` : '';
  const excerpt = body.trim().slice(0, 4000);
  const unmatched = CHECKLIST.filter((k) => !matched.includes(k));
  patch.notes = [
    `Imported${filenameNote}.`,
    unmatched.length ? `Not auto-filled — check/complete manually: ${unmatched.join(', ')}.` : null,
    '',
    '--- original text ---',
    excerpt,
  ]
    .filter((line) => line !== null)
    .join('\n');

  return { patch, matched, unmatched };
}
