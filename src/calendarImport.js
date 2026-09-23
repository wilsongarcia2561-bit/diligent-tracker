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

import { bpmRevisionFromNotes, classifyTask, daySoil, isShadeDay, nonLaborReason } from './metGlossary.js';

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** What a calendar day should state. Weight and intake rarely appear in a
 * calendar and have sensible fallbacks (the weight log, the TEF baseline), so
 * their absence is tracked separately instead of being reported as missing. */
const REQUIRED = ['date', 'shift', 'lunch', 'breaks', 'heat', 'siteCount', 'tasks'];
const OPTIONAL = ['weight', 'intake'];

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
const TIME = '(\\d{1,2}:\\d{2}[ \\t]*(?:[AaPp]\\.?[Mm]\\.?)?)';

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
    const named = labeled.match(/\b([A-Za-z]{3,9})\.?[ \t]+(\d{1,2}),?[ \t]+(20\d{2})\b/);
    if (named) {
      const mon = MONTHS[named[1].slice(0, 3).toLowerCase()];
      if (mon) return `${named[3]}-${pad2(mon)}-${pad2(Number(named[2]))}`;
    }
  }
  const bareIso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (bareIso) return `${bareIso[1]}-${bareIso[2]}-${bareIso[3]}`;
  const bareNamed = text.match(/\b([A-Za-z]{3,9})\.?[ \t]+(\d{1,2}),?[ \t]+(20\d{2})\b/);
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
  const labeled = findLabeled(text, 'shift', 'work[ \t]*hours', 'hours');
  if (!labeled) return null;
  const re = new RegExp(`${TIME}[ \\t]*${RANGE_JOIN}[ \\t]*${TIME}`);
  const m = labeled.match(re);
  if (!m) return null;
  const start = normalizeClockTime(m[1]);
  const end = normalizeClockTime(m[2]);
  if (!start || !end) return null;
  return { start, end };
}

function parseLunch(text) {
  // "Lunch break: post shift" / "before start shift" — the meal sat outside
  // the logged window, so there's nothing to subtract (glossary §6).
  const outside = text.match(/lunch[^\n]*?\b(post[\s-]*shift|after\s+(?:the\s+)?shift|before\s+(?:the\s+)?(?:start(?:\s+of)?\s+)?shift|pre[\s-]*shift)\b/i);
  if (outside) return { outside: outside[1].toLowerCase() };
  const re = new RegExp(`lunch(?:[ \\t]*break)?[ \\t]*:?[ \\t]*${TIME}[ \\t]*${RANGE_JOIN}[ \\t]*${TIME}`, 'i');
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
  const inline = text.match(/\bbreaks?[ \t]*[:\-]?[ \t]*(\d+)\b/i) || text.match(/\b(\d+)[ \t]*breaks?\b/i);
  return inline ? Number(inline[1]) : null;
}

function parseHeat(text) {
  // [ \t] only (never \s) between the pieces below — \s* would happily
  // bridge across blank lines and merge an unrelated number (a zip code on
  // the Location line, say) with a "Feels NN°" line further down. Real bug,
  // caught against real data: a Location line's trailing digits several lines
  // above a bare "Feels 102°" line matched as if "756" were the raw temp.
  const combined = text.match(/(\d{2,3})[ \t]*°?[ \t]*F?[ \t]*\(?[ \t]*feels?(?:[ \t-]*like)?[ \t]*[:\-]?[ \t]*(\d{2,3})/i);
  if (combined) return { temp: Number(combined[1]), feelsLike: Number(combined[2]) };
  const feelsLabeled = findLabeled(text, 'feels?[\\s-]*like');
  const tempLabeled = findLabeled(text, 'temp(?:erature)?');
  const feelsLike = feelsLabeled ? Number((feelsLabeled.match(/\d{2,3}/) || [])[0]) : null;
  const temp = tempLabeled ? Number((tempLabeled.match(/\d{2,3}/) || [])[0]) : null;
  if (temp || feelsLike) return { temp: temp || null, feelsLike: feelsLike || null };
  // Bare "Feels 102°" with no raw temp reading before it and no colon —
  // a real format in the wild (raw temp just wasn't logged that day).
  const bare = text.match(/\bfeels?\b[ \t:_-]*(\d{2,3})[ \t]*°?/i);
  if (bare) return { temp: null, feelsLike: Number(bare[1]) };
  return null;
}

/**
 * A single "Location:" line can itself list several sites — "1.) addr /
 * 2.) addr" is a real format — so a lone line is inspected for a "/"
 * separator before falling back to counting it as one site. Multiple
 * separate "Location:" lines are counted directly. "(not logged)" is left
 * as unmatched rather than counted as a real site.
 */
function parseSiteCount(text) {
  const labeled = findLabeled(text, 'site[ \t]*count', 'sites?');
  if (labeled) {
    const n = labeled.match(/\d+/);
    if (n) return Number(n[0]);
  }
  const locationLines = text.match(/^[ \t]*location[ \t]*:[ \t]*(.+)$/gim);
  if (!locationLines || !locationLines.length) return null;
  if (locationLines.length > 1) return locationLines.length;
  const value = locationLines[0].replace(/^[ \t]*location[ \t]*:[ \t]*/i, '').trim();
  if (!value || /not logged/i.test(value)) return null;
  const parts = value.split('/').map((s) => s.trim()).filter(Boolean);
  return parts.length || null;
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

/* ------------------------------ task timing ------------------------------ */

function toMin(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function fromMin(n) {
  return `${pad2(Math.floor(n / 60) % 24)}:${pad2(n % 60)}`;
}

/**
 * A bare clock time inside a work day ("Arrived 1:45", "left 4:23") carries
 * no AM/PM, so it's read as whichever of h or h+12 falls inside the shift
 * window. Explicit AM/PM always wins; with no shift known it stays literal.
 */
function inferClock(raw, ctx) {
  const m = String(raw || '').trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp]\.?[Mm]\.?)?$/);
  if (!m) return null;
  if (m[3]) return normalizeClockTime(raw);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const s = toMin(ctx.shiftStart);
  const e = toMin(ctx.shiftEnd);
  if (s !== null && e !== null && h < 12) {
    const inside = (t) => t >= s - 60 && t <= e + 60;
    const am = h * 60 + min;
    const pm = am + 12 * 60;
    if (!inside(am) && inside(pm)) return fromMin(pm);
  }
  return fromMin(h * 60 + min);
}

/**
 * One side of a "(start - end)" prefix: a clock time, or a word pinned to the
 * day's own logged shift/lunch times — "Beginning", "end shift", "after
 * lunch". These aren't guesses; they only resolve when the day states the
 * time they refer to.
 */
function resolveEndpoint(raw, ctx) {
  const s = String(raw || '').replace(/^(?:return(?:ed)?|back|resumed?|arrived?)\b[\s,:]*/i, '').trim();
  const clock = inferClock(s, ctx);
  if (clock) return clock;
  if (/^(?:the\s+)?(?:beginning|begin|start)(?:\s+of\s+(?:the\s+)?shift)?$|^shift\s+start$/i.test(s)) return ctx.shiftStart || null;
  if (/^(?:the\s+)?end(?:\s+(?:of\s+(?:the\s+)?)?shift)?$|^shift\s+end$|^close$|^finish$/i.test(s)) return ctx.shiftEnd || null;
  if (/^(?:after|post)[\s-]*lunch$/i.test(s)) return ctx.lunchEnd || null;
  if (/^(?:before|pre)[\s-]*lunch$/i.test(s)) return ctx.lunchStart || null;
  return null;
}

const PAREN_RANGE = [
  /^\(\s*(.+?)\s+(?:-|–|—|to)\s+(.+?)\s*\)\s*(.*)$/i,
  /^\(\s*([^()\s]+?)\s*(?:-|–|—)\s*([^()\s]+?)\s*\)\s*(.*)$/,
];
const CLOCK_IN_TEXT = '(\\d{1,2}:\\d{2}(?:\\s*[AaPp]\\.?[Mm]\\.?)?)';
const ARRIVED = new RegExp(`\\barrived?\\s+(?:at\\s+)?${CLOCK_IN_TEXT}[,;]?\\s*`, 'i');
const LEFT = new RegExp(`[,;]?\\s*\\(?\\s*\\b(?:left|leave|departed?)\\s+(?:at\\s+)?${CLOCK_IN_TEXT}\\s*\\)?`, 'i');
const DURATION = /~?\s*(\d+)\s*h(?:ours?|rs?)?\s*(\d+)\s*m(?:in(?:utes)?)?\b|~?\s*(\d+)\s*min(?:utes)?\b/i;

/**
 * Bullet or numbered lines become task blocks. The bullet char and the text
 * needn't have a space between them — real exports are inconsistent
 * ("•REPAIR SPRINKLERS"). A bulleted NOTE line is commentary, and a first
 * bullet like "Patio job" / "Sod day" names the job rather than a task; both
 * stay in the day's notes but never become phases.
 *
 * Each block's time window comes from what the day actually says: a leading
 * "(8:10 - 10:33)" or "(Post lunch - end shift)", "Arrived 1:45" / "left
 * 4:23" markers, and the shift edges for the first and last blocks.
 */
function parseTasks(text, ctx) {
  const bullets = [];
  for (const line of text.split(/\r?\n/)) {
    const b = line.match(/^[ \t]*(?:[•\-*+]|\d+[.)])[ \t]*(.+?)[ \t]*$/);
    if (!b) continue;
    const raw = b[1].trim();
    if (!raw || /^note\b[:\s]/i.test(raw)) continue;
    bullets.push(raw);
  }
  // A title names the job ("Patio job", "Sod day") — a longer bullet that just
  // happens to end in "day" ("Mow and edge lawn all day") is real work.
  let header = '';
  const first = bullets[0] || '';
  const isTitle = /\bjob\s*[.:]?$/i.test(first) || (/\bday\s*[.:]?$/i.test(first) && first.split(/\s+/).length <= 3);
  if (bullets.length > 1 && isTitle) header = bullets.shift();

  const blocks = bullets.map((raw) => {
    let description = raw;
    let start = null;
    let end = null;
    for (const re of PAREN_RANGE) {
      const m = description.match(re);
      if (!m) continue;
      const s = resolveEndpoint(m[1], ctx);
      const e = resolveEndpoint(m[2], ctx);
      if (s && e && m[3].trim()) {
        start = s;
        end = e;
        description = m[3].trim();
      }
      break;
    }
    const arrived = description.match(ARRIVED);
    if (arrived) {
      start = start || inferClock(arrived[1], ctx);
      description = description.replace(ARRIVED, '');
    }
    const left = description.match(LEFT);
    if (left) {
      end = end || inferClock(left[1], ctx);
      description = description.replace(LEFT, '');
    }
    description = description.replace(/^[\s,;:–-]+|[\s,;:–-]+$/g, '').replace(/\s{2,}/g, ' ');
    const d = raw.match(DURATION);
    const durationMinutes = d ? (d[3] ? Number(d[3]) : Number(d[1]) * 60 + Number(d[2])) : null;
    return { raw, description: description || raw, start, end, durationMinutes };
  });

  const labor = blocks.filter((b) => !nonLaborReason(b.raw));
  if (labor.length) {
    const first = labor[0];
    const last = labor[labor.length - 1];
    if (!first.start && first.end && ctx.shiftStart) first.start = ctx.shiftStart;
    if (!last.end && last.start && ctx.shiftEnd) last.end = ctx.shiftEnd;
  }
  return { header, blocks };
}

/** Minutes a non-labor block removes from active time — its stated duration,
 * or its window minus any overlap with lunch (already subtracted). */
function nonLaborMinutes(block, ctx) {
  if (block.durationMinutes) return block.durationMinutes;
  if (!block.start || !block.end) return null;
  const s = toMin(block.start);
  let e = toMin(block.end);
  if (e <= s) e += 24 * 60;
  const ls = toMin(ctx.lunchStart);
  const le = toMin(ctx.lunchEnd);
  const lunchOverlap = ls !== null && le !== null ? Math.max(0, Math.min(e, le) - Math.max(s, ls)) : 0;
  return Math.max(0, e - s - lunchOverlap);
}

/**
 * @param {string} text        extracted plain text
 * @param {object} opts        { filename, fallbackDate }
 * @returns {{patch: object, matched: string[], unmatched: string[], optionalMissing: string[], metReport: object}}
 */
export function parseCalendarLog(text, opts = {}) {
  const body = String(text || '');
  const matched = [];
  const patch = {};
  const noteLines = [];

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
  if (lunch?.outside) {
    matched.push('lunch');
    noteLines.push(`Lunch fell outside the shift window (${lunch.outside}) — nothing subtracted from work time (glossary §6).`);
  } else if (lunch) {
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

  const timeCtx = { shiftStart: patch.shiftStart, shiftEnd: patch.shiftEnd, lunchStart: patch.lunchStart, lunchEnd: patch.lunchEnd };
  const { header, blocks } = parseTasks(body, timeCtx);
  const dayCtx = { feelsLikeF: patch.feelsLikeF ?? null, shade: isShadeDay(body), daySoil: daySoil(body) };
  if (header) noteLines.push(`Job: ${header}`);

  const phases = [];
  let excludedMinutes = 0;
  for (const b of blocks) {
    const c = classifyTask(b.description, dayCtx);
    if (c.nonLabor) {
      const minutes = nonLaborMinutes(b, timeCtx);
      if (minutes === null) {
        noteLines.push(`Non-labor block "${b.description}" (${c.nonLabor}) has no stated duration — enter it under Non-work time.`);
      } else {
        excludedMinutes += minutes;
        noteLines.push(`Excluded ${minutes} min of non-labor time: "${b.description}" (${c.nonLabor}, glossary §6).`);
      }
      continue;
    }
    const timed = Boolean(b.start && b.end);
    const packUpCap = c.packUp && !timed;
    phases.push({
      description: b.description,
      start: timed ? b.start : '',
      end: timed ? b.end : '',
      met: c.met,
      captureCategory: c.captureCategory,
      soilCode: c.soilCode,
      netMinutesOverride: packUpCap ? 10 : '',
      metAuto: true,
      metSource: c.source,
      metConfidence: c.confidence,
      metBasis: packUpCap ? `${c.basis} · pack-up limited to 10 min (§4)` : c.basis,
      metNotes: c.notes,
    });
  }
  if (excludedMinutes) patch.transitMinutes = excludedMinutes;

  const revision = bpmRevisionFromNotes(body);
  if (revision && phases.length) {
    for (const p of phases) {
      const prior = p.met === '' ? 'none' : p.met;
      p.met = revision.met;
      p.metSource = 'bpm-note';
      p.metConfidence = 'high';
      p.metBasis = `BPM-confirmed ${revision.blended ? 'blended day MET' : 'revision'} from the day's note (task-based estimate was ${prior}): "${revision.line}"`;
      p.metNotes = (p.metNotes || []).filter((n) => n.level !== 'warn');
    }
    if (phases.length > 1) {
      noteLines.push(`Day-level MET ${revision.met} from the note applied to all ${phases.length} phases, so the day blends to it exactly${revision.blended ? ' — per-block split in the note needs phase times to map' : ''}.`);
    }
  }

  if (phases.length) {
    patch.phases = phases;
    matched.push('tasks');
  }

  const metReport = {
    phases: phases.length,
    fromNotes: phases.filter((p) => p.metSource === 'bpm-note').length,
    low: phases.filter((p) => p.metSource !== 'bpm-note' && p.metConfidence === 'low').length,
    needsMet: phases.filter((p) => p.met === '').length,
    excludedMinutes,
  };

  const filenameNote = opts.filename ? ` from ${opts.filename}` : '';
  const excerpt = body.trim().slice(0, 4000);
  const unmatched = REQUIRED.filter((k) => !matched.includes(k));
  const optionalMissing = OPTIONAL.filter((k) => !matched.includes(k));
  patch.notes = [
    `Imported${filenameNote}.`,
    unmatched.length ? `Not auto-filled — check/complete manually: ${unmatched.join(', ')}.` : null,
    ...noteLines,
    '',
    '--- original text ---',
    excerpt,
  ]
    .filter((line) => line !== null)
    .join('\n');

  return { patch, matched, unmatched, optionalMissing, metReport };
}

/**
 * Splits one file's text into per-day blocks on a "---" separator line (a
 * line containing only 3+ dashes, optionally padded with spaces). A file
 * with no such line returns the whole text as a single block, so this is
 * safe to run on an ordinary single-day import too.
 */
export function splitDayBlocks(text) {
  return String(text || '')
    .split(/^[ \t]*-{3,}[ \t]*$/m)
    .map((block) => block.trim())
    .filter(Boolean);
}

/**
 * Parses a file that may contain many days separated by "---" lines. Each
 * block is parsed independently with parseCalendarLog (no fallback date —
 * a block with no "Date:" line of its own is reported rather than guessed).
 *
 * @returns {Array<{block: string, patch: object|null, matched: string[], unmatched: string[]}>}
 *   one result per block; `patch` is null for a block with no parseable date.
 */
export function parseMultiDayLog(text, opts = {}) {
  const blocks = splitDayBlocks(text);
  return blocks.map((block) => {
    // "STARTING PAY." / "PAY." all-day entries are payroll, not a work log (glossary §6).
    if (!/^\s*shift\s*:/im.test(block) && /\b(?:starting\s+)?pay\b\.?/i.test(block)) {
      return { block, patch: null, skipped: 'payroll entry', matched: [], unmatched: [] };
    }
    const filename = opts.filename;
    const result = parseCalendarLog(block, { filename });
    if (!result.patch.date) {
      return { block, patch: null, matched: result.matched, unmatched: result.unmatched };
    }
    return { block, ...result };
  });
}
