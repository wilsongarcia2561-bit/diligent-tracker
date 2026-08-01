/** Trend view — TDEE over time, rolling 7-day average, weight, work vs rest averages. */

import { barChart, lineChart } from '../charts.js';
import { summarizeTrends } from '../engine.js';
import * as store from '../store.js';
import { calculatedEntries } from './history.js';
import { kcal, kgToLb, num } from '../ui.js';

export function render(root) {
  const rows = calculatedEntries();
  const results = rows.map((r) => r.calc);
  const trends = summarizeTrends(results);
  const weights = store.listWeights().map((w) => ({ date: w.date, value: w.kg }));

  root.innerHTML = `
    <div class="card-head"><h2>Trends <span class="sec-ref">§12.6</span></h2></div>
    ${
      results.length
        ? `
      <div class="stat-row">
        <div class="stat"><span class="stat-label">Work-day average</span><span class="stat-value">${kcal(trends.workDayAverage)}</span><span class="stat-sub">${trends.workDayCount} day${trends.workDayCount === 1 ? '' : 's'}</span></div>
        <div class="stat"><span class="stat-label">Rest-day average</span><span class="stat-value">${kcal(trends.restDayAverage)}</span><span class="stat-sub">${trends.restDayCount} day${trends.restDayCount === 1 ? '' : 's'}</span></div>
        <div class="stat"><span class="stat-label">Overall average</span><span class="stat-value">${kcal(trends.overallAverage)}</span><span class="stat-sub">${results.length} logged</span></div>
        <div class="stat"><span class="stat-label">Avg active kcal</span><span class="stat-value">${kcal(trends.activeAverage)}</span><span class="stat-sub">work days only</span></div>
      </div>

      <section class="card">
        <h3>TDEE over time</h3>
        <p class="muted small">Solid line: daily TDEE (hollow markers are rest days). Dashed line: rolling 7-day average.</p>
        <div id="tdee-chart"></div>
      </section>

      <section class="card">
        <h3>Work day vs rest day</h3>
        <div id="compare-chart"></div>
      </section>
      `
        : '<div class="empty">Log a few days and the charts will fill in here.</div>'
    }

    <section class="card">
      <h3>Bodyweight <span class="sec-ref">§4</span></h3>
      <p class="muted small">Fasted, morning, post-bathroom readings only.</p>
      <div id="weight-chart"></div>
      ${
        weights.length
          ? `<p class="muted small">Latest: <strong>${num(weights.at(-1).value, 1)} kg</strong> (${num(kgToLb(weights.at(-1).value), 1)} lb) on ${weights.at(-1).date}</p>`
          : ''
      }
    </section>
  `;

  const tdeeHost = root.querySelector('#tdee-chart');
  if (tdeeHost) {
    tdeeHost.appendChild(
      lineChart(
        [
          { name: 'TDEE', points: trends.series, color: 'var(--c-active)' },
          { name: '7-day avg', points: trends.rolling7, color: 'var(--accent)', dashed: true, dots: false },
        ],
        { yLabel: 'TDEE kcal' },
      ),
    );
  }

  const compareHost = root.querySelector('#compare-chart');
  if (compareHost) {
    compareHost.appendChild(
      barChart([
        { label: 'Work days', sub: `${trends.workDayCount} logged`, value: trends.workDayAverage ?? 0, color: 'var(--c-active)' },
        { label: 'Rest days', sub: `${trends.restDayCount} logged`, value: trends.restDayAverage ?? 0, color: 'var(--c-neat)' },
      ]),
    );
  }

  const weightHost = root.querySelector('#weight-chart');
  if (weightHost) {
    weightHost.appendChild(
      lineChart([{ name: 'kg', points: weights, color: 'var(--c-tef)' }], {
        height: 220,
        yLabel: 'Bodyweight kg',
        valueFormat: (v) => v.toFixed(1),
      }),
    );
  }
}
