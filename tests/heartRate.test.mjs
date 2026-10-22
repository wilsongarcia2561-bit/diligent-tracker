import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clockMinutes,
  exportRange,
  exportYear,
  groupByDate,
  hrrOf,
  looksLikeHeartRateExport,
  metFromHrr,
  parseHeartRate,
  rawHrCheck,
  windowStats,
} from '../src/heartRate.js';

// Synthetic rows in the Samsung Health PDF's shape: a ratio sign (∶) for the
// colon and a narrow no-break space before AM/PM, as the real export prints them.
const C = '∶';
const N = ' ';
const t = (h, m, ap) => `${h}${C}${m}${N}${ap}`;
const ROWS = [
  ['Oct 21', `${t(2, '30', 'PM')} - ${t(2, '59', 'PM')}`, '73-103', ''],
  ['Oct 21', `${t(2, '41', 'PM')} - ${t(2, '52', 'PM')}`, '96-128', 'Exercising'],
  ['Oct 21', `${t(3, '00', 'PM')} - ${t(3, '29', 'PM')}`, '81-121', ''],
  ['Oct 21', `${t(12, '00', 'PM')} - ${t(12, '29', 'PM')}`, '60-80', ''],
  ['Oct 20', t(6, '02', 'AM'), '52', 'Resting'],
  ['Oct 20', `${t(11, '30', 'PM')} - ${t(11, '59', 'PM')}`, '48-55', ''],
];
// pypdf: one field per line. pdf.js (textFromItems): one row per line.
const ONE_FIELD_PER_LINE = ['Heart rate', 'Date of birth: Jan 1, 1990', ...ROWS.flatMap((r) => r.filter(Boolean))].join('\n');
const ONE_ROW_PER_LINE = ['Heart rate', ...ROWS.map((r) => r.filter(Boolean).join('  '))].join('\n');

describe('reading a Samsung heart-rate export', () => {
  it('reads both PDF text layouts the same way', () => {
    const a = parseHeartRate(ONE_FIELD_PER_LINE, { year: 2026 });
    const b = parseHeartRate(ONE_ROW_PER_LINE, { year: 2026 });
    assert.deepEqual(a, b);
    assert.equal(a.length, 6);
  });

  it('turns windows into minutes past midnight, with tags and noon handled', () => {
    const rows = parseHeartRate(ONE_ROW_PER_LINE, { year: 2026 });
    const byKey = Object.fromEntries(rows.map((r) => [`${r.date} ${r.t}`, r]));
    assert.deepEqual(byKey['2026-10-21 870'], { date: '2026-10-21', t: 870, end: 899, lo: 73, hi: 103, tag: '' });
    assert.equal(byKey['2026-10-21 881'].tag, 'exercising');
    assert.equal(byKey['2026-10-21 720'].end, 749, '12:00 PM is noon, not midnight');
    assert.deepEqual(byKey['2026-10-20 362'], { date: '2026-10-20', t: 362, end: 362, lo: 52, hi: 52, tag: 'resting' });
    assert.equal(byKey['2026-10-20 1410'].end, 1439);
  });

  it('drops a row repeated across a page break', () => {
    const doubled = `${ONE_ROW_PER_LINE}\nOct 21  ${t(2, '30', 'PM')} - ${t(2, '59', 'PM')}  73-103`;
    assert.equal(parseHeartRate(doubled, { year: 2026 }).length, 6);
  });

  it('reads rows copied into a spreadsheet, with ISO or US dates and 24-hour times', () => {
    const rows = parseHeartRate('2026-10-21  14:30 - 14:59  73-103  Exercising\n10/22/2026  9:00 AM - 9:29 AM  80-120', { year: 2000 });
    assert.deepEqual(rows.map((r) => [r.date, r.t, r.lo, r.hi, r.tag]), [['2026-10-21', 870, 73, 103, 'exercising'], ['2026-10-22', 540, 80, 120, '']]);
  });

  it('takes the year from the filename, never from a date of birth', () => {
    assert.equal(exportYear('Heart_rate_Jul222026-Oct212026.pdf', ''), 2026);
    assert.equal(exportYear('export.pdf', 'Date of birth: Jan 1, 1990\nOct 21 2026'), 2026);
    assert.deepEqual(exportRange('Heart_rate_Jul222026-Oct212026.pdf'), { from: '2026-07-22', to: '2026-10-21' });
    assert.equal(exportRange('export.pdf'), null);
  });

  it('puts January rows of a December–January export in the later year', () => {
    const text = `Dec 31  ${t(11, '00', 'PM')} - ${t(11, '29', 'PM')}  60-70\nJan 1  ${t(1, '00', 'AM')} - ${t(1, '29', 'AM')}  55-65`;
    const rows = parseHeartRate(text, { year: 2026, range: exportRange('Heart_rate_Dec012026-Jan152027.pdf') });
    assert.deepEqual(rows.map((r) => r.date), ['2026-12-31', '2027-01-01']);
  });

  it('recognizes an export, and not a calendar log or a TDEE table', () => {
    assert.equal(looksLikeHeartRateExport(ONE_FIELD_PER_LINE), true);
    assert.equal(looksLikeHeartRateExport('Date: 2026-09-18\nShift: 8:08 AM - 3:18 PM\n98° (Feels 104°)\n• Haul gravel'), false);
    assert.equal(looksLikeHeartRateExport('date,rest_day,main_task,net_work_minutes\n2026-10-07,false,Dig,374'), false);
  });

  it('groups readings by date in the compact stored shape', () => {
    const g = groupByDate(parseHeartRate(ONE_ROW_PER_LINE, { year: 2026 }));
    assert.deepEqual(Object.keys(g), ['2026-10-20', '2026-10-21']);
    assert.deepEqual(g['2026-10-21'][0], [720, 749, 60, 80, '']);
  });
});

describe('raw heart rate over work time', () => {
  // 13:00–14:59 in four windows; an Exercising segment and a Resting spot reading on top.
  const rows = [
    [780, 809, 80, 100, ''],
    [810, 839, 100, 140, ''],
    [840, 869, 90, 110, ''],
    [870, 899, 60, 70, ''],
    [815, 830, 120, 140, 'exercising'],
    [845, 845, 50, 50, 'resting'],
  ];

  it('reads each window at the middle of its min–max, weighted by minutes, with no correction', () => {
    const st = windowStats(rows, 780, 870);
    assert.equal(st.minutes, 90);
    assert.equal(st.hr, (90 + 120 + 100) / 3);
    assert.equal(st.peak, 140);
    assert.equal(st.exercising, 1, 'an Exercising segment is marked, not averaged in twice');
  });

  it('leaves excluded time (lunch, travel) out', () => {
    const st = windowStats(rows, 780, 900, [[810, 840]]);
    assert.equal(st.minutes, 90);
    assert.equal(st.hr, (90 + 100 + 65) / 3);
  });

  it('maps HRR to MET along the §4 table, capped at 12', () => {
    assert.equal(hrrOf(125, 49, 201), 0.5);
    assert.equal(metFromHrr(0.35), 4.5);
    assert.equal(metFromHrr(0.45), 5.5);
    assert.equal(metFromHrr(0.85), 9.5);
    assert.equal(metFromHrr(0.95), 12);
    assert.equal(metFromHrr(1.2), 12);
    assert.equal(metFromHrr(-0.1), 1);
  });

  const opts = { restingHr: 49, maxHr: 201 };
  const steady = Array.from({ length: 8 }, (_, i) => [480 + i * 30, 509 + i * 30, 95, 115, '']); // 105 bpm all morning
  const win = { start: 480, end: 720, exclude: [] };

  it('agrees within 0.5 MET, and says revise beyond it — both ways', () => {
    // 105 bpm → HRR 36.8% → MET 4.68
    assert.equal(rawHrCheck(steady, win, { ...opts, dayMet: 4.5 }).verdict, 'agree');
    const down = rawHrCheck(steady, win, { ...opts, dayMet: 6 });
    assert.equal(down.verdict, 'down');
    assert.equal(down.suggested, 4.75);
    assert.equal(rawHrCheck(steady, win, { ...opts, dayMet: 3.5 }).verdict, 'up');
  });

  it('will not judge a thinly recorded day, and reads a day with no MET from heart rate alone', () => {
    const sparse = rawHrCheck(steady.slice(0, 3), win, { ...opts, dayMet: 6 });
    assert.equal(sparse.status, 'sparse');
    assert.equal(sparse.verdict, undefined);
    const alone = rawHrCheck(steady, win, { ...opts, dayMet: null });
    assert.equal(alone.verdict, 'hr-only');
    assert.equal(alone.suggested, 4.75);
    assert.equal(rawHrCheck([], win, { ...opts, dayMet: 6 }).status, 'no-readings');
  });

  it('parses clock strings', () => {
    assert.equal(clockMinutes('07:47'), 467);
    assert.equal(clockMinutes('7:47 PM'), null);
  });
});
