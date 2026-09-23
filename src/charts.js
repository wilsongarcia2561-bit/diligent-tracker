/**
 * Hand-rolled SVG charts — no charting library, no network fetches.
 *
 * Each chart draws at the host's real pixel width (not a stretched viewBox),
 * so mono labels keep their shape; callers redraw on resize via observeWidth.
 */

const NS = 'http://www.w3.org/2000/svg';
const DAY_MS = 86400000;
let gradientSeq = 0;

function el(name, attrs = {}, text) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function toTime(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function shortDate(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

const fmt = (v) => Math.round(v).toLocaleString();

/** Round an axis to 1/2/2.5/5 × 10^n steps so every tick lands on a clean number. */
export function niceScale(min, max, ticks = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0, hi: 1, step: 1 };
  if (min === max) {
    min -= 100;
    max += 100;
  }
  const raw = (max - min) / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return { lo: Math.floor(min / step) * step, hi: Math.ceil(max / step) * step, step };
}

/** Redraw `draw` whenever `host` changes width. */
export function observeWidth(host, draw) {
  let last = 0;
  const run = () => {
    const w = Math.round(host.clientWidth);
    if (w && w !== last) {
      last = w;
      draw(w);
    }
  };
  run();
  if (typeof ResizeObserver === 'undefined') return;
  // Views are replaced wholesale on every tab/range change; drop the observer
  // once its chart leaves the page so old charts don't pile up in memory.
  const ro = new ResizeObserver(() => (host.isConnected ? run() : ro.disconnect()));
  ro.observe(host);
}

/**
 * Daily TDEE as a filled area with the rolling average dashed over it, on a
 * true time axis (a logging gap shows as a gap, not a squeezed neighbour).
 * Hovering snaps a crosshair to the nearest day.
 */
export function areaChart(host, points, rolling, { height = 300 } = {}) {
  observeWidth(host, (width) => {
    host.replaceChildren();
    if (!points.length) {
      const empty = document.createElement('div');
      empty.className = 'chart-empty';
      empty.textContent = 'No days logged in this range';
      host.append(empty);
      return;
    }

    const pad = { top: 10, right: 56, bottom: 30, left: 2 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    let t0 = toTime(points[0].date);
    let t1 = toTime(points[points.length - 1].date);
    if (t0 === t1) {
      t0 -= DAY_MS;
      t1 += DAY_MS;
    }
    const values = [...points.map((p) => p.value), ...rolling.map((p) => p.value)];
    const { lo, hi, step } = niceScale(Math.min(...values), Math.max(...values), 4);
    const x = (iso) => pad.left + ((toTime(iso) - t0) / (t1 - t0)) * plotW;
    const y = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * plotH;

    const svg = el('svg', { width, height, class: 'chart', role: 'img', 'aria-label': 'Daily TDEE over time' });
    const gid = `area-grad-${(gradientSeq += 1)}`;
    const defs = el('defs');
    const grad = el('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.append(
      el('stop', { offset: '0%', 'stop-color': 'var(--green)', 'stop-opacity': 0.28 }),
      el('stop', { offset: '100%', 'stop-color': 'var(--green)', 'stop-opacity': 0 }),
    );
    defs.append(grad);
    svg.append(defs);

    for (let v = lo; v <= hi + 1e-9; v += step) {
      const yy = y(v);
      svg.append(el('line', { x1: pad.left, x2: pad.left + plotW, y1: yy, y2: yy, class: 'grid' }));
      svg.append(el('text', { x: width - 2, y: yy + 4, 'text-anchor': 'end', class: 'tick' }, fmt(v)));
    }

    const labelCount = Math.max(2, Math.min(6, Math.floor(plotW / 110)));
    for (let i = 0; i < labelCount; i += 1) {
      const t = t0 + ((t1 - t0) * i) / (labelCount - 1);
      const iso = new Date(t).toISOString().slice(0, 10);
      const anchor = i === 0 ? 'start' : i === labelCount - 1 ? 'end' : 'middle';
      svg.append(el('text', { x: pad.left + (plotW * i) / (labelCount - 1), y: height - 8, 'text-anchor': anchor, class: 'tick' }, shortDate(iso)));
    }

    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
    const base = pad.top + plotH;
    svg.append(el('path', { d: `${line}L${x(points.at(-1).date).toFixed(1)},${base}L${x(points[0].date).toFixed(1)},${base}Z`, fill: `url(#${gid})` }));
    if (rolling.length > 1) {
      const roll = rolling.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
      svg.append(el('path', { d: roll, class: 'roll-line', fill: 'none' }));
    }
    svg.append(el('path', { d: line, class: 'area-line', fill: 'none' }));
    const last = points.at(-1);
    svg.append(el('circle', { cx: x(last.date), cy: y(last.value), r: 3.5, class: 'end-dot' }));

    const cross = el('line', { y1: pad.top, y2: base, class: 'crosshair', visibility: 'hidden' });
    const dot = el('circle', { r: 4.5, class: 'hover-dot', visibility: 'hidden' });
    svg.append(cross, dot);
    host.append(svg);

    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    host.append(tip);

    const rollingByDate = new Map(rolling.map((p) => [p.date, p.value]));
    const xs = points.map((p) => x(p.date));
    const hide = () => {
      cross.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    };
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('pointermove', (e) => {
      const px = e.clientX - svg.getBoundingClientRect().left;
      let best = 0;
      for (let i = 1; i < xs.length; i += 1) if (Math.abs(xs[i] - px) < Math.abs(xs[best] - px)) best = i;
      const p = points[best];
      const cx = xs[best];
      const cy = y(p.value);
      cross.setAttribute('x1', cx);
      cross.setAttribute('x2', cx);
      cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', cx);
      dot.setAttribute('cy', cy);
      dot.setAttribute('visibility', 'visible');
      const avg = rollingByDate.get(p.date);
      tip.innerHTML = `<span class="tip-date">${shortDate(p.date)}${p.restDay ? ' · rest' : ''}</span>`
        + `<span class="tip-val">${fmt(p.value)} <small>kcal</small></span>`
        + (avg ? `<span class="tip-sub">7d avg ${fmt(avg)}</span>` : '');
      tip.hidden = false;
      const left = Math.min(Math.max(cx - tip.offsetWidth / 2, 0), width - tip.offsetWidth);
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(cy - tip.offsetHeight - 14, 0)}px`;
    });
  });
}

/** Small trend line with an emphasized endpoint. */
export function sparkline(values, color, { width = 120, height = 34 } = {}) {
  const svg = el('svg', { width, height, class: 'spark', 'aria-hidden': 'true' });
  if (values.length < 2) return svg;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [2 + (i / (values.length - 1)) * (width - 6), 3 + (1 - (v - min) / span) * (height - 6)]);
  svg.append(el('polyline', { points: pts.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' '), fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
  const [ex, ey] = pts.at(-1);
  svg.append(el('circle', { cx: ex, cy: ey, r: 2.5, fill: color }));
  return svg;
}

/**
 * Weekly candles: body = change in weekly average vs the week before,
 * wick = lowest to highest single day. Shows as many recent weeks as fit.
 */
export function candleChart(host, candles, { height = 260 } = {}) {
  observeWidth(host, (width) => {
    host.replaceChildren();
    if (!candles.length) {
      const empty = document.createElement('div');
      empty.className = 'chart-empty';
      empty.textContent = 'No weeks logged in this range';
      host.append(empty);
      return;
    }
    const fit = Math.max(3, Math.floor(width / 64));
    const shown = candles.slice(-fit);
    const pad = { top: 10, bottom: 46 };
    const plotH = height - pad.top - pad.bottom;
    const lo = Math.min(...shown.map((c) => Math.min(c.low, c.open)));
    const hi = Math.max(...shown.map((c) => Math.max(c.high, c.open)));
    const span = hi - lo || 1;
    const y = (v) => pad.top + (1 - (v - lo) / span) * plotH;
    const slot = width / shown.length;
    const bodyW = Math.min(52, slot * 0.5);

    const svg = el('svg', { width, height, class: 'chart', role: 'img', 'aria-label': 'Weekly TDEE range' });
    shown.forEach((c, i) => {
      const cx = slot * i + slot / 2;
      const tone = c.up ? 'up' : 'down';
      svg.append(el('line', { x1: cx, x2: cx, y1: y(c.high), y2: y(c.low), class: `wick ${tone}` }));
      const top = y(Math.max(c.open, c.close));
      const h = Math.max(3, Math.abs(y(c.open) - y(c.close)));
      const body = el('rect', { x: cx - bodyW / 2, y: top, width: bodyW, height: h, rx: 2, class: `body ${tone}` });
      body.append(el('title', {}, `Week of ${shortDate(c.week)}: avg ${fmt(c.avg)}, range ${fmt(c.low)}–${fmt(c.high)} over ${c.days} day${c.days === 1 ? '' : 's'}`));
      svg.append(body);
      svg.append(el('text', { x: cx, y: height - 24, 'text-anchor': 'middle', class: 'candle-val' }, fmt(c.avg)));
      svg.append(el('text', { x: cx, y: height - 8, 'text-anchor': 'middle', class: 'tick' }, shortDate(c.week)));
    });
    host.append(svg);
  });
}
