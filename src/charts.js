/**
 * Hand-rolled SVG charts — no charting library, no network fetches.
 *
 * Each chart draws at the host's real pixel width (not a stretched viewBox),
 * so mono labels keep their shape; callers redraw on resize via observeWidth.
 */

const NS = 'http://www.w3.org/2000/svg';
const DAY_MS = 86400000;
let gradientSeq = 0;

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const easeOutCubic = (t) => 1 - (1 - t) ** 3;

/** Run `fn` once `el` is actually on screen, so an entrance isn't spent below the fold. */
function whenVisible(el, fn) {
  if (typeof IntersectionObserver === 'undefined') return fn();
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    fn();
  }, { threshold: 0.2 });
  io.observe(el);
}

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
  // The first draw rises from a flat line; redraws on resize just redraw.
  let risen = reducedMotion();
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

    const base = pad.top + plotH;
    // k = 0 is flat on the baseline, k = 1 is each day's real TDEE.
    const yk = (v, k) => base + (y(v) - base) * k;
    const trace = (list, k) => list.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${yk(p.value, k).toFixed(1)}`).join('');
    const areaD = (k) => `${trace(points, k)}L${x(points.at(-1).date).toFixed(1)},${base}L${x(points[0].date).toFixed(1)},${base}Z`;
    const start = risen ? 1 : 0;
    const area = el('path', { d: areaD(start), fill: `url(#${gid})` });
    svg.append(area);
    const rollPath = rolling.length > 1 ? el('path', { d: trace(rolling, start), class: 'roll-line', fill: 'none' }) : null;
    if (rollPath) svg.append(rollPath);
    const linePath = el('path', { d: trace(points, start), class: 'area-line', fill: 'none' });
    svg.append(linePath);
    const last = points.at(-1);
    const endDot = el('circle', { cx: x(last.date), cy: yk(last.value, start), r: 3.5, class: 'end-dot' });
    svg.append(endDot);
    if (!risen) {
      risen = true;
      const DURATION = 950;
      let t0 = null;
      const frame = (now) => {
        if (!svg.isConnected) return;
        t0 ??= now;
        const k = easeOutCubic(Math.min(1, (now - t0) / DURATION));
        area.setAttribute('d', areaD(k));
        linePath.setAttribute('d', trace(points, k));
        if (rollPath) rollPath.setAttribute('d', trace(rolling, k));
        endDot.setAttribute('cy', yk(last.value, k));
        if (k < 1) requestAnimationFrame(frame);
      };
      whenVisible(host, () => setTimeout(() => requestAnimationFrame(frame), 120));
    }

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
  // pathLength=1 lets CSS draw the line in with a single dash.
  svg.append(el('polyline', { pathLength: 1, points: pts.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' '), fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
  const [ex, ey] = pts.at(-1);
  svg.append(el('circle', { cx: ex, cy: ey, r: 2.5, fill: color }));
  return svg;
}

/**
 * Weekly candles: body = change in weekly average vs the week before,
 * wick = lowest to highest single day. Shows as many recent weeks as fit.
 */
export function candleChart(host, candles, { height = 260 } = {}) {
  let grown = false;
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

    // Candles grow in left to right the first time; resize redraws stay still.
    const svg = el('svg', { width, height, class: grown || reducedMotion() ? 'chart' : 'chart grow waiting', role: 'img', 'aria-label': 'Weekly TDEE range' });
    if (!grown) whenVisible(host, () => svg.classList.remove('waiting'));
    grown = true;
    shown.forEach((c, i) => {
      const delay = `--d:${250 + i * 70}ms`;
      const cx = slot * i + slot / 2;
      const tone = c.up ? 'up' : 'down';
      svg.append(el('line', { x1: cx, x2: cx, y1: y(c.high), y2: y(c.low), class: `wick ${tone}`, style: delay }));
      const top = y(Math.max(c.open, c.close));
      const h = Math.max(3, Math.abs(y(c.open) - y(c.close)));
      const body = el('rect', { x: cx - bodyW / 2, y: top, width: bodyW, height: h, rx: 2, class: `body ${tone}`, style: delay });
      body.append(el('title', {}, `Week of ${shortDate(c.week)}: avg ${fmt(c.avg)}, range ${fmt(c.low)}–${fmt(c.high)} over ${c.days} day${c.days === 1 ? '' : 's'}`));
      svg.append(body);
      svg.append(el('text', { x: cx, y: height - 24, 'text-anchor': 'middle', class: 'candle-val', style: delay }, fmt(c.avg)));
      svg.append(el('text', { x: cx, y: height - 8, 'text-anchor': 'middle', class: 'tick' }, shortDate(c.week)));
    });
    host.append(svg);
  });
}

/** Smooth path through points that never overshoots them (monotone cubic, Fritsch–Carlson). */
function monotonePath(pts) {
  if (pts.length === 1) return `M${pts[0][0]},${pts[0][1]}`;
  const n = pts.length;
  const dx = [];
  const m = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx.push(pts[i + 1][0] - pts[i][0]);
    m.push(dx[i] ? (pts[i + 1][1] - pts[i][1]) / dx[i] : 0);
  }
  const t = pts.map((_, i) => (i === 0 ? m[0] : i === n - 1 ? m[n - 2] : m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2));
  for (let i = 0; i < n - 1; i += 1) {
    if (!m[i]) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const h = a * a + b * b;
    if (h > 9) {
      const s = 3 / Math.sqrt(h);
      t[i] = s * a * m[i];
      t[i + 1] = s * b * m[i];
    }
  }
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i += 1) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const h = dx[i] / 3;
    d += `C${(x0 + h).toFixed(1)},${(y0 + t[i] * h).toFixed(1)} ${(x1 - h).toFixed(1)},${(y1 - t[i + 1] * h).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}

/**
 * The Trends card's chart: one labeled point per window (or per day), a
 * smooth line through them over a soft fill, and a selected point the reader
 * moves by tapping, or with the arrow keys once the chart has focus.
 * `points`: [{ date, value, tone? ('work' | 'rest') }], oldest first.
 * `xLabel(point)` names a point under the axis. Returns { select(i) }.
 */
export function trendChart(host, points, { selected = points.length - 1, onSelect, xLabel = (p) => shortDate(p.date), height = 210, label = 'TDEE over time' } = {}) {
  let sel = Math.max(0, Math.min(points.length - 1, selected));
  let entered = reducedMotion();
  let api = { select() {} };

  host.tabIndex = 0;
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', `${label}. Use the left and right arrow keys to move between points.`);

  observeWidth(host, (width) => {
    host.replaceChildren();
    if (!points.length) {
      const empty = document.createElement('div');
      empty.className = 'chart-empty';
      empty.textContent = 'Nothing logged in this stretch yet';
      host.append(empty);
      return;
    }

    const pad = { top: 30, right: 46, bottom: 30, left: 14 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const base = pad.top + plotH;
    const values = points.map((p) => p.value);
    const { lo, hi, step } = niceScale(Math.min(...values), Math.max(...values), 3);
    let t0 = toTime(points[0].date);
    let t1 = toTime(points.at(-1).date);
    if (t0 === t1) {
      t0 -= DAY_MS;
      t1 += DAY_MS;
    }
    const x = (p) => pad.left + ((toTime(p.date) - t0) / (t1 - t0)) * plotW;
    const y = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * plotH;
    const xy = points.map((p) => [x(p), y(p.value)]);

    const svg = el('svg', { width, height, class: `tchart${entered ? '' : ' enter'}`, 'aria-hidden': 'true' });
    const gid = `tchart-grad-${(gradientSeq += 1)}`;
    const defs = el('defs');
    const grad = el('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.append(
      el('stop', { offset: '0%', 'stop-color': 'var(--chart)', 'stop-opacity': 0.2 }),
      el('stop', { offset: '100%', 'stop-color': 'var(--chart)', 'stop-opacity': 0 }),
    );
    defs.append(grad);
    svg.append(defs);

    for (let v = lo; v <= hi + 1e-9; v += step) {
      const yy = y(v);
      svg.append(el('line', { x1: pad.left, x2: width - pad.right + 6, y1: yy, y2: yy, class: 't-grid' }));
      svg.append(el('text', { x: width - 2, y: yy + 4, 'text-anchor': 'end', class: 't-gl' }, fmt(v)));
    }

    const line = monotonePath(xy);
    svg.append(el('path', { d: `${line}L${xy.at(-1)[0].toFixed(1)},${base}L${xy[0][0].toFixed(1)},${base}Z`, fill: `url(#${gid})`, class: 't-area' }));
    svg.append(el('path', { d: line, class: 't-line', fill: 'none', pathLength: 1 }));

    // Labels thin out when points crowd, but the last and the selected always show.
    const gap = points.length > 1 ? plotW / (points.length - 1) : plotW;
    const stride = Math.max(1, Math.ceil(46 / gap));
    const shows = (i) => (points.length - 1 - i) % stride === 0;
    const xStride = Math.max(1, Math.ceil(54 / gap));

    const marks = points.map((p, i) => {
      const [cx, cy] = xy[i];
      const dot = el('circle', { cx, cy, r: 3.5, class: `t-pt${p.tone ? ` ${p.tone}` : ''}`, style: `--i:${i}` });
      const val = el('text', { x: cx, y: cy - 12, 'text-anchor': 'middle', class: 't-val', style: `--i:${i}` }, fmt(p.value));
      svg.append(dot, val);
      if ((points.length - 1 - i) % xStride === 0) {
        const anchor = points.length > 1 && i === 0 && cx < 30 ? 'start' : 'middle';
        svg.append(el('text', { x: cx, y: height - 8, 'text-anchor': anchor, class: 't-x' }, xLabel(p)));
      }
      return { dot, val };
    });

    // The selection: a dashed guide down to the axis and a filled dot with a halo.
    const selG = el('g', { class: 't-sel' });
    const guide = el('line', { x1: 0, x2: 0, y1: 0, y2: 0, class: 't-guide' });
    selG.append(guide, el('circle', { r: 12, class: 't-halo' }), el('circle', { r: 5, class: 't-core' }));
    svg.append(selG);
    host.append(svg);

    const place = (i, animate) => {
      const [cx, cy] = xy[i];
      selG.style.transition = animate ? '' : 'none';
      selG.style.transform = `translate(${cx}px, ${cy}px)`;
      guide.setAttribute('y2', base - cy);
      marks.forEach((m, k) => {
        m.val.classList.toggle('sel', k === i);
        m.val.classList.toggle('hide', k !== i && !shows(k));
      });
      if (!animate) requestAnimationFrame(() => { selG.style.transition = ''; });
    };
    place(sel, false);
    entered = true;

    api = {
      select(i) {
        sel = Math.max(0, Math.min(points.length - 1, i));
        place(sel, true);
      },
    };

    const pick = (clientX) => {
      const px = clientX - svg.getBoundingClientRect().left;
      let best = 0;
      for (let i = 1; i < xy.length; i += 1) if (Math.abs(xy[i][0] - px) < Math.abs(xy[best][0] - px)) best = i;
      if (best !== sel) {
        api.select(best);
        onSelect?.(best);
      }
    };
    svg.addEventListener('click', (e) => pick(e.clientX));
    svg.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse' && e.buttons === 1) pick(e.clientX);
    });
  });

  host.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = sel + (e.key === 'ArrowRight' ? 1 : -1);
    if (next < 0 || next >= points.length) return;
    api.select(next);
    onSelect?.(sel);
  });

  return { select: (i) => api.select(i) };
}
