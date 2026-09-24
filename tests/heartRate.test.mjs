import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { calculateDay } from '../src/engine.js';
import { groupByDate, htmlToText, parseHeartRateText, windowStats } from '../src/heartRate.js';

const HTML = fs.readFileSync(new URL('./fixtures/sample-hr-export.html', import.meta.url), 'utf8');
const SETTINGS = { bmr: 1436, breakMinutesDefault: 10, restingHr: 49, maxHr: 201, weightKg: 57.6 };

describe('Samsung heart-rate export parsing', () => {
  it('reads an HTML table export into dated, timed readings', () => {
    const readings = parseHeartRateText(htmlToText(HTML), { year: 2026 });
    const byDate = groupByDate(readings);
    assert.deepEqual(Object.keys(byDate), ['2026-09-09', '2026-09-10']);
    assert.equal(byDate['2026-09-09'].length, 11);
    assert.deepEqual(byDate['2026-09-09'][1], { t: 13 * 60 + 10, bpm: 118, min: 104, max: 131, tag: 'exercising' });
    assert.equal(byDate['2026-09-10'].length, 5);
  });

  it('reads PDF-style text lines: ISO timestamps, ranges, and a date carried from a heading', () => {
    const text = [
      'Heart rate report',
      '2026-09-05T08:10:00 112 bpm',
      'Sep 8, 2026',
      '1:05 PM 107-166 bpm Exercising',
      '1:20 PM 121 bpm',
      'Average 98 bpm',
    ].join('\n');
    const r = parseHeartRateText(text, { year: 2026 });
    assert.equal(r.length, 3);
    assert.deepEqual(r[0], { date: '2026-09-05', t: 490, bpm: 112 });
    assert.deepEqual(r[1], { date: '2026-09-08', t: 785, bpm: 137, min: 107, max: 166, tag: 'exercising' });
  });

  it('reads unlabelled table rows by their header', () => {
    const text = 'Sep 9, 2026\nTime | Avg | Min | Max\n1:00 PM | 120 | 100 | 150\n1:10 PM | 118 | 99 | 140';
    const r = parseHeartRateText(text, { year: 2026 });
    assert.deepEqual(r[0], { date: '2026-09-09', t: 780, bpm: 120, min: 100, max: 150 });
  });

  it('weights readings by time so dense workout sampling does not dominate', () => {
    const readings = [
      { t: 600, bpm: 90 },
      ...Array.from({ length: 10 }, (_, i) => ({ t: 660 + i, bpm: 150 })),
      { t: 670, bpm: 90 },
    ];
    // Ten one-minute readings at 150 against 70 minutes at 90 → median 90.
    assert.equal(windowStats(readings, 600, 730).median, 90);
  });

  it('drops readings inside an excluded window (lunch)', () => {
    const readings = [{ t: 700, bpm: 120 }, { t: 730, bpm: 70 }, { t: 760, bpm: 120 }];
    assert.equal(windowStats(readings, 690, 800, [[720, 750]]).n, 2);
  });
});

describe('MET cross-check against the export', () => {
  const hr = groupByDate(parseHeartRateText(htmlToText(HTML), { year: 2026 }));
  const sep9 = {
    date: '2026-09-09', shiftStart: '13:03', shiftEnd: '17:03', lunchStart: '12:33', lunchEnd: '13:03', breakCount: 3, weightKg: 57.6,
    phases: [
      { id: 'a', description: 'Sod haul', met: 5.5 },
      { id: 'b', description: 'Sprinkler heads', met: 4.0, start: '14:00', end: '17:03' },
    ],
  };

  it('flags a day whose blended MET sits below what corrected HR implies, and suggests a revision', () => {
    const calc = calculateDay({ ...sep9, hrSamples: hr['2026-09-09'] }, SETTINGS);
    assert.equal(calc.hr.day.verdict, 'revise-up');
    assert.ok(calc.hr.day.suggestedMet >= 7);
    assert.ok(calc.flags.some((f) => /Heart-rate export disagrees \(higher\)/.test(f.text)));
  });

  it('checks a timed phase against its own window', () => {
    const calc = calculateDay({ ...sep9, hrSamples: hr['2026-09-09'] }, SETTINGS);
    const b = calc.phases.find((p) => p.id === 'b');
    assert.equal(b.bpm.fromExport, true);
    assert.equal(b.bpm.stats.n, 6);
    assert.equal(b.bpm.verdict, 'revise-up');
    assert.equal(calc.phases.find((p) => p.id === 'a').bpm, null, 'an untimed phase has no window of its own');
  });

  it('confirms a day whose MET matches', () => {
    const calc = calculateDay({ ...sep9, phases: [{ id: 'a', description: 'Sod haul', met: 8.0 }], hrSamples: hr['2026-09-09'] }, SETTINGS);
    assert.equal(calc.hr.day.verdict, 'validates');
    assert.ok(calc.flags.some((f) => /confirms the day/.test(f.text)));
  });

  it('revises downward just as readily', () => {
    const calc = calculateDay({
      date: '2026-09-10', shiftStart: '13:04', shiftEnd: '14:44', weightKg: 57.6,
      phases: [{ id: 'a', description: 'Mulch', met: 8.5 }],
      hrSamples: hr['2026-09-10'],
    }, SETTINGS);
    assert.equal(calc.hr.day.verdict, 'revise-down');
    assert.ok(calc.flags.some((f) => /disagrees \(lower\)/.test(f.text)));
  });

  it('says so when the export has readings for the date but none inside the shift', () => {
    const calc = calculateDay({ ...sep9, shiftStart: '06:00', shiftEnd: '09:00', lunchStart: '', lunchEnd: '', hrSamples: hr['2026-09-09'] }, SETTINGS);
    assert.ok(calc.flags.some((f) => /none inside the shift window/.test(f.text)));
  });

  it('drops the "no BPM data" flag once an export covers the day', () => {
    const calc = calculateDay({ ...sep9, hrSamples: hr['2026-09-09'] }, SETTINGS);
    assert.ok(!calc.flags.some((f) => /No BPM data logged/.test(f.text)));
  });
});

describe('hybrid work/uni days (§8.6)', () => {
  it('leaves a documented lecture block out of the work-window heart rate', () => {
    const readings = [];
    for (let t = 445; t < 529; t += 10) readings.push({ t, bpm: 130 }); // brick patio 7:25–8:49
    for (let t = 529; t < 742; t += 10) readings.push({ t, bpm: 72 }); // lecture 8:49–12:22
    for (let t = 779; t < 840; t += 10) readings.push({ t, bpm: 125 }); // haul 12:59–14:00
    const day = {
      date: '2026-09-02', shiftStart: '07:25', shiftEnd: '14:00', lunchStart: '12:22', lunchEnd: '12:59', weightKg: 57.6,
      transitMinutes: 213,
      phases: [{ id: 'a', description: 'Remove brick patio', met: 6.5, start: '07:25', end: '08:49' }, { id: 'b', description: 'Haul debris', met: 6.5, start: '12:59', end: '14:00' }],
      hrSamples: readings,
    };
    const without = calculateDay(day, SETTINGS);
    assert.ok(without.hr.dayStats.median < 80, 'sanity: the lecture dominates when it is not excluded');
    const withWindow = calculateDay({ ...day, nonLaborWindows: [{ start: '08:49', end: '12:22', reason: 'lecture' }] }, SETTINGS);
    assert.ok(withWindow.hr.dayStats.median >= 125, `median ${withWindow.hr.dayStats.median}`);
    assert.equal(withWindow.hr.dayStats.n, 9 + 7);
  });
});
