/**
 * Minimal hand-rolled SVG charts — no charting library, no network fetches.
 */

const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function niceBounds(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (min === max) return { min: min - 1, max: max + 1 };
  const pad = (max - min) * 0.12;
  return { min: min - pad, max: max + pad };
}

/**
 * @param {Array<{name:string,points:Array<{date:string,value:number}>,color:string,dashed?:boolean,dots?:boolean}>} series
 */
export function lineChart(series, { height = 260, yLabel = '', valueFormat = (v) => Math.round(v) } = {}) {
  const width = 720;
  const pad = { top: 16, right: 16, bottom: 34, left: 56 };
  const svg = el('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'chart',
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': yLabel || 'chart',
  });

  const all = series.flatMap((s) => s.points);
  if (!all.length) {
    svg.appendChild(el('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'chart-empty' }, 'No data yet'));
    return svg;
  }

  const dates = [...new Set(all.map((p) => p.date))].sort();
  const xIndex = new Map(dates.map((d, i) => [d, i]));
  const bounds = niceBounds(Math.min(...all.map((p) => p.value)), Math.max(...all.map((p) => p.value)));

  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const x = (date) => pad.left + (dates.length === 1 ? plotW / 2 : (xIndex.get(date) / (dates.length - 1)) * plotW);
  const y = (value) => pad.top + plotH - ((value - bounds.min) / (bounds.max - bounds.min)) * plotH;

  // Gridlines + y axis labels
  const ticks = 4;
  for (let i = 0; i <= ticks; i += 1) {
    const value = bounds.min + ((bounds.max - bounds.min) * i) / ticks;
    const yy = y(value);
    svg.appendChild(el('line', { x1: pad.left, x2: width - pad.right, y1: yy, y2: yy, class: 'chart-grid' }));
    svg.appendChild(el('text', { x: pad.left - 8, y: yy + 4, 'text-anchor': 'end', class: 'chart-tick' }, valueFormat(value)));
  }

  // X axis labels — first, middle, last
  const labelIdx = dates.length <= 2 ? dates.map((_, i) => i) : [0, Math.floor((dates.length - 1) / 2), dates.length - 1];
  for (const i of [...new Set(labelIdx)]) {
    svg.appendChild(
      el('text', { x: x(dates[i]), y: height - 10, 'text-anchor': 'middle', class: 'chart-tick' }, dates[i].slice(5)),
    );
  }

  for (const s of series) {
    const pts = [...s.points].sort((a, b) => a.date.localeCompare(b.date));
    if (!pts.length) continue;
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.date).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    svg.appendChild(
      el('path', {
        d,
        fill: 'none',
        stroke: s.color,
        'stroke-width': s.dashed ? 2 : 2.5,
        'stroke-dasharray': s.dashed ? '6 5' : null,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      }),
    );
    if (s.dots !== false) {
      for (const p of pts) {
        const dot = el('circle', {
          cx: x(p.date),
          cy: y(p.value),
          r: p.restDay ? 5 : 3.5,
          fill: p.restDay ? 'var(--surface)' : s.color,
          stroke: s.color,
          'stroke-width': 2,
        });
        dot.appendChild(el('title', {}, `${p.date}: ${valueFormat(p.value)}${p.restDay ? ' (rest day)' : ''}`));
        svg.appendChild(dot);
      }
    }
  }

  return svg;
}

export function barChart(bars, { height = 200, valueFormat = (v) => Math.round(v) } = {}) {
  const width = 720;
  const pad = { top: 16, right: 16, bottom: 40, left: 56 };
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart', preserveAspectRatio: 'none' });
  const usable = bars.filter((b) => Number.isFinite(b.value));
  if (!usable.length) {
    svg.appendChild(el('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'chart-empty' }, 'No data yet'));
    return svg;
  }
  const max = Math.max(...usable.map((b) => b.value)) * 1.15;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const slot = plotW / usable.length;
  const barW = Math.min(120, slot * 0.55);

  usable.forEach((b, i) => {
    const h = (b.value / max) * plotH;
    const cx = pad.left + slot * i + slot / 2;
    svg.appendChild(
      el('rect', {
        x: cx - barW / 2,
        y: pad.top + plotH - h,
        width: barW,
        height: Math.max(1, h),
        rx: 4,
        fill: b.color || 'var(--accent)',
      }),
    );
    svg.appendChild(
      el('text', { x: cx, y: pad.top + plotH - h - 6, 'text-anchor': 'middle', class: 'chart-value' }, valueFormat(b.value)),
    );
    svg.appendChild(el('text', { x: cx, y: height - 20, 'text-anchor': 'middle', class: 'chart-tick' }, b.label));
    if (b.sub) {
      svg.appendChild(el('text', { x: cx, y: height - 6, 'text-anchor': 'middle', class: 'chart-tick dim' }, b.sub));
    }
  });

  svg.appendChild(
    el('line', { x1: pad.left, x2: width - pad.right, y1: pad.top + plotH, y2: pad.top + plotH, class: 'chart-grid' }),
  );
  return svg;
}

/** Horizontal stacked bar for the TDEE component breakdown. */
export function stackedBar(segments, { height = 46 } = {}) {
  const width = 720;
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart stack', preserveAspectRatio: 'none' });
  const total = segments.reduce((s, seg) => s + Math.max(0, seg.value), 0);
  if (total <= 0) return svg;
  let x = 0;
  for (const seg of segments) {
    const w = (Math.max(0, seg.value) / total) * width;
    const rect = el('rect', {
      x,
      y: 8,
      width: Math.max(0, w - 2),
      height: height - 16,
      rx: 3,
      fill: seg.color,
      opacity: seg.estimate ? 0.55 : 1,
      stroke: seg.estimate ? seg.color : null,
      'stroke-dasharray': seg.estimate ? '4 3' : null,
      'stroke-width': seg.estimate ? 1.5 : null,
    });
    rect.appendChild(el('title', {}, `${seg.label}: ${Math.round(seg.value)} kcal${seg.estimate ? ' (lower-confidence estimate)' : ''}`));
    svg.appendChild(rect);
    if (w > 46) {
      svg.appendChild(
        el('text', { x: x + w / 2 - 1, y: height / 2 + 4, 'text-anchor': 'middle', class: 'stack-label' }, Math.round(seg.value)),
      );
    }
    x += w;
  }
  return svg;
}
