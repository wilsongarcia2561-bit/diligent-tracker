import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { parseCalendarLog, parseMultiDayLog, splitDayBlocks } from '../src/calendarImport.js';

const FIXTURE_PATH = new URL('./fixtures/sample-multiday-log.md', import.meta.url);

const REAL_CALENDAR_TEXT = `98° (Feels 104° Sunny)
BREAKS: 6
(LUNCH BREAK 12:16 - 1:04)

LANDSCAPE GRAVEL JOB
• CONTINUE HAULING GRAVEL VIA WHEELBARROW & DUMP TO DESINATED AREA (then spread over)
•REPAIR SPRINKLERS AND INSPECT
• WATER SOD
• miscellaneous work
`;

describe('calendar log import — real calendar text', () => {
  const { patch, matched, unmatched } = parseCalendarLog(REAL_CALENDAR_TEXT, {
    filename: 'day.md',
    fallbackDate: '2026-09-18',
  });

  it('falls back to the given date when none is in the text', () => {
    assert.equal(patch.date, '2026-09-18');
    assert.ok(!matched.includes('date'), 'date came from fallback, not a real match');
  });

  it('parses the combined temp/feels-like line', () => {
    assert.equal(patch.tempF, 98);
    assert.equal(patch.feelsLikeF, 104);
    assert.ok(matched.includes('heat'));
  });

  it('parses BREAKS: 6', () => {
    assert.equal(patch.breakCount, 6);
  });

  it('parses the parenthetical lunch block as midday, not 1 AM', () => {
    assert.equal(patch.lunchStart, '12:16');
    assert.equal(patch.lunchEnd, '13:04');
  });

  it('does not invent a shift time or site count that were never written', () => {
    assert.equal(patch.shiftStart, undefined);
    assert.ok(unmatched.includes('shift'));
    assert.ok(unmatched.includes('siteCount'));
  });

  it('collects every bullet as its own task phase, tolerant of a missing space after •', () => {
    assert.equal(patch.phases.length, 4);
    assert.match(patch.phases[0].description, /HAULING GRAVEL/);
    assert.match(patch.phases[1].description, /REPAIR SPRINKLERS/);
    assert.equal(patch.phases[3].description, 'miscellaneous work');
  });

  it('auto-suggests a MET for a phase whose wording matches the table', () => {
    const sprinkler = patch.phases.find((p) => /SPRINKLERS/.test(p.description));
    assert.equal(sprinkler.met, 4);
  });

  it('leaves the MET blank for a phase with no keyword match', () => {
    const misc = patch.phases.find((p) => p.description === 'miscellaneous work');
    assert.equal(misc.met, '');
  });

  it('keeps the original text in notes for traceability', () => {
    assert.match(patch.notes, /original text/);
    assert.match(patch.notes, /HAULING GRAVEL/);
    assert.match(patch.notes, /Imported from day\.md/);
  });

  it('lists exactly what still needs to be filled in by hand', () => {
    assert.deepEqual(unmatched.sort(), ['date', 'intake', 'shift', 'siteCount', 'weight'].sort());
  });
});

describe('calendar log import — labeled header format', () => {
  const text = `Date: September 18, 2026
Shift: 8:08 AM - 3:18 PM
Location: 200 Sherry Hl Trl, Madison, AL

Temp: 98F
Feels-like: 104F
Breaks: 6
Weight: 127 lb
Intake: 2500 kcal

- Hauling gravel via wheelbarrow
- Repair sprinklers and inspect
`;
  const { patch, matched } = parseCalendarLog(text, { fallbackDate: '2099-01-01' });

  it('parses a named date', () => {
    assert.equal(patch.date, '2026-09-18');
  });

  it('parses a 12-hour shift with explicit AM/PM', () => {
    assert.equal(patch.shiftStart, '08:08');
    assert.equal(patch.shiftEnd, '15:18');
  });

  it('parses a single Location line as one site', () => {
    assert.equal(patch.siteCount, 1);
  });

  it('parses separately labeled temp and feels-like lines', () => {
    assert.equal(patch.tempF, 98);
    assert.equal(patch.feelsLikeF, 104);
  });

  it('converts a labeled weight in pounds to kg', () => {
    assert.ok(Math.abs(patch.weightKg - 57.6) < 0.05);
  });

  it('parses labeled intake', () => {
    assert.equal(patch.intakeKcal, 2500);
  });

  it('parses dash-bulleted tasks', () => {
    assert.equal(patch.phases.length, 2);
  });

  it('matched every labeled field', () => {
    assert.deepEqual(
      matched.sort(),
      ['date', 'shift', 'breaks', 'heat', 'siteCount', 'weight', 'intake', 'tasks'].sort(),
    );
  });
});

describe('calendar log import — multi-site and numbered tasks', () => {
  it('counts multiple Location lines as multiple sites', () => {
    const text = `Date: 2026-09-19\nLocation: Bailey Cove\nLocation: Hampton Cove\n1. sod laying\n2. mulch throw`;
    const { patch } = parseCalendarLog(text, { fallbackDate: '2099-01-01' });
    assert.equal(patch.siteCount, 2);
    assert.equal(patch.phases.length, 2);
  });
});

describe('calendar log import — pulls a date from the filename as a last resort', () => {
  it('uses a YYYY-MM-DD found in the filename when the text has no date', () => {
    const { patch, matched } = parseCalendarLog('no date fields here, just prose.', {
      filename: '2026-08-04-notes.md',
      fallbackDate: '2099-01-01',
    });
    assert.equal(patch.date, '2026-08-04');
    assert.ok(matched.includes('date'));
  });
});

describe('calendar log import — degenerate input', () => {
  it('produces a fallback-dated, mostly-empty patch from blank text rather than throwing', () => {
    const { patch, matched, unmatched } = parseCalendarLog('', { fallbackDate: '2026-01-01' });
    assert.equal(patch.date, '2026-01-01');
    assert.equal(matched.length, 0);
    assert.equal(unmatched.length, 9);
    assert.match(patch.notes, /Imported\./);
  });

  it('never lets an unlabeled ambiguous shift time get guessed', () => {
    // Bare "12:16 - 1:04" with no "shift"/"lunch" label at all should not be
    // silently claimed as the shift — only lunch's midday heuristic does that.
    const { patch } = parseCalendarLog('Randomly: 12:16 - 1:04 happened today', {
      fallbackDate: '2026-01-01',
    });
    assert.equal(patch.shiftStart, undefined);
  });
});

describe('calendar log import — cross-line bridging regression', () => {
  // Real bug, found on real data: an earlier version of parseHeat used \s*
  // between its pieces, which matches newlines. A zip code fragment
  // several *lines* above an unrelated bare "Feels 102°" line got bridged
  // into one match, reading "756" as the day's raw temperature.
  it('does not read a zip code from a Location line as the temperature', () => {
    const text = `Date: 2026-08-31
Shift: 2:15 PM - 5:23 PM
Location: 300 Example Spring Ct, Anytown, ST 00003

Feels 102°
Breaks: 1
(Lunch break not logged)

• Move cut branches and wood to front yard`;
    const { patch } = parseCalendarLog(text, { fallbackDate: '2099-01-01' });
    assert.equal(patch.tempF, undefined, 'no real temp reading was logged — must stay unset');
    assert.equal(patch.feelsLikeF, 102);
  });

  it('does not bridge a shift time on one line with an unrelated time far below it', () => {
    const text = `Shift:\n\n\n\nsomething 12:00 - 1:00 unrelated`;
    const { patch } = parseCalendarLog(text, { fallbackDate: '2099-01-01' });
    assert.equal(patch.shiftStart, undefined);
  });
});

describe('calendar log import — bulleted NOTE lines are not tasks', () => {
  it('excludes a bulleted "NOTE:" line from the task phases', () => {
    const text = `Date: 2026-09-11
Shift: 8:13 AM - 4:54 PM

• Trench out sprinkler lines
• NOTE: digging clay is red North Alabama clay that's compacted & has rocks
• Install flex pipe & sprinkler head`;
    const { patch } = parseCalendarLog(text, { fallbackDate: '2099-01-01' });
    assert.equal(patch.phases.length, 2);
    assert.ok(!patch.phases.some((p) => /^NOTE/i.test(p.description)));
  });

  it('still preserves the NOTE text in the raw notes dump', () => {
    const text = `Date: 2026-09-11\n• NOTE: digging clay is compacted`;
    const { patch } = parseCalendarLog(text, { fallbackDate: '2099-01-01' });
    assert.match(patch.notes, /digging clay is compacted/);
  });
});

describe('calendar log import — per-bullet leading time range', () => {
  it('extracts a clean "(HH:MM - HH:MM)" prefix as the phase start/end', () => {
    const text = `Date: 2026-08-21\n• (8:10 - 10:33) Remove gravel and implement fabric`;
    const { patch } = parseCalendarLog(text, { fallbackDate: '2099-01-01' });
    assert.equal(patch.phases[0].start, '08:10');
    assert.equal(patch.phases[0].end, '10:33');
    assert.equal(patch.phases[0].description, 'Remove gravel and implement fabric');
  });

  it('leaves the whole bullet as description when the prefix is not a clean time range', () => {
    const text = `Date: 2026-09-12\n• (Return, 11:37 - end) Dump gravel to designated area`;
    const { patch } = parseCalendarLog(text, { fallbackDate: '2099-01-01' });
    assert.equal(patch.phases[0].start, '');
    assert.equal(patch.phases[0].end, '');
    assert.match(patch.phases[0].description, /^\(Return, 11:37 - end\)/);
  });

  it('leaves relative-time phrasing like "(Beginning - 8:49)" untouched', () => {
    const text = `Date: 2026-09-02\n• (Beginning - 8:49) Remove brick patio`;
    const { patch } = parseCalendarLog(text, { fallbackDate: '2099-01-01' });
    assert.equal(patch.phases[0].start, '');
    assert.match(patch.phases[0].description, /^\(Beginning - 8:49\)/);
  });
});

describe('calendar log import — multi-site Location line', () => {
  it('counts "N.) addr / M.) addr" within one Location line as multiple sites', () => {
    const text = 'Date: 2026-08-21\nLocation: 1.) 100 Example Cove Dr / 2.) 200 Example Creek Trail';
    const { patch } = parseCalendarLog(text, { fallbackDate: '2099-01-01' });
    assert.equal(patch.siteCount, 2);
  });

  it('treats "(not logged)" as no site information, not one site', () => {
    const text = 'Date: 2026-08-28\nLocation: (not logged)';
    const { patch, unmatched } = parseCalendarLog(text, { fallbackDate: '2099-01-01' });
    assert.equal(patch.siteCount, undefined);
    assert.ok(unmatched.includes('siteCount'));
  });

  it('still returns one site for a plain single-address Location line', () => {
    const text = 'Date: 2026-09-05\nLocation: 100 Example Cir SE, Anytown, ST 00099';
    const { patch } = parseCalendarLog(text, { fallbackDate: '2099-01-01' });
    assert.equal(patch.siteCount, 1);
  });
});

describe('splitDayBlocks', () => {
  it('splits on a "---" separator line, trimming blank lines around it', () => {
    const text = 'Date: 2026-08-21\nfoo\n\n---\n\nDate: 2026-08-24\nbar';
    const blocks = splitDayBlocks(text);
    assert.equal(blocks.length, 2);
    assert.match(blocks[0], /^Date: 2026-08-21/);
    assert.match(blocks[1], /^Date: 2026-08-24/);
  });

  it('returns the whole text as one block when there is no separator', () => {
    const blocks = splitDayBlocks('Date: 2026-08-21\njust one day here');
    assert.equal(blocks.length, 1);
  });
});

describe('parseMultiDayLog — sanitized fixture built from real calendar data', () => {
  // tests/fixtures/sample-multiday-log.md is a de-identified excerpt (fake
  // addresses) preserving every structural edge case found in the actual
  // real-world file this parser was built against: placeholder "__:__"
  // lunch times, "(not logged)" fields, multi-site "N.) addr / M.) addr"
  // locations, a bulleted "NOTE:" line, "(Return, 11:37 - end)"-style
  // non-clean time prefixes, and the exact zip-code-bridging scenario that
  // was caught as a real bug during development.
  const text = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const results = parseMultiDayLog(text, { filename: 'sample-multiday-log.md' });

  it('splits into exactly 7 day blocks, all with a real parsed date', () => {
    assert.equal(results.length, 7);
    assert.ok(results.every((r) => r.patch && r.patch.date));
    const dates = results.map((r) => r.patch.date);
    assert.equal(dates[0], '2026-08-21');
    assert.equal(dates.at(-1), '2026-09-19');
    assert.equal(new Set(dates).size, 7, 'every date must be unique');
  });

  it('correctly reads the first day (multi-site, placeholder lunch)', () => {
    const day = results.find((r) => r.patch.date === '2026-08-21').patch;
    assert.equal(day.shiftStart, '08:10');
    assert.equal(day.shiftEnd, '11:45');
    assert.equal(day.siteCount, 2);
    assert.equal(day.lunchStart, undefined, 'placeholder "__:__" must not parse as a real time');
    assert.equal(day.phases.length, 2);
  });

  it('does not misread the Aug 31 zip code as a temperature', () => {
    const day = results.find((r) => r.patch.date === '2026-08-31').patch;
    assert.equal(day.tempF, undefined);
    assert.equal(day.feelsLikeF, 102);
  });

  it('flags Aug 28 as a genuinely task-less day rather than guessing', () => {
    const day = results.find((r) => r.patch.date === '2026-08-28').patch;
    assert.equal(day.phases, undefined);
    assert.equal(day.siteCount, undefined, '"(not logged)" must not count as one site');
  });

  it('excludes the Sep 11 bulleted NOTE from tasks', () => {
    const day = results.find((r) => r.patch.date === '2026-09-11').patch;
    assert.equal(day.phases.length, 3);
    assert.ok(!day.phases.some((p) => /^NOTE/i.test(p.description)));
  });

  it('extracts per-bullet times on Sep 19 but leaves the untimed middle bullet as-is', () => {
    const day = results.find((r) => r.patch.date === '2026-09-19').patch;
    assert.equal(day.phases[0].start, '07:56');
    assert.equal(day.phases[0].end, '09:18');
    assert.equal(day.phases[1].start, '');
    assert.match(day.phases[1].description, /Sod taken out/);
    assert.equal(day.phases[2].start, '09:26');
  });

  it('leaves "(Return, 11:37 - end)" on Sep 12 as description text, not a guessed time', () => {
    const day = results.find((r) => r.patch.date === '2026-09-12').patch;
    const returnPhase = day.phases.find((p) => /^\(Return/.test(p.description));
    assert.ok(returnPhase);
    assert.equal(returnPhase.start, '');
  });
});
