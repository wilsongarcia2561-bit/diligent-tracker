import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { calculateDay } from '../src/engine.js';
import * as store from '../src/store.js';
import { EXPORT_COLUMNS, looksLikeSummaryTable, parseDate, parseDelimited, parseNumber, parseSummaryTable } from '../src/summaryImport.js';
import { toCsv } from '../src/views/history.js';

const SETTINGS = { bmr: 1436, breakMinutesDefault: 10, weightKg: 57.6 };
const HEADER = EXPORT_COLUMNS.join(',');
// Synthetic rows in the same shape as a real day-by-day TDEE export.
const CSV = [
  HEADER,
  '2026-06-01,false,"Dig red clay trench, lay pipe, re-sod",196,82,2,57.6,1436,1009,85,210,260,3000,1197,,,,"Tier C; breaks assumed 4x10 min; gap 12:02-16:34 excluded"',
  '2026-06-07,true,Rest / non-work day,0,,0,57.6,1436,200,100,210,0,1946,,,,,rest day baseline',
  '2026-07-09,false,Day. 08:31-17:03 - no task description,,,1,57.6,1436,,,,,,,,,,"Tier F; UNUSABLE - no description"',
  '2026-08-12,false,"HC trench/drain, fabric, river rock",288,100,1,57.6,1436,1797,95,210,117,3655,2074,,,3655,Tier B',
].join('\n');

const toEntry = (d) => ({ ...store.newEntry(d.date), ...d.patch, phases: d.patch.phases.map((p) => ({ ...store.newPhase(), ...p })) });

describe('reading a day-by-day TDEE table', () => {
  it('recognizes the table and is not fooled by times and pulse numbers in its notes', () => {
    assert.equal(looksLikeSummaryTable(CSV), true);
    assert.equal(looksLikeSummaryTable('Date: 2026-09-01\nShift: 8:00 AM - 12:00 PM\n\n• Water sod'), false);
  });

  it('parses quoted fields with commas, and sorts rows into work, non-work and unusable', () => {
    const { days, skipped } = parseSummaryTable(CSV, { filename: 'test.csv' });
    assert.deepEqual(days.map((d) => d.kind), ['work', 'rest', 'unusable', 'work']);
    assert.equal(skipped.length, 0);
    assert.equal(days[0].patch.phases[0].description, 'Dig red clay trench, lay pipe, re-sod');
    assert.match(days[0].patch.importFlags[0].text, /gap 12:02-16:34 excluded/);
  });

  it('recomputes every usable day to the file\'s TDEE', () => {
    for (const d of parseSummaryTable(CSV).days.filter((x) => x.fileTdee !== null)) {
      const calc = calculateDay(toEntry(d), SETTINGS);
      assert.ok(Math.abs(calc.tdee - d.fileTdee) <= 1, `${d.date}: app ${calc.tdee} vs file ${d.fileTdee}`);
    }
  });

  it('derives the MET that reproduces the active kcal under the Intermediate model', () => {
    const work = parseSummaryTable(CSV).days[0].patch.phases[0];
    // 1009 / (57.6 × 196/60) + 1
    assert.ok(Math.abs(work.met - (1009 / (57.6 * (196 / 60)) + 1)) < 0.001);
    assert.equal(work.metSource, 'summary');
  });

  it('marks an unusable row so it stays out of averages', () => {
    const calc = calculateDay(toEntry(parseSummaryTable(CSV).days[2]), SETTINGS);
    assert.equal(calc.unusable, true);
  });

  it('reads a Google Sheets paste: tabs, TRUE/FALSE, M/D/YYYY and "3,000"', () => {
    const tsv = [
      ['date', 'rest_day', 'main_task', 'net_work_minutes', 'weight_kg', 'active_kcal', 'neat_kcal', 'tef_kcal', 'background_kcal', 'tdee_kcal'].join('\t'),
      ['6/1/2026', 'FALSE', 'Dig, lay pipe', '196', '57.6', '1,009', '85', '210', '260', '3,000'].join('\t'),
      ['6/7/2026', 'TRUE', 'Rest', '0', '57.6', '200', '100', '210', '0', '1,946'].join('\t'),
    ].join('\n');
    assert.equal(looksLikeSummaryTable(tsv), true);
    const { days } = parseSummaryTable(tsv);
    assert.deepEqual(days.map((d) => [d.date, d.kind, d.fileTdee]), [['2026-06-01', 'work', 3000], ['2026-06-07', 'rest', 1946]]);
    assert.ok(Math.abs(calculateDay(toEntry(days[0]), SETTINGS).tdee - 3000) <= 1);
  });

  it('reads rows pasted without the header, in the export column order', () => {
    const rows = CSV.split('\n').slice(1).join('\n');
    assert.equal(looksLikeSummaryTable(rows), true);
    const { days, headerless } = parseSummaryTable(rows);
    assert.equal(headerless, true);
    assert.equal(days.length, 4);
  });

  it('round-trips through the app\'s own CSV export', () => {
    const entries = parseSummaryTable(CSV).days.map(toEntry);
    const csv = toCsv(entries.map((e) => ({ entry: e, calc: calculateDay(e, SETTINGS) })));
    const again = parseSummaryTable(csv).days;
    assert.deepEqual(again.map((d) => d.kind), ['work', 'rest', 'unusable', 'work']);
    for (const d of again.filter((x) => x.fileTdee !== null)) {
      assert.ok(Math.abs(calculateDay(toEntry(d), SETTINGS).tdee - d.fileTdee) <= 1, d.date);
    }
  });

  it('reports rows with no readable date and keeps the last of a repeated date', () => {
    const { days, skipped, duplicates } = parseSummaryTable(`${CSV}\nnot a date,false,x,10\n2026-06-01,false,Again,60,,1,57.6,1436,200,85,210,225,2156`);
    assert.equal(skipped.length, 1);
    assert.deepEqual(duplicates, ['2026-06-01']);
    assert.equal(days.find((d) => d.date === '2026-06-01').patch.phases[0].description, 'Again');
  });
});

describe('cell parsing', () => {
  it('handles quoted quotes and CRLF', () => {
    assert.deepEqual(parseDelimited('a,"he said ""hi""",c\r\n1,2,3\r\n'), [['a', 'he said "hi"', 'c'], ['1', '2', '3']]);
  });
  it('reads dates and numbers the way spreadsheets write them', () => {
    assert.equal(parseDate('2026-06-01'), '2026-06-01');
    assert.equal(parseDate('6/1/2026'), '2026-06-01');
    assert.equal(parseDate('06/01/26'), '2026-06-01');
    assert.equal(parseDate('Jun 1, 2026'), '2026-06-01');
    assert.equal(parseDate('2026-02-30'), null);
    assert.equal(parseNumber('3,000'), 3000);
    assert.equal(parseNumber(''), null);
  });
});
