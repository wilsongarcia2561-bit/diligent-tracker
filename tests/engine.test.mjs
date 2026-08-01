import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MODEL,
  activeKcal,
  allocatePhaseMinutes,
  bpmCorrection,
  calculateDay,
  captureRateCheck,
  computeNetWorkMinutes,
  durationMinutes,
  hrrPercent,
  metFromHrr,
  modelOffset,
  parseTime,
  rollingAverage,
  selectModel,
  suggestBackgroundTier,
  suggestMet,
  suggestNeatTier,
  suggestTef,
  summarizeTrends,
  validateWithBpm,
} from '../src/engine.js';

const SETTINGS = { bmr: 1436, breakMinutesDefault: 11, restingHr: 49, maxHr: 201, weightKg: 57.6 };

const close = (actual, expected, tol = 0.01) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${actual} to be within ${tol} of ${expected}`);

/* ------------------------------------------------------------------ */

describe('§3 model selection', () => {
  it('uses Intermediate below MET 6.5 in cool conditions', () => {
    const { model, reasons } = selectModel({ met: 5.0, feelsLikeF: 80, soilCode: 'SC' });
    assert.equal(model, MODEL.INTERMEDIATE);
    assert.deepEqual(reasons, []);
  });

  it('uses KRI at MET 6.5 exactly', () => {
    assert.equal(selectModel({ met: 6.5, feelsLikeF: 70 }).model, MODEL.KRI);
  });

  it('uses KRI on heat alone at exactly 88°F feels-like', () => {
    const { model, reasons } = selectModel({ met: 4.5, feelsLikeF: 88 });
    assert.equal(model, MODEL.KRI);
    assert.match(reasons[0], /Feels-like 88/);
  });

  it('does not trigger KRI at 87°F', () => {
    assert.equal(selectModel({ met: 4.5, feelsLikeF: 87 }).model, MODEL.INTERMEDIATE);
  });

  it('uses KRI for HC/HCP/SRW soil regardless of MET and heat', () => {
    for (const code of ['HC', 'HCP', 'SRW']) {
      assert.equal(selectModel({ met: 3.0, feelsLikeF: 60, soilCode: code }).model, MODEL.KRI, code);
    }
    assert.equal(selectModel({ met: 3.0, feelsLikeF: 60, soilCode: 'MC' }).model, MODEL.INTERMEDIATE);
  });

  it('uses KRI for a sustained vigorous day', () => {
    assert.equal(selectModel({ met: 4.0, feelsLikeF: 70, vigorous: true }).model, MODEL.KRI);
  });

  it('ignores an undocumented feels-like value rather than guessing', () => {
    assert.equal(selectModel({ met: 5.0, feelsLikeF: null }).model, MODEL.INTERMEDIATE);
  });
});

describe('§3 model offsets and active kcal', () => {
  it('applies the documented MET offsets', () => {
    assert.equal(modelOffset(MODEL.RAW), 0);
    assert.equal(modelOffset(MODEL.INTERMEDIATE), 1.0);
    assert.equal(modelOffset(MODEL.KRI), 0.5);
  });

  it('computes (MET − 1.0) × kg × hrs for Intermediate', () => {
    close(activeKcal({ met: 5.0, model: MODEL.INTERMEDIATE, kg: 57.6, hours: 4 }), 4.0 * 57.6 * 4);
  });

  it('computes (MET − 0.5) × kg × hrs for KRI', () => {
    close(activeKcal({ met: 7.5, model: MODEL.KRI, kg: 57.6, hours: 3 }), 7.0 * 57.6 * 3);
  });

  it('computes MET × kg × hrs for Kcal Raw', () => {
    close(activeKcal({ met: 7.5, model: MODEL.RAW, kg: 57.6, hours: 3 }), 7.5 * 57.6 * 3);
  });

  it('never returns negative calories for sub-floor METs', () => {
    assert.equal(activeKcal({ met: 0.8, model: MODEL.INTERMEDIATE, kg: 57.6, hours: 2 }), 0);
  });

  it('keeps Kcal Raw above the models used for TDEE (the double-count it represents)', () => {
    const args = { met: 8.0, kg: 57.6, hours: 5 };
    const raw = activeKcal({ ...args, model: MODEL.RAW });
    const kri = activeKcal({ ...args, model: MODEL.KRI });
    const inter = activeKcal({ ...args, model: MODEL.INTERMEDIATE });
    assert.ok(raw > kri && kri > inter);
    close(raw - kri, 0.5 * 57.6 * 5);
    close(raw - inter, 1.0 * 57.6 * 5);
  });
});

describe('time parsing', () => {
  it('parses HH:MM', () => {
    assert.equal(parseTime('07:30'), 450);
    assert.equal(parseTime('7:30'), 450);
    assert.equal(parseTime(''), null);
    assert.equal(parseTime('25:00'), null);
  });

  it('measures durations and rolls past midnight', () => {
    assert.equal(durationMinutes('07:00', '15:30'), 510);
    assert.equal(durationMinutes('22:00', '02:00'), 240);
    assert.equal(durationMinutes('', '15:30'), 0);
  });
});

describe('§8 net work time', () => {
  it('subtracts lunch, breaks and transit from the gross shift', () => {
    const t = computeNetWorkMinutes(
      { shiftStart: '07:00', shiftEnd: '16:00', lunchStart: '12:00', lunchEnd: '12:30', breakCount: 2, transitMinutes: 20 },
      11,
    );
    assert.equal(t.grossMinutes, 540);
    assert.equal(t.lunchMinutes, 30);
    assert.equal(t.breakMinutes, 22);
    assert.equal(t.netWorkMinutes, 540 - 30 - 22 - 20);
  });

  it('defaults breaks to 11 min per session and marks them estimated', () => {
    const t = computeNetWorkMinutes({ shiftStart: '07:00', shiftEnd: '15:00', breakCount: 3 }, 11);
    assert.equal(t.breakMinutes, 33);
    assert.equal(t.breakEstimated, true);
  });

  it('prefers exact break minutes over the estimate', () => {
    const t = computeNetWorkMinutes({ shiftStart: '07:00', shiftEnd: '15:00', breakCount: 3, breakMinutesActual: 18 }, 11);
    assert.equal(t.breakMinutes, 18);
    assert.equal(t.breakEstimated, false);
  });

  it('splits embedded work out of a lunch block so only eating time is deducted', () => {
    const t = computeNetWorkMinutes(
      { shiftStart: '07:00', shiftEnd: '16:00', lunchStart: '12:00', lunchEnd: '13:00', lunchEmbeddedMinutes: 25 },
      11,
    );
    assert.equal(t.lunchMinutes, 60);
    assert.equal(t.eatingMinutes, 35);
    assert.equal(t.netWorkMinutes, 540 - 35);
  });
});

describe('§5/§8 phase time allocation', () => {
  it('prorates net work time by gross phase length', () => {
    const phases = [
      { id: 'a', start: '07:00', end: '11:00', netMinutesOverride: '' },
      { id: 'b', start: '11:00', end: '15:00', netMinutesOverride: '' },
    ];
    const out = allocatePhaseMinutes(phases, 420);
    close(out[0].netMinutes, 210);
    close(out[1].netMinutes, 210);
  });

  it('weights unequal phases proportionally', () => {
    const phases = [
      { id: 'a', start: '07:00', end: '13:00', netMinutesOverride: '' }, // 360
      { id: 'b', start: '13:00', end: '15:00', netMinutesOverride: '' }, // 120
    ];
    const out = allocatePhaseMinutes(phases, 440);
    close(out[0].netMinutes, 330);
    close(out[1].netMinutes, 110);
  });

  it('honours exact per-phase net minutes and prorates only the remainder', () => {
    const phases = [
      { id: 'a', start: '07:00', end: '10:00', netMinutesOverride: 150 },
      { id: 'b', start: '10:00', end: '13:00', netMinutesOverride: '' },
      { id: 'c', start: '13:00', end: '15:00', netMinutesOverride: '' },
    ];
    const out = allocatePhaseMinutes(phases, 450);
    assert.equal(out[0].netMinutes, 150);
    assert.equal(out[0].exact, true);
    close(out[1].netMinutes, 180); // 300 remaining × 180/300
    close(out[2].netMinutes, 120);
  });

  it('splits evenly when no phase timestamps are usable', () => {
    const out = allocatePhaseMinutes(
      [{ id: 'a', netMinutesOverride: '' }, { id: 'b', netMinutesOverride: '' }],
      400,
    );
    close(out[0].netMinutes, 200);
    close(out[1].netMinutes, 200);
  });
});

describe('§6 BPM correction and HRR', () => {
  it('applies the documented correction bands', () => {
    assert.equal(bpmCorrection(100).add, 30);
    assert.equal(bpmCorrection(140).add, 35);
    const nearMax = bpmCorrection(165);
    assert.equal(nearMax.add, 35);
    assert.equal(nearMax.addMax, 50);
  });

  it('applies no correction outside the documented bands', () => {
    assert.equal(bpmCorrection(60).add, 0);
    assert.equal(bpmCorrection(190).add, 0);
  });

  it('computes HRR% against the 49/201 baseline', () => {
    close(hrrPercent(125), (125 - 49) / 152, 0.0001);
    close(hrrPercent(49), 0, 0.0001);
  });

  it('maps HRR% to the reference MET bands', () => {
    assert.deepEqual(
      { metMin: metFromHrr(0.5).metMin, metMax: metFromHrr(0.5).metMax },
      { metMin: 5.5, metMax: 6.5 },
    );
    assert.equal(metFromHrr(0.6).metMin, 6.5);
    assert.equal(metFromHrr(0.9).metMax, 12.0);
    assert.equal(metFromHrr(0.2), null);
  });

  it('validates a task MET the corrected BPM supports', () => {
    // watch 130 → +35 → 165 → HRR (165−49)/152 = 76% → MET 8.5–9.5
    const r = validateWithBpm({ watchBpm: 130, taskMet: 9.0 });
    assert.equal(r.correctedBpm, 165);
    close(r.hrr, 0.7632, 0.001);
    assert.equal(r.verdict, 'validates');
  });

  it('flags a task MET the BPM says is too low', () => {
    const r = validateWithBpm({ watchBpm: 130, taskMet: 5.0 });
    assert.equal(r.verdict, 'revise-up');
    assert.match(r.message, /Revise task MET upward/);
  });

  it('keeps the task MET when BPM reads lower rather than silently reducing it', () => {
    const r = validateWithBpm({ watchBpm: 95, taskMet: 9.0 });
    assert.equal(r.verdict, 'below');
  });
});

describe('§7 capture rate', () => {
  it('accepts a rate inside the expected band', () => {
    const c = captureRateCheck({ samsungActiveMinutes: 240, netWorkMinutes: 400, captureCategory: 'digging' });
    close(c.rate, 0.6);
    assert.equal(c.status, 'expected');
  });

  it('flags a rate far below the expected band', () => {
    const c = captureRateCheck({ samsungActiveMinutes: 100, netWorkMinutes: 400, captureCategory: 'highStep' });
    assert.equal(c.status, 'low');
  });

  it('returns nothing without a Samsung reading', () => {
    assert.equal(captureRateCheck({ samsungActiveMinutes: '', netWorkMinutes: 400, captureCategory: 'digging' }), null);
  });
});

describe('§5 MET suggestion', () => {
  it('matches task keywords', () => {
    const s = suggestMet('wet sod wheelbarrow to the back slope');
    assert.equal(s.id, 'wet-sod-barrow');
    assert.equal(s.metMin, 7.5);
    assert.equal(s.met, 7.8);
  });

  it('matches soil classifications from prose', () => {
    assert.equal(suggestMet('breaking up hard clay with a pickaxe').id, 'HCP');
  });

  it('falls back to an explicit soil code when the text says nothing useful', () => {
    assert.equal(suggestMet('misc site work', 'HC').id, 'HC');
  });

  it('returns null when nothing matches', () => {
    assert.equal(suggestMet('paperwork'), null);
  });
});

describe('§9/§10/§11 estimated lines', () => {
  it('scales NEAT with day intensity', () => {
    assert.equal(suggestNeatTier({ netWorkMinutes: 240 }).id, 'light');
    assert.equal(suggestNeatTier({ netWorkMinutes: 420 }).id, 'standard');
    assert.equal(suggestNeatTier({ netWorkMinutes: 540 }).id, 'heavy');
    assert.equal(suggestNeatTier({ netWorkMinutes: 400, feelsLikeF: 96 }).id, 'heavy');
    assert.equal(suggestNeatTier({ netWorkMinutes: 600, restDay: true }).id, 'light');
  });

  it('scales background with commute load, not intensity', () => {
    assert.equal(suggestBackgroundTier({ siteCount: 1 }).kcal, 225);
    assert.equal(suggestBackgroundTier({ siteCount: 2 }).kcal, 275);
    assert.equal(suggestBackgroundTier({ siteCount: 3 }).kcal, 300);
    assert.equal(suggestBackgroundTier({ siteCount: 1, outOfStateSupplyRun: true }).kcal, 300);
  });

  it('holds TEF at 210 unless intake differs significantly', () => {
    assert.equal(suggestTef('').kcal, 210);
    assert.equal(suggestTef(2100).kcal, 210);
    assert.equal(suggestTef(2100).adjusted, false);
    const high = suggestTef(3200);
    assert.equal(high.kcal, 320);
    assert.equal(high.adjusted, true);
  });
});

describe('§1 full-day calculation', () => {
  const baseDay = {
    date: '2026-07-24',
    shiftStart: '07:00',
    shiftEnd: '16:00',
    lunchStart: '12:00',
    lunchEnd: '12:30',
    breakCount: 2,
    transitMinutes: 0,
    feelsLikeF: 95,
    siteCount: 1,
    weightKg: 57.6,
    phases: [
      { id: 'a', description: 'HC digging', soilCode: 'HC', met: 7.2, start: '07:00', end: '12:00' },
      { id: 'b', description: 'pine straw spreading', met: 4.8, start: '12:30', end: '16:00' },
    ],
  };

  it('adds every component exactly once', () => {
    const calc = calculateDay(baseDay, SETTINGS);
    const { bmr, active, neat, tef, background } = calc.components;
    close(calc.tdee, bmr + active + neat + tef + background, 0.001);
    assert.equal(bmr, 1436);
    assert.equal(tef, 210);
  });

  it('applies KRI to both phases when feels-like is ≥88°F', () => {
    const calc = calculateDay(baseDay, SETTINGS);
    assert.equal(calc.phases[0].model, MODEL.KRI);
    assert.equal(calc.phases[1].model, MODEL.KRI);
    assert.match(calc.phases[1].kriReasons.join(), /Feels-like 95/);
  });

  it('mixes models per phase when the day is cool', () => {
    const calc = calculateDay({ ...baseDay, feelsLikeF: 78 }, SETTINGS);
    assert.equal(calc.phases[0].model, MODEL.KRI, 'HC soil forces KRI');
    assert.equal(calc.phases[1].model, MODEL.INTERMEDIATE, 'MET 4.8 in cool weather stays Intermediate');
    assert.equal(calc.comparison.mixed, true);
  });

  it('reproduces the active kcal by hand', () => {
    const calc = calculateDay({ ...baseDay, feelsLikeF: 78 }, SETTINGS);
    // gross 540 − lunch 30 − breaks 22 = 488 net; phase gross 300 and 210 (510 total)
    const netA = (488 * 300) / 510;
    const netB = (488 * 210) / 510;
    close(calc.phases[0].netMinutes, netA, 0.01);
    close(calc.phases[0].kcal, (7.2 - 0.5) * 57.6 * (netA / 60), 0.01);
    close(calc.phases[1].kcal, (4.8 - 1.0) * 57.6 * (netB / 60), 0.01);
  });

  it('never lets Kcal Raw reach the TDEE total', () => {
    const calc = calculateDay(baseDay, SETTINGS);
    assert.ok(calc.comparison.raw > calc.comparison.used);
    assert.equal(calc.components.active, calc.comparison.used);
  });

  it('honours a manual model override and flags it', () => {
    const day = {
      ...baseDay,
      feelsLikeF: 78,
      phases: [{ ...baseDay.phases[1], modelOverride: MODEL.KRI }],
    };
    const calc = calculateDay(day, SETTINGS);
    assert.equal(calc.phases[0].model, MODEL.KRI);
    assert.equal(calc.phases[0].modelOverridden, true);
    assert.ok(calc.flags.some((f) => /model manually set/.test(f.text)));
  });

  it('zeroes active work on a rest day but keeps the other components', () => {
    const calc = calculateDay({ ...baseDay, restDay: true }, SETTINGS);
    assert.equal(calc.components.active, 0);
    assert.equal(calc.phases.length, 0);
    close(calc.tdee, 1436 + 75 + 210 + 225, 0.001);
  });

  it('uses the per-entry weight over the settings default', () => {
    const heavier = calculateDay({ ...baseDay, weightKg: 60 }, SETTINGS);
    const lighter = calculateDay({ ...baseDay, weightKg: 55 }, SETTINGS);
    assert.ok(heavier.components.active > lighter.components.active);
  });

  it('reports a deficit or surplus against logged intake', () => {
    const calc = calculateDay({ ...baseDay, intakeKcal: 2500 }, SETTINGS);
    close(calc.balance, 2500 - calc.tdee, 0.001);
  });

  it('flags an inferential heat trigger', () => {
    const calc = calculateDay({ ...baseDay, feelsLikeF: '', heatInferred: true }, SETTINGS);
    assert.ok(calc.flags.some((f) => /inferentially/.test(f.text)));
  });

  it('flags a day with no BPM data', () => {
    const calc = calculateDay(baseDay, SETTINGS);
    assert.ok(calc.flags.some((f) => /No BPM data/.test(f.text)));
  });

  it('flags deductions that exceed the shift', () => {
    const calc = calculateDay({ ...baseDay, transitMinutes: 600 }, SETTINGS);
    assert.ok(calc.flags.some((f) => f.level === 'error' && /exceed the shift/.test(f.text)));
    assert.equal(calc.timing.netWorkMinutes, 0, 'net work time is floored at zero');
    assert.equal(calc.components.active, 0);
  });

  it('does not flag phase windows that simply bracket the lunch gap', () => {
    const calc = calculateDay(baseDay, SETTINGS);
    assert.ok(!calc.flags.some((f) => /Phase windows total/.test(f.text)));
  });

  it('does flag phase windows that miss a real chunk of the shift', () => {
    const short = {
      ...baseDay,
      phases: [{ id: 'a', description: 'HC digging', soilCode: 'HC', met: 7.2, start: '07:00', end: '10:00' }],
    };
    assert.ok(calculateDay(short, SETTINGS).flags.some((f) => /Phase windows total/.test(f.text)));
  });

  it('flags a missing bodyweight', () => {
    const calc = calculateDay({ ...baseDay, weightKg: '' }, { ...SETTINGS, weightKg: 0 });
    assert.ok(calc.flags.some((f) => f.level === 'error' && /bodyweight/.test(f.text)));
  });

  it('splits a multi-site day and picks the right background tier', () => {
    const calc = calculateDay({ ...baseDay, siteCount: '', phases: [
      { id: 'a', description: 'sod', site: 'Bailey Cove', met: 4.8, start: '07:00', end: '11:00' },
      { id: 'b', description: 'mulch', site: 'Hampton Cove', met: 5.2, start: '11:00', end: '16:00' },
    ] }, SETTINGS);
    assert.equal(calc.siteCount, 2);
    assert.equal(calc.components.background, 275);
  });
});

describe('§12.6 trends', () => {
  it('computes a rolling average over the available window', () => {
    const points = [
      { date: '2026-07-01', value: 3000 },
      { date: '2026-07-02', value: 3200 },
      { date: '2026-07-03', value: 2800 },
    ];
    const rolled = rollingAverage(points, 7);
    close(rolled[0].value, 3000);
    close(rolled[1].value, 3100);
    close(rolled[2].value, 3000);
  });

  it('separates work-day and rest-day averages', () => {
    const summary = summarizeTrends([
      { date: '2026-07-01', tdee: 3400, restDay: false, components: { active: 1500 } },
      { date: '2026-07-02', tdee: 3600, restDay: false, components: { active: 1700 } },
      { date: '2026-07-03', tdee: 1950, restDay: true, components: { active: 0 } },
    ]);
    close(summary.workDayAverage, 3500);
    close(summary.restDayAverage, 1950);
    assert.equal(summary.workDayCount, 2);
    assert.equal(summary.restDayCount, 1);
    close(summary.activeAverage, 1600);
  });
});
