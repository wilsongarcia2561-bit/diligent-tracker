/**
 * Diligent IV — static reference data from the spec.
 * Section numbers below refer to "DILIGENT IV — TDEE Methodology & Dataset"
 * (revised Sept 23, 2026) unless marked otherwise.
 */

/** §1–2 — measured BMR. Fixed constant; never recalculated per day. */
export const BMR_KCAL = 1436;

/** §2 — thermic effect of food, ~205–215 kcal (~10% of a ~2,000 kcal baseline intake). */
export const TEF_BASELINE_KCAL = 210;
export const TEF_BASELINE_INTAKE_KCAL = 2000;

/** §8.3 — working assumption when breaks are logged as counts, not timestamps. State it every time. */
export const DEFAULT_BREAK_MINUTES = 10;

/**
 * §5 — heat index at or above this confirms upper-range MET assignments. It
 * does not raise MET on its own, and (since KRI's retirement) no longer
 * changes the model.
 */
export const HEAT_TRIGGER_F = 88;

/** §3.3 — KRI was retired on this date; every day, before or after, is restated under Intermediate. */
export const KRI_RETIRED_ON = '2026-09-03';

/** §1 / §4 — heart-rate baselines used for HRR = (corrected BPM − 49) / 152. */
export const RESTING_HR = 49;
export const MAX_HR = 201;

/** §1 — bodyweight constant, updated only from fasted morning post-bathroom readings. */
export const DEFAULT_WEIGHT_KG = 57.6;

export const SEED_WEIGHT_LOG = [
  { date: '2026-05-20', kg: 56.6, note: 'Baseline' },
  { date: '2026-07-02', kg: 55.7, note: '' },
  { date: '2026-07-23', kg: 57.6, note: 'Confirmed' },
];

/** §2 — post-work NEAT tiers. */
export const NEAT_TIERS = [
  { id: 'light', label: 'Short / light day', min: 70, max: 80, default: 75 },
  { id: 'standard', label: 'Full day', min: 85, max: 100, default: 92 },
  { id: 'heavy', label: 'Heavy day', min: 110, max: 110, default: 110 },
];

/** §2 — background daily life, ~200–300 kcal (lowest-confidence line in the framework). */
export const BACKGROUND_TIERS = [
  { id: 'single', label: 'Single-site day', kcal: 225 },
  { id: 'multi', label: 'Multi-site day (2+ locations)', kcal: 275 },
  { id: 'extreme', label: 'Extreme multi-site (3+ sites, or out-of-state supply run)', kcal: 300 },
];

/** §4 — Samsung Galaxy Watch under-reads force-based labor; corrections are additive. */
export const BPM_CORRECTIONS = [
  { id: 'moderate', label: 'Moderate work', watchMin: 80, watchMax: 120, add: 30, addMax: 30 },
  { id: 'heavy', label: 'Heavy work — HC/HCP/SRW', watchMin: 120, watchMax: 155, add: 35, addMax: 35 },
  { id: 'near-max', label: 'Near-max effort', watchMin: 155, watchMax: 172, add: 35, addMax: 50 },
];

/** §4 — HRR% → approximate MET reference. */
export const HRR_MET_TABLE = [
  { hrrMin: 0.35, hrrMax: 0.45, metMin: 4.5, metMax: 5.5 },
  { hrrMin: 0.45, hrrMax: 0.55, metMin: 5.5, metMax: 6.5 },
  { hrrMin: 0.55, hrrMax: 0.65, metMin: 6.5, metMax: 7.5 },
  { hrrMin: 0.65, hrrMax: 0.75, metMin: 7.5, metMax: 8.5 },
  { hrrMin: 0.75, hrrMax: 0.85, metMin: 8.5, metMax: 9.5 },
  { hrrMin: 0.85, hrrMax: 0.95, metMin: 9.5, metMax: 12.0 },
];

/** §7 — expected Samsung capture rate (active min ÷ net work min) by task type. */
export const CAPTURE_CATEGORIES = {
  highStep: { label: 'High-step (mulch throw, wheelbarrow)', min: 0.75, max: 0.85 },
  mixedModerate: { label: 'Mixed moderate (sod, pine straw, mixed tasks)', min: 0.65, max: 0.8 },
  digging: { label: 'HC/HCP digging', min: 0.55, max: 0.65 },
  staticForce: { label: 'SRW / static force work', min: 0.46, max: 0.6 },
  detail: { label: 'Fixture / cable / light detail work', min: 0.0, max: 0.5 },
};

/** §5 — soil / task classification codes. */
export const SOIL_CLASSES = [
  {
    code: 'SC',
    name: 'Soft / Cultivated',
    description: 'Loose topsoil, garden beds, compost',
    metMin: 4.5,
    metMax: 5.0,
  },
  {
    code: 'MC',
    name: 'Mixed Clay Moderate',
    description: 'Standard mixed soil, moderate resistance',
    metMin: 5.5,
    metMax: 6.5,
  },
  {
    code: 'HC',
    name: 'Hard Clay + Gravel',
    description: 'North Alabama red clay, standard digging',
    metMin: 7.0,
    metMax: 7.5,
  },
  {
    code: 'HCP',
    name: 'Hard Clay + Pickaxe',
    description: 'Heavily compacted, rocky, requires pickaxe',
    metMin: 8.0,
    metMax: 8.5,
  },
  {
    code: 'SRW',
    name: 'Segmental Retaining Wall',
    description: '75–78 lb block manual carries to height',
    metMin: 9.0,
    metMax: 9.0,
  },
];

/**
 * §5 — "Other Tasks" MET table, plus keywords used for auto-suggestion (feature §12.2).
 * `capture` maps the task to its expected Samsung capture-rate band (§7).
 */
export const TASK_METS = [
  {
    id: 'mulch-throw',
    label: 'Mulch — hand throw + wheelbarrow',
    metMin: 5.0,
    metMax: 5.5,
    capture: 'highStep',
    keywords: ['mulch throw', 'hand throw', 'mulch', 'wheelbarrow mulch'],
  },
  {
    id: 'sod-lay',
    label: 'Sod laying + roller',
    metMin: 4.5,
    metMax: 5.0,
    capture: 'mixedModerate',
    keywords: ['sod lay', 'sod', 'roller', 'sod install'],
  },
  {
    id: 'wet-sod-barrow',
    label: 'Wet sod wheelbarrow (loaded)',
    metMin: 7.5,
    metMax: 8.0,
    capture: 'highStep',
    keywords: ['wet sod', 'loaded wheelbarrow', 'wet sod wheelbarrow'],
  },
  {
    id: 'pine-straw',
    label: 'Pine straw spreading + raking',
    metMin: 4.5,
    metMax: 5.0,
    capture: 'mixedModerate',
    keywords: ['pine straw', 'pinestraw', 'straw spread', 'raking'],
  },
  {
    id: 'gravel-shovel',
    label: 'Gravel / mulch shoveling',
    metMin: 5.5,
    metMax: 6.5,
    capture: 'mixedModerate',
    keywords: ['shovel', 'shoveling', 'gravel shovel', 'mulch shovel', 'gravel', 'haul gravel', 'gravel haul'],
  },
  {
    id: 'concrete-bags',
    label: 'Concrete bag carries (80 lbs)',
    metMin: 8.0,
    metMax: 8.0,
    capture: 'staticForce',
    keywords: ['concrete bag', 'bag carry', 'concrete carries', '80 lb'],
  },
  {
    id: 'wet-concrete',
    label: 'Wet concrete wheelbarrow haul + pour',
    metMin: 8.0,
    metMax: 9.0,
    capture: 'highStep',
    keywords: ['wet concrete', 'concrete pour', 'pour', 'concrete haul'],
  },
  {
    id: 'foundation-dig',
    label: 'Foundation digging (pre-softened)',
    metMin: 6.5,
    metMax: 7.0,
    capture: 'digging',
    keywords: ['foundation dig', 'pre-softened', 'footing dig'],
  },
  {
    id: 'paver-install',
    label: 'Compacted gravel base + paver install',
    metMin: 6.5,
    metMax: 7.0,
    capture: 'digging',
    keywords: ['paver', 'gravel base', 'compacted base', 'patio'],
  },
  {
    id: 'srw-cap',
    label: 'SRW cap layer (lighter blocks, rushing pace)',
    metMin: 7.5,
    metMax: 7.5,
    capture: 'staticForce',
    keywords: ['srw cap', 'cap layer', 'cap block'],
  },
  {
    id: 'wall-prep',
    label: 'Retaining wall foundation prep',
    metMin: 6.5,
    metMax: 6.5,
    capture: 'digging',
    keywords: ['wall foundation', 'retaining wall prep', 'wall prep'],
  },
  {
    id: 'estate-cleanup',
    label: 'Light estate cleanup / leaf blow',
    metMin: 4.5,
    metMax: 5.0,
    capture: 'mixedModerate',
    keywords: ['estate cleanup', 'leaf blow', 'blower', 'cleanup'],
  },
  {
    id: 'trimming',
    label: 'Trimming / weed cleanup',
    metMin: 4.5,
    metMax: 5.0,
    capture: 'mixedModerate',
    keywords: ['trim', 'trimming', 'weed', 'weeding', 'edging'],
  },
  {
    id: 'plant-carry',
    label: 'Plant carrying / placement (light)',
    metMin: 3.0,
    metMax: 3.5,
    capture: 'mixedModerate',
    keywords: ['plant carry', 'plant placement', 'planting', 'shrub'],
  },
  {
    id: 'sprinkler',
    label: 'Sprinkler repair / inspection',
    metMin: 3.5,
    metMax: 4.5,
    capture: 'detail',
    keywords: ['sprinkler', 'irrigation', 'head repair'],
  },
  {
    id: 'trench-dig',
    label: 'Trench digging (compacted base, under concrete)',
    metMin: 6.5,
    metMax: 6.5,
    capture: 'digging',
    keywords: ['trench', 'trenching', 'under concrete'],
  },
  {
    id: 'lighting',
    label: 'Landscape lighting / cable work',
    metMin: 4.0,
    metMax: 4.0,
    capture: 'detail',
    keywords: ['lighting', 'cable', 'low voltage', 'wire'],
  },
];

/** Soil classes also participate in keyword matching. */
export const SOIL_KEYWORDS = {
  SC: ['topsoil', 'garden bed', 'compost', 'soft soil', 'cultivated'],
  MC: ['mixed clay', 'mixed soil', 'moderate soil'],
  HC: ['hard clay', 'red clay', 'clay and gravel', 'hard dig'],
  // "hard clay" is genuinely part of HCP's description too — pairing it with a
  // pickaxe mention is what distinguishes HCP from plain HC.
  HCP: ['pickaxe', 'pick axe', 'hard clay', 'compacted rocky', 'rocky'],
  SRW: ['srw', 'retaining wall block', 'block carry', 'segmental'],
};

/** Carried into the UI as standing disclaimers. */
export const KNOWN_LIMITATIONS = [
  'MET values are population averages with real individual variance. This framework should never claim single-day precision better than roughly ±300–500 kcal.',
  'BPM correction factors (+30 / +35) are derived from a small number of manual pulse checks, not a validated device. Treat HRR-derived MET as directional confirmation, not ground truth.',
  'Samsung "Total burned calories" is not TDEE. Never reference it.',
  'Background and NEAT lines are lower-confidence estimates and are visually distinguished from the active-kcal calculation throughout this app.',
  'The ~1,950 kcal non-work / university day is still unvalidated — it needs a full uni-day HR export paired with that day\'s step count.',
  'Body composition from the Oxiline BIA scale is low-confidence (hydration-sensitive) even with function restored. A DEXA scan is the recommended ground truth.',
];

export const OUT_OF_SCOPE = [
  'Diagnostic health claims or medical advice',
  'Automatic weight-loss / weight-gain recommendations without user-confirmed goals',
  'Any feature that discourages eating enough on high-TDEE days',
];

export const DAY_UNCERTAINTY_KCAL = { min: 300, max: 500 };

/**
 * §7 — university / non-work days. No task or soil to classify and no
 * separate background bucket: BMR + walking + general-day NEAT + TEF.
 * 8–9k steps is ~1.4 hr of walking, i.e. ~6,070 steps per hour.
 */
export const NON_WORK_DAY = {
  walkingMet: 3.3,
  defaultSteps: 8500,
  stepsPerHour: 8500 / 1.4,
  neatKcal: 95,
  tefKcal: 200,
  expectedTotal: 1950,
};

/**
 * §6 — the hand-computed Intermediate dataset (post-KRI-retirement figures).
 * Used to reconcile days the app computes against the document of record.
 */
export const DATASET_IV = [
  { date: '2026-08-12', task: 'HC trench/drain, fabric, river rock', met: 7.5, hours: 4.8, tdee: 3655 },
  { date: '2026-08-13', task: 'Drain trench, sod compact, brief concrete mix', met: 7.0, hours: 5.2, tdee: 3793 },
  { date: '2026-08-14', task: 'Mulch, 11 yd handthrown + leaf blow', met: 5.5, hours: 3.77, tdee: 2958 },
  { date: '2026-08-17', task: 'HCP compacted clay, drain pipe, 5 bags concrete, 111°F', met: 9.0, hours: 6.02, tdee: 4785, note: 'Revised up from the HCP baseline on sustained corrected 190s–200s.' },
  { date: '2026-08-19', task: 'Dirt haul, 9 ft drainpipe dig, gravel haul, estate leaf blow', met: 6.4, hours: 6.3, tdee: 4086, note: 'Titled "half." with a broken start_time; HR recovered a ~7:15 AM start. Not a half day.' },
  { date: '2026-08-21', task: 'Gravel removal + fabric + regravel; slab edge removal', met: 6.1, hours: 2.8, tdee: 2791 },
  { date: '2026-08-24', task: 'Material reorganization — pavers, stone edge, gravel, SRW block', met: 5.5, hours: 9.4, tdee: 4439, note: 'Titled "half." with a 1:12 AM start_time; HR recovered a ~7:30 AM start. Not a half day.' },
  { date: '2026-08-25', task: 'Flexstone patio — sand + cement via wheelbarrow', met: 7.0, hours: 2.8, tdee: 2938 },
  { date: '2026-08-27', task: 'Sod; flowerbed peel + gravel + planting; polymer sand + pack-up', met: 6.64, hours: 3.98, tdee: 3279, note: 'Flowerbed task revised 5.0 → 8.0 on corrected 195–215.' },
  { date: '2026-08-28', task: '"half." — no description logged', met: null, hours: null, tdee: null, note: 'Unusable: no task description.' },
  { date: '2026-08-31', task: 'Move cut branches and wood to front yard, 102°F', met: 7.5, hours: 3.7, tdee: 3381, note: 'Revised from 5.5 / 2.8 hr on HR: +619 kcal against the task-only estimate.' },
  { date: '2026-09-01', task: 'Landscape lumber install, carry old pieces up steep hill, pack-up', met: 7.0, hours: 3.8, tdee: 3309 },
  { date: '2026-09-02', task: 'Brick patio removal + haul · uni lecture · backyard debris haul', met: 6.5, hours: 4.07, tdee: 3285, note: 'Hybrid day: lecture block segmented out.' },
  { date: '2026-09-03', task: 'Trench dig, debris haul, gravel wheelbarrow, sledgehammer pad · 105°F', met: 7.0, hours: 2.1, tdee: 2712 },
  { date: '2026-09-04', task: 'No description — reconstructed from HR', met: 6.0, hours: 7.07, tdee: 4032, note: 'Salvaged, not recovered.' },
  { date: '2026-09-05', task: 'Paver stone placement, semi-rush · 106°F', met: 6.0, hours: 6.1, tdee: 3753, note: 'First downward revision (7.5 → 6.0).' },
  { date: '2026-09-08', task: 'Patio continuation, backyard → driveway sidewalk · 105°F', met: 7.0, hours: 3.17, tdee: 3082 },
  { date: '2026-09-09', task: '3 pallets Zoysia sod — wheelbarrow haul + lay, 6 sprinkler heads', met: 7.0, hours: 3.5, tdee: 3196, note: 'Revised up 6.0 → 7.0.' },
  { date: '2026-09-10', task: '6–7 yd mulch wheelbarrow + rake flat', met: 5.5, hours: 1.17, tdee: 2274, note: '3 breaks against a 100-min shift — the break default is load-bearing.' },
];
