/**
 * Diligent III — static reference data from the spec.
 * Section numbers below refer to the "Diligent III — TDEE Tracking Framework Spec".
 */

/** §2 — measured BMR from Oxiline Scale MD Pro. Fixed; do not recalculate from Mifflin-St Jeor. */
export const BMR_KCAL = 1436;

/** §10 — thermic effect of food, ~10% of a ~2,000 kcal baseline intake. */
export const TEF_BASELINE_KCAL = 210;
export const TEF_BASELINE_INTAKE_KCAL = 2000;

/** §8 — user-confirmed average break length when exact timestamps aren't logged. */
export const DEFAULT_BREAK_MINUTES = 11;

/** §3 — heat trigger threshold, applied to feels-like / heat index, not raw temperature. */
export const HEAT_TRIGGER_F = 88;

/** §3 — MET at or above which KRI is used regardless of heat. */
export const KRI_MET_THRESHOLD = 6.5;

/** §6 — heart rate baselines. */
export const RESTING_HR = 49;
export const MAX_HR = 201;

/** §4 — bodyweight constant, updated only from fasted morning post-bathroom readings. */
export const DEFAULT_WEIGHT_KG = 57.6;

export const SEED_WEIGHT_LOG = [
  { date: '2026-05-20', kg: 56.6, note: 'Baseline' },
  { date: '2026-07-02', kg: 55.7, note: '' },
  { date: '2026-07-23', kg: 57.6, note: 'Confirmed' },
];

/** §9 — post-work NEAT tiers. */
export const NEAT_TIERS = [
  { id: 'light', label: 'Short / light day', min: 70, max: 80, default: 75 },
  { id: 'standard', label: 'Full standard day', min: 85, max: 100, default: 92 },
  { id: 'heavy', label: 'Heavy / high-heat day', min: 100, max: 110, default: 105 },
];

/** §11 — background daily life tiers (lowest-confidence line in the framework). */
export const BACKGROUND_TIERS = [
  { id: 'single', label: 'Single-site day', kcal: 225 },
  { id: 'multi', label: 'Multi-site day (2+ locations)', kcal: 275 },
  { id: 'extreme', label: 'Extreme multi-site (3+ sites, or out-of-state supply run)', kcal: 300 },
];

/** §6 — Samsung Galaxy Watch under-reads force-based labor; corrections are additive. */
export const BPM_CORRECTIONS = [
  { id: 'moderate', label: 'Moderate work', watchMin: 80, watchMax: 120, add: 30, addMax: 30 },
  { id: 'heavy', label: 'Heavy work — HC/HCP/SRW', watchMin: 120, watchMax: 155, add: 35, addMax: 35 },
  { id: 'near-max', label: 'Near-max effort', watchMin: 155, watchMax: 172, add: 35, addMax: 50 },
];

/** §6 — HRR% → approximate MET reference. */
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

/**
 * §5 — soil / task classification codes. HC, HCP and SRW are KRI triggers on their own.
 */
export const SOIL_CLASSES = [
  {
    code: 'SC',
    name: 'Soft / Cultivated',
    description: 'Loose topsoil, garden beds, compost',
    metMin: 4.5,
    metMax: 5.0,
    kriTrigger: false,
  },
  {
    code: 'MC',
    name: 'Mixed Clay Moderate',
    description: 'Standard mixed soil, moderate resistance',
    metMin: 5.5,
    metMax: 6.5,
    kriTrigger: false,
  },
  {
    code: 'HC',
    name: 'Hard Clay + Gravel',
    description: 'North Alabama red clay, standard digging',
    metMin: 7.0,
    metMax: 7.5,
    kriTrigger: true,
  },
  {
    code: 'HCP',
    name: 'Hard Clay + Pickaxe',
    description: 'Heavily compacted, rocky, requires pickaxe',
    metMin: 8.0,
    metMax: 8.5,
    kriTrigger: true,
  },
  {
    code: 'SRW',
    name: 'Segmental Retaining Wall',
    description: '75–78 lb block manual carries to height',
    metMin: 9.0,
    metMax: 9.0,
    kriTrigger: true,
  },
];

export const KRI_SOIL_CODES = SOIL_CLASSES.filter((s) => s.kriTrigger).map((s) => s.code);

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
    keywords: ['shovel', 'shoveling', 'gravel shovel', 'mulch shovel'],
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

/** §13 — carried into the UI as standing disclaimers. */
export const KNOWN_LIMITATIONS = [
  'MET values are population averages with real individual variance. This framework should never claim single-day precision better than roughly ±300–500 kcal.',
  'BPM correction factors (+30 / +35) are derived from a small number of manual pulse checks, not a validated device. Treat HRR-derived MET as directional confirmation, not ground truth.',
  'Background and NEAT lines are lower-confidence estimates and are visually distinguished from the active-kcal calculation throughout this app.',
  'Body composition (BF%, LBM) is not reliably tracked — Scale MD Pro trunk/arm electrodes are non-functional, and the foot-electrode scale is only reliable for legs and total weight. A DEXA scan is recommended as ground truth when available.',
];

export const OUT_OF_SCOPE = [
  'Diagnostic health claims or medical advice',
  'Automatic weight-loss / weight-gain recommendations without user-confirmed goals',
  'Any feature that discourages eating enough on high-TDEE days',
];

export const DAY_UNCERTAINTY_KCAL = { min: 300, max: 500 };
