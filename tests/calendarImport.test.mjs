import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCalendarLog } from '../src/calendarImport.js';

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
