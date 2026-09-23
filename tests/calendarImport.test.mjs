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

  it('lists exactly what still needs to be filled in by hand — weight and intake are optional', () => {
    assert.deepEqual(unmatched.sort(), ['date', 'shift', 'siteCount'].sort());
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
    assert.equal(unmatched.length, 7);
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

  it('excludes the Sep 11 bulleted NOTE and the "…job" title bullet from tasks', () => {
    const day = results.find((r) => r.patch.date === '2026-09-11').patch;
    assert.equal(day.phases.length, 2);
    assert.ok(!day.phases.some((p) => /^NOTE|job$/i.test(p.description)));
    assert.match(day.notes, /Job: Sprinkler & retaining wall job/);
  });

  it('Sep 11 digs take the soil from the day\'s NOTE line (compacted red clay → HCP)', () => {
    const day = results.find((r) => r.patch.date === '2026-09-11').patch;
    const trench = day.phases.find((p) => /Trench/.test(p.description));
    assert.equal(trench.soilCode, 'HCP');
    assert.equal(trench.met, 8.5);
  });

  it('extracts per-bullet times on Sep 19 but leaves the untimed middle bullet as-is', () => {
    const day = results.find((r) => r.patch.date === '2026-09-19').patch;
    assert.equal(day.phases[0].start, '07:56');
    assert.equal(day.phases[0].end, '09:18');
    assert.equal(day.phases[1].start, '');
    assert.match(day.phases[1].description, /Sod taken out/);
    assert.equal(day.phases[2].start, '09:26');
  });

  it('resolves "(Return, 11:37 - end)" on Sep 12 against that day\'s own logged shift end', () => {
    const day = results.find((r) => r.patch.date === '2026-09-12').patch;
    const returnPhase = day.phases.find((p) => /^Dump gravel/.test(p.description));
    assert.ok(returnPhase);
    assert.equal(returnPhase.start, '11:37');
    assert.equal(returnPhase.end, '12:12');
  });

  it('applies the BPM-confirmed revision from the Aug 31 note over the task-based estimate', () => {
    const day = results.find((r) => r.patch.date === '2026-08-31').patch;
    assert.equal(day.phases[0].met, 7.5);
    assert.equal(day.phases[0].metSource, 'bpm-note');
  });

  it('reads "Lunch break: post shift" as nothing to subtract, not as missing', () => {
    const r = results.find((x) => x.patch.date === '2026-09-12');
    assert.ok(!r.unmatched.includes('lunch'));
    assert.match(r.patch.notes, /outside the shift window/);
  });
});

describe('reading the day — times, non-labor time and automatic MET', () => {
  const SEP2 = `Date: 2026-09-02
Shift: 7:25 AM - 4:09 PM
94° (Feels 100° Sunny)
Breaks: 3
(Lunch break 12:22 - 12:59)

• (Beginning - 8:49) Remove brick patio by shovel, haul to trailer
• (8:49 - after lunch) Uni lectures — NOT active labor, sedentary block
• (Post lunch - end shift) Clean up backyard, hauling debris (branches, bushes, stone) to trailer`;

  it('resolves "Beginning", "after lunch" and "end shift" to the day\'s logged times', () => {
    const { patch } = parseCalendarLog(SEP2);
    assert.equal(patch.phases.length, 2, 'the lecture block is not a phase');
    assert.deepEqual([patch.phases[0].start, patch.phases[0].end], ['07:25', '08:49']);
    assert.deepEqual([patch.phases[1].start, patch.phases[1].end], ['12:59', '16:09']);
  });

  it('excludes the lecture block from active time, net of the lunch it overlaps', () => {
    const { patch } = parseCalendarLog(SEP2);
    // 8:49 → 12:59 is 250 min, minus the 37-min lunch already subtracted.
    assert.equal(patch.transitMinutes, 213);
    assert.match(patch.notes, /Excluded 213 min of non-labor time/);
  });

  it('assigns every labor phase a MET from the glossary with its reasoning', () => {
    const { patch, metReport } = parseCalendarLog(SEP2);
    assert.equal(patch.phases[0].met, 6.5, 'brick removal by shovel');
    assert.match(patch.phases[0].metBasis, /Brick \/ paver removal/);
    assert.equal(patch.phases[1].metConfidence, 'low', 'branch/brush hauling is a known under-description risk');
    assert.equal(metReport.phases, 2);
  });

  const AUG27 = `Date: 2026-08-27
Shift: 9:11 AM - 5:40 PM
89° (Feels 93° Sunny)
Breaks: 6
(Lunch break 12:46 - 1:45)

• Sod work, left 10:25
• Went to get gravel, wrong gravel so had to return, difficult (documented idle/travel, ~2h21m)
• Arrived 1:45, peel for flowerbed & implement gravel, plant 5 little plants (left 4:23)
• Arrived 4:33, polymer sand joint on patio and pack up all equipment and materials`;

  it('builds multi-site windows from "left"/"Arrived" markers, reading bare times against the shift', () => {
    const { patch } = parseCalendarLog(AUG27);
    const [sod, beds, polymer] = patch.phases;
    assert.deepEqual([sod.start, sod.end], ['09:11', '10:25']);
    assert.deepEqual([beds.start, beds.end], ['13:45', '16:23'], '1:45 and 4:23 fall in the afternoon of this shift');
    assert.deepEqual([polymer.start, polymer.end], ['16:33', '17:40']);
    assert.equal(beds.description, 'peel for flowerbed & implement gravel, plant 5 little plants');
  });

  it('takes a stated idle duration as excluded time', () => {
    const { patch } = parseCalendarLog(AUG27);
    assert.equal(patch.transitMinutes, 141);
  });

  it('limits an untimed pack-up-only block to 10 minutes', () => {
    const { patch } = parseCalendarLog(`Date: 2026-09-01\nShift: 1:22 PM - 5:29 PM\n• Implement thick landscape lumber to flowerbed\n• Pack up equipment from that hill`);
    const pack = patch.phases.find((p) => /Pack up/.test(p.description));
    assert.equal(pack.netMinutesOverride, 10);
  });

  it('skips payroll-only entries in a multi-day file', () => {
    const results = parseMultiDayLog('STARTING PAY.\n\n---\n\nDate: 2026-09-21\nShift: 8:00 AM - 4:00 PM\n• Water sod');
    assert.equal(results[0].patch, null);
    assert.equal(results[0].skipped, 'payroll entry');
    assert.equal(results[1].patch.date, '2026-09-21');
  });
});

describe('job-title bullets (regression)', () => {
  it('keeps a real task that merely ends in "day" as a phase', () => {
    const { patch } = parseCalendarLog('Date: 2026-09-21\nShift: 8:00 AM - 4:00 PM\n• Mow and edge lawn all day\n• Water sod');
    assert.equal(patch.phases.length, 2);
    assert.doesNotMatch(patch.notes, /Job:/);
  });

  it('still reads short titles like "Sod day" and any "…job" as the job name', () => {
    const a = parseCalendarLog('Date: 2026-09-16\n• Sod day\n• Implement Bermuda sod').patch;
    assert.equal(a.phases.length, 1);
    assert.match(a.notes, /Job: Sod day/);
    const b = parseCalendarLog('Date: 2026-08-25\n• Flexstone patio from foundation on former thick concrete slab job\n• Bring sand, mix with cement').patch;
    assert.equal(b.phases.length, 1);
  });
});

describe('DILIGENT IV §8 data-quality flags from calendar text', () => {
  const flagsOf = (text) => (parseCalendarLog(text).patch.importFlags || []).map((f) => f.text).join('\n');

  it('flags a "half." title as carrying no duration information', () => {
    assert.match(flagsOf('half.\nDate: 2026-08-19\nShift: 7:15 AM - 3:10 PM\n\n• Dirt haul'), /"half\." title carries no duration/);
  });

  it('flags a start_time inside the logged lunch, or before 4 AM — but not an afternoon shift starting after lunch', () => {
    assert.match(flagsOf('Date: 2026-08-19\nShift: 12:44 PM - 3:10 PM\n(Lunch break 12:01 - 1:00)\n\n• Dirt haul'), /inside the logged lunch/);
    assert.equal(parseCalendarLog('Date: 2026-09-03\nShift: 1:16 PM - 3:52 PM\n(Lunch break 12:22 - 1:16)\n\n• Backyard: dig a trench').patch.importFlags, undefined);
    assert.match(flagsOf('Date: 2026-08-24\nShift: 1:12 AM - 5:52 PM\n\n• Reorganize materials'), /before 4 AM/);
    assert.equal(parseCalendarLog('Date: 2026-08-21\nShift: 8:10 AM - 11:45 AM\n\n• Repair edge').patch.importFlags, undefined);
  });

  it('flags an empty enumerated task item', () => {
    assert.match(flagsOf('Date: 2026-09-04\nShift: 7:39 AM - 4:38 PM\n\n1.)\n'), /task item is empty/);
  });

  it('records a downward BPM revision with a warning, and says "downward" in the basis', () => {
    const { patch } = parseCalendarLog('Date: 2026-09-05\nShift: 7:00 AM - 2:00 PM\nFeels 106°\n\n• Put paverstone on implement stack areas, semi-rush\n\nNOTE: First downward MET revision — task read heavy (7.5) but HRR ~47%, revised to 6.0.');
    assert.equal(patch.phases[0].met, 6.0);
    assert.match(patch.phases[0].metBasis, /downward revision/);
    assert.ok(patch.importFlags.some((f) => f.level === 'warn' && /Downward BPM revision/.test(f.text)));
  });
});
