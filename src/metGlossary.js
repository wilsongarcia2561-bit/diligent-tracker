/**
 * MET glossary — turns a calendar task description into a provisional MET.
 *
 * A direct implementation of MET_GLOSSARY.md (Diligent IV, Sept 22 2026).
 * Section numbers in comments refer to that file. Pure functions, no DOM —
 * tested in tests/metGlossary.test.mjs against real calendar clauses.
 *
 * How a clause is scored:
 *   1. §6 non-labor phrasing ("wrong gravel… return", "lecture") → excluded
 *      from active hours outright, never given a low MET.
 *   2. Collect the activities the clause names: a dig (MET set by §1 soil),
 *      plus each §2/§3 material or tool anchor. Anything the glossary lacks
 *      falls back to the spec §5 task table, then to §4 verbs (§7).
 *   3. Point per activity: the upper end when feels-like ≥ 88°F confirms it
 *      (§5 — heat confirms, never adds), otherwise the midpoint.
 *   4. Several activities in one clause with no per-activity times are
 *      averaged; a dingo clause splits machine/manual evenly (§2).
 *   5. §2/§5 deltas (loaded wheelbarrow, machete, rush, incline…), then the
 *      §9 sanity clamp to 3.5–9.0.
 * BPM-confirmed revisions override all of this — see bpmRevisionFromNotes.
 */

import { suggestMet } from './engine.js';

export const MET_FLOOR = 3.5;
export const MET_CEIL = 9.0;

const LEVEL = { low: 1, medium: 2, high: 3 };
const LEVEL_NAME = { 1: 'low', 2: 'medium', 3: 'high' };

const DIG = /\b(dig|digs|digging|dug|trench\w*|excavat\w*)\b/i;
const PICKAXE = /\bpick\s?axe\b/i;
const MID_SIGNAL = /\bnot\s+entire\b|\bnot\s+(?:the\s+)?small\s+ones\b|\bnot\s+(?:the\s+)?heavy\b[^.]*\bnot\s+small\b/i;
const SHADE = /\bunder\s+(?:tree\s+)?shade\b|\bworking\s+under\b/i;

/** §1 — soil tiers. Higher rank wins: explicit softness beats bare "clay"; any harder word beats softness. */
export const SOIL_TIERS = [
  { code: 'HCP', label: 'Dry hard clay', lo: 8.0, hi: 8.0, rank: 90, re: /\bdry\s+hard\s+clay\b/i },
  { code: 'HCP', label: 'Hard clay + pickaxe', lo: 8.0, hi: 8.5, rank: 85, re: /\b(compacted|rocky|rocks?|foreign\s+debris|pick\s?axe)\b/i },
  { code: 'HC', label: 'Wet clay', lo: 7.5, hi: 7.5, rank: 75, re: /\bwet\s+(?:clay|mix)\b/i },
  { code: 'HC', label: 'Hard clay + gravel', lo: 7.0, hi: 7.5, rank: 70, re: /\b(red\s+clay|north\s+alabama\s+clay|red\s+north\s+alabama|clay\s*(?:\+|&|and)\s*gravel|clay\s*:\s*hard|hard\s+clay)\b/i },
  { code: 'SC', label: 'Soft / cultivated', lo: 4.5, hi: 5.0, rank: 50, re: /\b(soft|cultivated|topsoil|loose\s+dirt|brownish[-\s]red)\b/i },
  { code: 'MC', label: 'Mixed clay', lo: 5.5, hi: 6.5, rank: 40, re: /\bclay\b/i },
];

const MC_DEFAULT = SOIL_TIERS.find((t) => t.code === 'MC');

/**
 * The band a soil class picked from the dropdown stands for. Several tiers
 * share a code (HCP covers "dry hard clay" and "hard clay + pickaxe"), so a
 * hand-picked code maps to its general band rather than whichever tier
 * happens to be listed first. SRW is a block-carry band, not a soil tier.
 */
const SOIL_BY_CODE = {
  SC: SOIL_TIERS.find((t) => t.label === 'Soft / cultivated'),
  MC: MC_DEFAULT,
  HC: SOIL_TIERS.find((t) => t.label === 'Hard clay + gravel'),
  HCP: SOIL_TIERS.find((t) => t.label === 'Hard clay + pickaxe'),
  SRW: { code: 'SRW', label: 'Segmental retaining wall', lo: 9.0, hi: 9.0, rank: 100 },
};

export function classifySoil(text) {
  let best = null;
  for (const tier of SOIL_TIERS) {
    if (tier.re.test(text) && (!best || tier.rank > best.rank)) best = tier;
  }
  return best;
}

/** Strongest soil named anywhere in the day (e.g. a "NOTE: digging clay is…" line), for digs that don't restate it. */
export function daySoil(text) {
  let best = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!/\b(clay|dirt|soil|ground)\b/i.test(line)) continue;
    const tier = classifySoil(line);
    if (tier && (!best || tier.rank > best.rank)) best = tier;
  }
  return best;
}

/**
 * §2/§3 anchors — each names one activity with its MET range. Within a
 * `group` only the first match counts (list order is priority), so "wet sod"
 * supersedes plain sod and an explicit mid-weight block supersedes SRW.
 */
export const ANCHORS = [
  { id: 'srw-block', label: 'SRW block carries', lo: 9.0, hi: 9.0, group: 'block', hauling: true, capture: 'staticForce',
    re: /\b75\s*[-–]\s*78\s*lb|\bhollow\s+core\b|\bheavy\s+duty\s+blocks?\b/i, notIf: /\bnot\s+(?:the\s+)?heavy\b/i },
  { id: 'mid-block', label: 'Retaining-wall block, mid-weight', lo: 6.5, hi: 7.0, group: 'block', hauling: true, capture: 'staticForce',
    re: /\bnot\s+(?:the\s+)?heavy\b[^.]*\bnot\s+small\b|\bnot\s+the\s+small\s+ones\b/i },
  { id: 'block', label: 'Retaining-wall block', lo: 6.5, hi: 7.0, group: 'block', hauling: true, capture: 'staticForce',
    re: /\bblocks?\b/i },
  { id: 'concrete-bags', label: 'Concrete bag carries (80 lb)', lo: 8.0, hi: 8.0, capture: 'staticForce',
    re: /\bconcrete\s+bags?\b|\b\d+\s+bags?\b|\b80\s*lbs?\b/i },
  { id: 'concrete-demo', label: 'Concrete demolition', lo: 8.0, hi: 8.0, capture: 'staticForce',
    re: /\bsledge\s?hammer\w*\b|\b(break\w*|demolish\w*|jackhammer\w*)\b[^.]*\bconcrete\b|\bconcrete\b[^.]*\b(break\w*|demolish\w*)\b/i },
  { id: 'concrete-mix', label: 'Mix concrete (cement + sand)', lo: 6.5, hi: 7.0, noWheelbarrow: true, capture: 'highStep',
    re: /\bmix\w*\b[^.]*\b(cement|concrete)\b|\b(cement|concrete)\b[^.]*\bmix\w*/i },
  { id: 'wet-sod', label: 'Wet sod', lo: 7.5, hi: 8.0, group: 'sod', hauling: true, capture: 'highStep',
    re: /\b(wet|damp\w*)\b[^.]*\bsod\b|\bsod\b[^.]*\b(wet|damp\w*)\b/i },
  { id: 'sod-roller', label: 'Sod roller (loaded drum)', lo: 5.5, hi: 6.5, group: 'sod', capture: 'mixedModerate',
    re: /\b(sod|lawn)\s+roller\b|\broll(?:ed|ing)?\s+over\b[^.]*\bsod\b/i },
  // In a dig clause ("dig out sod edge") sod names the place, not sod being laid.
  { id: 'sod', label: 'Sod lay (dry)', lo: 4.5, hi: 5.0, group: 'sod', hauling: true, notInDig: true, capture: 'mixedModerate',
    re: /\bsod\b|\bzoysia\b|\bbermuda\b/i },
  { id: 'lumber', label: 'Landscape lumber', lo: 7.0, hi: 7.0, hauling: true, capture: 'staticForce',
    re: /\blumber\b|\btimbers?\b/i },
  { id: 'fabric', label: 'Landscape fabric', lo: 4.5, hi: 5.0, capture: 'mixedModerate',
    re: /\bfabric\b/i },
  { id: 'polymer', label: 'Polymer sand joint', lo: 4.5, hi: 5.0, capture: 'detail',
    re: /\bpolymer\w*\s+sand\b|\bsand\s+joints?\b/i },
  { id: 'planting', label: 'Flowerbed peel / planting', lo: 4.5, hi: 5.0, capture: 'mixedModerate',
    re: /\bpeel\b|\bplant(s|ing|ed)?\b/i,
    risk: 'Flowerbed/planting work was BPM-revised to MET 8.0 on Aug 27 — this phrasing is a known under-description risk. Check BPM if available.' },
  { id: 'debris-wood', label: 'Branches / wood / brush hauling', lo: 5.5, hi: 6.0, group: 'debris', hauling: true, capture: 'highStep',
    re: /\b(branch(es)?|logs?|wood|bush(es)?|brush|limbs?)\b/i,
    risk: '"Move cut branches and wood" was BPM-revised to MET 7.5 on Aug 31 — vague debris phrasing is a known under-description risk. Check BPM if available.' },
  { id: 'debris', label: 'Debris / trash hauling', lo: 5.5, hi: 6.0, group: 'debris', hauling: true, capture: 'highStep',
    re: /\b(?<!foreign\s)debris\b|\btrash\b|\bjunk\b/i },
  { id: 'brick-removal', label: 'Brick / paver removal', lo: 6.5, hi: 6.5, group: 'paver', hauling: true, capture: 'digging',
    re: /\b(remov\w*|pull\w*|tear\w*)\b[^.]*\b(brick|paver)s?\b|\b(brick|paver)s?\b[^.]*\bremov\w*/i },
  { id: 'paver-install', label: 'Paver install', lo: 6.5, hi: 7.0, group: 'paver', capture: 'digging',
    re: /\bpaver(s|stones?)?\b|\bflagstone\b|\bflexstone\b/i },
  { id: 'gravel', label: 'Gravel haul / spread', lo: 5.5, hi: 6.5, hauling: true, capture: 'highStep',
    re: /\bgravel\b/i },
  { id: 'dingo', label: 'Dingo / skid steer (machine)', lo: 4.5, hi: 5.5, machine: true, capture: 'detail',
    re: /\bdingo\b|\bskid\s*steer\b/i },
  { id: 'leaf-blower', label: 'Leaf blower', lo: 4.5, hi: 5.0, capture: 'mixedModerate',
    re: /\bleaf\s*blow\w*|\bblower\b/i },
  { id: 'glue', label: 'Glue on wall (finishing)', lo: 3.5, hi: 4.0, tail: true, capture: 'detail',
    re: /\bglue\b|\badhesive\b/i },
  { id: 'maintenance', label: 'Repair / inspect / water', lo: 3.5, hi: 4.0, suppresses: ['sod'], capture: 'detail',
    re: /\b(repair\w*|inspect\w*|water(?:ed|ing)?)\b/i },
];

/** §4 — verb patterns, used only when nothing above (or in the spec table) matched. */
export const VERBS = [
  { id: 'remove', label: 'Remove / demolish / break', lo: 6.5, hi: 8.0, re: /\b(remov\w*|demolish\w*|break\w*|tear\s+out)\b/i, capture: 'digging' },
  { id: 'haul', label: 'Haul / carry / move', lo: 5.5, hi: 6.0, re: /\b(haul\w*|carr(?:y|ied|ying)|mov(?:e|ed|ing)|bring|brought|lift\w*|dump\w*|reorganiz\w*)\b/i, hauling: true, capture: 'highStep' },
  { id: 'install', label: 'Install / implement / lay', lo: 4.5, hi: 5.5, re: /\b(install\w*|implement\w*|lay|laid|laying)\b/i, capture: 'mixedModerate' },
  { id: 'spread', label: 'Spread / level / rake', lo: 4.5, hi: 5.0, re: /\b(spread\w*|level\w*|rak(?:e|ed|ing))\b/i, capture: 'mixedModerate' },
];
const PACK_UP = { id: 'packup', label: 'Pack up (end of shift)', lo: 3.5, hi: 4.5, capture: 'detail' };

/** §6 — phrases that mark a block as non-labor time, excluded from active hours. */
export const NON_LABOR = [
  { re: /\bwrong\s+(?:gravel|material|item|part|stone|mulch|size|block)\b[^.]*\b(return\w*|back)\b/i, reason: 'wrong-item return trip (idle/travel)' },
  { re: /\blectures?\b|\blecture\s+block\b/i, reason: 'lecture (sedentary)' },
  { re: /\bnot\s+active\s+labou?r\b|\bsedentary\b/i, reason: 'sedentary block' },
  { re: /\bidle\b|\bsupply\s+run\b/i, reason: 'idle / travel' },
];

export function nonLaborReason(text) {
  for (const rule of NON_LABOR) if (rule.re.test(text)) return rule.reason;
  return null;
}

const fmt = (n) => (Math.round(n * 100) / 100).toString();
const rangeText = (lo, hi) => (lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`);

/**
 * Score one task clause.
 *
 * @param {string} text  the task description
 * @param {object} ctx   { feelsLikeF, shade, daySoil (tier), soilCode (explicit override) }
 * @returns {{
 *   nonLabor?: string, met: number|'', confidence: 'high'|'medium'|'low',
 *   basis: string, notes: Array<{level:string,text:string}>, soilCode: string,
 *   captureCategory: string, packUp: boolean
 * }}
 */
export function classifyTask(text, ctx = {}) {
  const clause = String(text || '').trim();
  const notes = [];
  if (!clause && !ctx.soilCode) return { met: '', confidence: 'low', basis: '', notes, soilCode: '', captureCategory: '', packUp: false };

  const nonLabor = nonLaborReason(clause);
  if (nonLabor) {
    return { nonLabor, met: '', confidence: 'high', basis: `Non-labor: ${nonLabor} — excluded from active hours (§6)`, notes, soilCode: '', captureCategory: '', packUp: false };
  }

  const feels = ctx.feelsLikeF === '' || ctx.feelsLikeF === null || ctx.feelsLikeF === undefined ? null : Number(ctx.feelsLikeF);
  const shade = Boolean(ctx.shade);
  const heatConfirms = feels !== null && feels >= 88 && !shade;
  const midOnly = MID_SIGNAL.test(clause);
  const pallet = /\bpallets?\b/i.test(clause);

  let confidence = LEVEL.high;
  const lower = (lvl) => { confidence = Math.min(confidence, lvl); };
  const acts = [];
  let soilCode = '';

  // Dig activity — §1 soil sets the MET. Parenthetical soil descriptions feed
  // the soil tier but aren't treated as separate activities (§1 vs §3).
  // A soil class picked by hand says the phase is ground work even when the
  // description doesn't use a dig verb (or is still blank).
  const digContext = DIG.test(clause) || PICKAXE.test(clause) || Boolean(ctx.soilCode);
  if (digContext) {
    const explicit = ctx.soilCode ? SOIL_BY_CODE[ctx.soilCode] || null : null;
    let tier = explicit || classifySoil(clause);
    let source = explicit ? 'soil class selected' : 'clause';
    if (!tier && ctx.daySoil) {
      tier = ctx.daySoil;
      source = 'day note';
      lower(LEVEL.medium);
    }
    let defaulted = false;
    if (!tier) {
      tier = MC_DEFAULT;
      defaulted = true;
      lower(LEVEL.low);
      notes.push({ level: 'warn', text: `"${clause}": soil not stated for a dig — defaulted to MC (5.5–6.5) per glossary §1. Every unstated-soil day BPM has recovered so far came in at HC or higher.` });
    }
    let lo = tier.lo;
    let hi = tier.hi;
    let label = `${tier.code} soil (${tier.label}, ${source})`;
    const deep = /\bfoundation\b|\b\d+(?:\s*[-–]\s*\d+)?\s*(?:inches|inch|in\.?|")\s*(?:deep|down)\b/i.test(clause);
    if (deep && (6.5 + 7.0) / 2 > (lo + hi) / 2) {
      lo = 6.5;
      hi = 7.0;
      label = `Foundation dig (depth given) on ${tier.code} soil`;
    }
    soilCode = tier.code;
    acts.push({ id: 'dig', label, lo, hi, anchored: !defaulted, capture: 'digging' });
  }

  const anchorText = digContext ? clause.replace(/\([^)]*\)/g, ' ') : clause;
  const taken = new Set();
  const suppressed = new Set();
  const matched = ANCHORS.filter((a) => a.re.test(anchorText) && !(a.notIf && a.notIf.test(anchorText)) && !(a.notInDig && digContext));
  for (const a of matched) for (const g of a.suppresses || []) suppressed.add(g);
  let tail = null;
  for (const a of matched) {
    if (a.group && (taken.has(a.group) || suppressed.has(a.group))) continue;
    if (a.group) taken.add(a.group);
    if (a.tail) {
      tail = a;
      continue;
    }
    acts.push({ ...a, anchored: true });
    if (a.risk) {
      lower(LEVEL.low);
      notes.push({ level: 'warn', text: `"${clause}": ${a.risk}` });
    }
  }
  if (tail && !acts.length) acts.push({ ...tail, anchored: true });

  let fromFallback = '';
  if (!acts.length) {
    const spec = suggestMet(clause);
    if (spec) {
      acts.push({ id: `spec-${spec.id}`, label: `${spec.label} (spec §5 table)`, lo: spec.metMin, hi: spec.metMax, anchored: true, capture: spec.capture, hauling: /\b(haul|carry|wheel\s?barrow)/i.test(clause) });
      lower(LEVEL.medium);
      fromFallback = 'spec';
      notes.push({ level: 'info', text: `"${clause}": not in the MET glossary — used the spec §5 task table (${spec.label}, MET ${rangeText(spec.metMin, spec.metMax)}), per glossary §7.` });
    }
  }
  if (!acts.length) {
    const packOnly = /^\s*pack(?:ed|ing)?\s+up\b/i.test(clause);
    const verb = packOnly ? PACK_UP : VERBS.find((v) => v.re.test(clause));
    if (verb) {
      acts.push({ ...verb, anchored: false });
      lower(LEVEL.medium);
      fromFallback = 'verb';
      notes.push({ level: 'info', text: `"${clause}": no soil, tool or material term — verb-only estimate (${verb.label}, MET ${rangeText(verb.lo, verb.hi)}), glossary §4.` });
    }
  }
  if (!acts.length) {
    notes.push({ level: 'warn', text: `"${clause}": no glossary term, spec task or work verb matched — enter a MET by hand (glossary §7: never assign one silently).` });
    return { met: '', confidence: 'low', basis: 'No match — enter by hand', notes, soilCode, captureCategory: '', packUp: false };
  }

  const steps = [];
  const pointOf = (a) => {
    if (a.lo === a.hi) return a.lo;
    const upper = (pallet && a.group === 'sod') || (heatConfirms && a.anchored && !midOnly);
    return upper ? a.hi : (a.lo + a.hi) / 2;
  };
  const describe = (a) => {
    const p = pointOf(a);
    let why = '';
    if (a.lo !== a.hi) {
      if (pallet && a.group === 'sod') why = ' (pallet count → upper end)';
      else if (p === a.hi) why = ' (heat ≥88°F confirms upper end)';
      else if (midOnly) why = ' (mid-range wording → midpoint)';
      else why = ' (midpoint)';
    }
    return `${a.label} ${rangeText(a.lo, a.hi)} → ${fmt(p)}${why}`;
  };

  let met;
  const machine = acts.find((a) => a.machine);
  const manual = acts.filter((a) => !a.machine);
  if (machine && (manual.length || /\b(rake|shovel|by\s+hand|spread)\b/i.test(clause))) {
    const machinePt = pointOf(machine);
    const manualPt = manual.length ? manual.reduce((s, a) => s + pointOf(a), 0) / manual.length : 4.75;
    met = (machinePt + manualPt) / 2;
    lower(LEVEL.medium);
    steps.push(describe(machine));
    if (manual.length) manual.forEach((a) => steps.push(describe(a)));
    else steps.push('manual rake/shovel 4.5–5.0 → 4.75');
    steps.push(`machine/manual split assumed even → ${fmt(met)} (§2 dingo rule)`);
  } else {
    acts.forEach((a) => steps.push(describe(a)));
    met = acts.reduce((s, a) => s + pointOf(a), 0) / acts.length;
    if (acts.length > 1) {
      lower(LEVEL.medium);
      steps.push(`${acts.length} activities, no per-activity times → averaged ${fmt(met)}`);
    }
  }

  const hauling = acts.some((a) => a.hauling);
  if (/\bwheel\s?barrow\b/i.test(clause) && !/\bempty\b|\breturn\s+trip\b/i.test(clause) && hauling && !acts.some((a) => a.noWheelbarrow)) {
    met += 0.75;
    steps.push('loaded wheelbarrow +0.75 (§2)');
  }
  if (PICKAXE.test(clause) && !digContext) {
    met += 0.75;
    steps.push('pickaxe +0.75 (§2)');
  }
  if (/\bmachete\b/i.test(clause) && acts.some((a) => a.group === 'sod')) {
    met += 0.5;
    steps.push('machete edge-cutting +0.5 (§2)');
  }
  if (tail && acts.length && acts[0] !== tail) {
    met -= 0.25;
    steps.push('glue finishing at the tail blends down −0.25 (§2)');
  }
  if (/\b(semi[-\s]?rush|rush(?:ed|ing)?)\b/i.test(clause)) {
    met += 0.5;
    steps.push('rush pace +0.5, weighted lightly (§5 — Sept 5 BPM came in lower)');
  }
  if (/\bsteep\b|\bincline\b/i.test(clause)) {
    met += 1.25;
    steps.push('steep hill / incline +1.25 (§5)');
  }
  if (met < MET_FLOOR || met > MET_CEIL) {
    notes.push({ level: 'warn', text: `"${clause}": computed MET ${fmt(met)} fell outside the glossary's 3.5–9.0 sanity range (§9) and was clamped — check this one.` });
    met = Math.min(MET_CEIL, Math.max(MET_FLOOR, met));
    lower(LEVEL.low);
  }
  if (shade && feels !== null && feels >= 88) steps.push('under shade — heat not treated as confirming (§5)');

  const lead = acts.find((a) => a.capture) || {};
  return {
    met: Math.round(met * 100) / 100,
    confidence: LEVEL_NAME[confidence],
    basis: steps.join(' · '),
    notes,
    soilCode,
    captureCategory: lead.capture || '',
    packUp: acts.length === 1 && acts[0].id === 'packup',
    source: fromFallback || 'glossary',
  };
}

/**
 * BPM-confirmed revisions written into a day's NOTE lines ("revised to MET
 * 7.5", "Revised up to MET 9.0", "Blended MET 7.12 …"). The glossary never
 * overrides these (§ footer), so they win over any task-based estimate.
 */
export function bpmRevisionFromNotes(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!/^\s*(?:[•\-*+]\s*)?note\b/i.test(line)) continue;
    const m = line.match(/\brevised?\s+(?:up|down(?:ward)?)?\s*to\s+(?:MET\s*)?(\d{1,2}(?:\.\d+)?)/i)
      || line.match(/\bblended\s+MET\s*(?:of\s*)?(\d{1,2}(?:\.\d+)?)/i);
    if (!m) continue;
    const value = Number(m[1]);
    if (value >= MET_FLOOR && value <= MET_CEIL + 0.5) {
      const blended = /\bblended\s+MET\b/i.test(m[0]);
      return { met: value, blended, line: line.replace(/^\s*(?:[•\-*+]\s*)?note\s*:?\s*/i, '').trim() };
    }
  }
  return null;
}

export function isShadeDay(text) {
  return SHADE.test(String(text || ''));
}
