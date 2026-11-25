/**
 * The four palettes. Each is six colors: base, card, text, work, rest and
 * line (the chart line). Work and rest get one color each and nothing else
 * uses them. styles.css carries the same values as CSS tokens; this list
 * feeds the picker in Settings, which paints each option in its own colors.
 */

export const PALETTES = [
  {
    id: 'clay',
    name: 'Clay & Slate',
    tag: 'Warm · Dark',
    blurb: 'Warm charcoal with terracotta for work and slate blue for rest. Feels like the materials on a hardscape job.',
    colors: { base: '#12100e', card: '#1c1916', text: '#f3ede5', work: '#e5764a', rest: '#9cbbdc', line: '#f0c987' },
  },
  {
    id: 'ember',
    name: 'Ember & Glacier',
    tag: 'Cool · Dark',
    blurb: 'Near-black navy with a neutral line. Only work (orange) and rest (blue) get color, so they stand out most.',
    colors: { base: '#0a0c11', card: '#121621', text: '#eef2f8', work: '#ff8a3d', rest: '#5b8de6', line: '#eef2f8' },
  },
  {
    id: 'moss',
    name: 'Moss & Sandstone',
    tag: 'Earth · Dark',
    blurb: 'Olive-black with sandstone gold for work and moss for rest. Calm, low glare, good at night.',
    colors: { base: '#0f120e', card: '#171b15', text: '#eceee2', work: '#dcb96e', rest: '#7aa585', line: '#e9dcc0' },
  },
  {
    id: 'field',
    name: 'Field',
    tag: 'Daylight · Light',
    blurb: 'Paper and ink, for logging outside in direct sun where dark screens wash out. Burnt orange for work, blue for rest.',
    colors: { base: '#f3f0e9', card: '#ffffff', text: '#1d1b18', work: '#8f3a10', rest: '#3d78c2', line: '#1d1b18' },
  },
];

export const SWATCH_ORDER = ['base', 'card', 'text', 'work', 'rest', 'line'];

const IDS = new Set(PALETTES.map((p) => p.id));

/** A saved choice, or 'auto' (Field in light mode, Clay & Slate in dark). */
export const paletteId = (value) => (IDS.has(value) ? value : 'auto');

let shiftTimer = null;

/**
 * Paint the app in a palette. With `animate`, every surface cross-fades to
 * the new colors instead of snapping.
 */
export function applyPalette(value, { animate = false } = {}) {
  const root = document.documentElement;
  const id = paletteId(value);
  const current = root.dataset.palette || 'auto';
  if (current === id) return;
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (animate && !still) {
    root.classList.add('palette-shift');
    clearTimeout(shiftTimer);
    shiftTimer = setTimeout(() => root.classList.remove('palette-shift'), 700);
  }
  if (id === 'auto') delete root.dataset.palette;
  else root.dataset.palette = id;
}
