import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bpmRevisionFromNotes, classifySoil, classifyTask, daySoil, nonLaborReason } from '../src/metGlossary.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.01, `expected ${actual} ≈ ${expected}`);
const hot = { feelsLikeF: 100 };
const mild = { feelsLikeF: 81 };

describe('§1 soil tiers', () => {
  it('ranks harder descriptors above softer ones, and softness above bare clay', () => {
    assert.equal(classifySoil('red North Alabama clay that\'s compacted & has rocks').code, 'HCP');
    assert.equal(classifySoil('clay, dry hard clay with mix of grass').label, 'Dry hard clay');
    assert.equal(classifySoil('clay: soft brownish-red Alabama').code, 'SC');
    assert.equal(classifySoil('just clay').code, 'MC');
    assert.equal(classifySoil('red clay').code, 'HC');
  });

  it('reads day-level soil only from lines that talk about ground', () => {
    const block = '• Trench out sprinkler lines\n• NOTE: digging clay is red North Alabama clay that\'s compacted & has rocks';
    assert.equal(daySoil(block).code, 'HCP');
    assert.equal(daySoil('• Implement Bermuda sod (compacted, wet damped pieces)'), null, 'compacted sod is not soil');
  });
});

describe('classifyTask — real calendar clauses', () => {
  it('Sep 12: pickaxe dig in compacted red clay is HCP, midpoint on a mild day', () => {
    const r = classifyTask('Dig out retaining wall foundation (clay: red compacted Alabama dirt with rocks & foreign debris) with pickaxe and longhead shovel', mild);
    close(r.met, 8.25);
    assert.equal(r.soilCode, 'HCP');
    assert.equal(r.confidence, 'high');
  });

  it('heat ≥88°F confirms the upper end of the range instead of adding MET', () => {
    close(classifyTask('Repair sprinklers and inspect', { feelsLikeF: 104 }).met, 4.0);
    close(classifyTask('Repair sprinklers and inspect', { feelsLikeF: 80 }).met, 3.75);
  });

  it('shade stops heat from confirming the upper end', () => {
    close(classifyTask('Repair sprinklers and inspect', { feelsLikeF: 104, shade: true }).met, 3.75);
  });

  it('Sep 18: gravel by loaded wheelbarrow adds the wheelbarrow delta', () => {
    close(classifyTask('Continue hauling gravel via wheelbarrow & dump to designated area (then spread over)', { feelsLikeF: 104 }).met, 7.25);
  });

  it('"water sod" is maintenance, not sod laying', () => {
    close(classifyTask('Water sod', { feelsLikeF: 104 }).met, 4.0);
  });

  it('Sep 5: reproduces the glossary\'s own "initially read as 7.5" for the semi-rush paver job', () => {
    close(classifyTask('Put paverstone on implement stack areas, semi-rush', { feelsLikeF: 106 }).met, 7.5);
  });

  it('Sep 15: mid-weight block wording takes the midpoint, glue at the tail blends down', () => {
    const r = classifyTask('Another line of retaining wall block install — move retaining wall blocks (not the heavy hollow core heavy duty but not small ones) into designated area, then insert glue on wall', { feelsLikeF: 102 });
    close(r.met, 6.5);
    assert.ok(!/SRW/.test(r.basis), '"not the heavy hollow core" must not read as SRW');
  });

  it('Sep 15: digging a sod edge in dry hard clay stays a dig, not sod laying', () => {
    close(classifyTask('Dig out sod edge for new sod area on backyard (clay, dry hard clay with mix of grass) then rake entire area via heavy duty rake', { feelsLikeF: 102 }).met, 8.0);
  });

  it('Sep 16: wet sod plus machete edge cutting', () => {
    close(classifyTask('Implement 4 remaining Bermuda sod (compacted, wet damped pieces) to designated area on backyard, then cut the edges via machete', hot).met, 8.5);
  });

  it('Sep 1: lumber carried up a steep hill adds the incline modifier', () => {
    close(classifyTask('Lift up and carry old tiny lumber pieces to trailer, steep hill to carry up', { feelsLikeF: 102, shade: true }).met, 8.25);
  });

  it('Sep 19: foundation dig with depth on soft soil uses the foundation band, ignoring sod in the soil note', () => {
    const r = classifyTask('Dig out dirt for concrete foundation (6 inches deep, clay: soft brownish-red Alabama with zorro sod)', { feelsLikeF: 99 });
    close(r.met, 7.0);
    assert.equal(r.soilCode, 'SC');
  });

  it('Sep 19 / Sep 14: dingo work splits machine and manual time evenly', () => {
    close(classifyTask('Level out 20x20 area with dingo then rake over, then dump gravel which was subsequently spread with shovel, then pack up', { feelsLikeF: 99 }).met, 6.0);
    close(classifyTask('Shovel & dump gravel to designated area via dingo skid steer, spread gravel behind foundation of retaining wall (not entire)', hot).met, 5.5);
  });

  it('Aug 25: mixing concrete by wheelbarrow does not double-count the wheelbarrow', () => {
    close(classifyTask('Bring sand, then mix with cement via wheelbarrow and implement it on paver patio foundation', { feelsLikeF: 89 }).met, 7.0);
  });

  it('pallet counts push sod to the upper end even without heat', () => {
    close(classifyTask('3 pallet sod, Zoysia sod', mild).met, 5.0);
  });

  it('Sep 3: sledgehammer on concrete is a flat 8.0', () => {
    close(classifyTask('Sledgehammer concrete pad walkway (subsequently will install patio)', hot).met, 8.0);
  });
});

describe('classifyTask — confidence and flags', () => {
  it('Aug 31: vague branch/wood hauling is flagged as a known under-description risk', () => {
    const r = classifyTask('Move cut branches and wood to front yard', { feelsLikeF: 102 });
    close(r.met, 6.0);
    assert.equal(r.confidence, 'low');
    assert.ok(r.notes.some((n) => /under-description/.test(n.text)));
  });

  it('a dig with no soil anywhere defaults to MC with a low-confidence warning', () => {
    const r = classifyTask('Backyard: dig a trench', { feelsLikeF: 105 });
    close(r.met, 6.0);
    assert.equal(r.soilCode, 'MC');
    assert.equal(r.confidence, 'low');
  });

  it('a dig with no soil in the clause takes the day\'s soil note at medium confidence', () => {
    const r = classifyTask('Trench out sprinkler lines (dig, remove remaining dirt out of trench)', { feelsLikeF: 96, daySoil: classifySoil('compacted red clay') });
    close(r.met, 8.5);
    assert.equal(r.confidence, 'medium');
  });

  it('falls back to the spec table for terms the glossary lacks, and says so', () => {
    const r = classifyTask('Backyard: carry and haul mulch via wheelbarrow & dump to designated bed then spread via rake', { feelsLikeF: 97 });
    close(r.met, 6.25);
    assert.ok(r.notes.some((n) => /spec §5 task table/.test(n.text)));
  });

  it('never assigns a MET silently when nothing matches', () => {
    const r = classifyTask('Miscellaneous work', hot);
    assert.equal(r.met, '');
    assert.ok(r.notes.some((n) => n.level === 'warn'));
  });

  it('marks a pack-up-only clause so the importer can limit its duration', () => {
    const r = classifyTask('Pack up equipment from that hill', hot);
    close(r.met, 4.0);
    assert.equal(r.packUp, true);
  });
});

describe('§6 non-labor', () => {
  it('recognizes return trips and lectures, and leaves real work alone', () => {
    assert.ok(nonLaborReason('Went to get gravel, wrong gravel so had to return, difficult (documented idle/travel, ~2h21m)'));
    assert.ok(nonLaborReason('Uni lectures — NOT active labor, sedentary block'));
    assert.equal(nonLaborReason('Continue hauling gravel via wheelbarrow'), null);
    assert.ok(classifyTask('Uni lectures — NOT active labor', hot).nonLabor);
  });
});

describe('BPM-confirmed revisions in NOTE lines', () => {
  it('reads "revised to MET", "revised up to MET" and "blended MET"', () => {
    assert.equal(bpmRevisionFromNotes('NOTE: HR showed … revised to MET 7.5 in DILIGENT.md against a task-only estimate of MET 5.5.').met, 7.5);
    assert.equal(bpmRevisionFromNotes('NOTE: Revised up to MET 9.0 against a task-based estimate of 6.75').met, 9.0);
    assert.equal(bpmRevisionFromNotes('NOTE: First downward MET revision — task read heavy (7.5) but HRR ~47%, revised to 6.0. See DILIGENT.md.').met, 6.0);
    const blended = bpmRevisionFromNotes('NOTE: heavy stretch 10:30-11:43 AM. Blended MET 7.12 (8.0 morning / 5.5 afternoon) rather than one flat value.');
    assert.equal(blended.met, 7.12);
    assert.equal(blended.blended, true);
  });

  it('ignores revisions outside NOTE lines and corrections that are not MET', () => {
    assert.equal(bpmRevisionFromNotes('• Task revised to 7.5 somehow'), null);
    assert.equal(bpmRevisionFromNotes('NOTE: Shift start corrected to 8:00 AM based on HR data'), null);
  });
});

describe('hand-picked soil class (regression)', () => {
  it('scores a phase from the chosen soil even with no dig verb or no description', () => {
    close(classifyTask('misc work in the back', { feelsLikeF: 80, soilCode: 'HC' }).met, 7.25);
    close(classifyTask('', { feelsLikeF: 80, soilCode: 'SC' }).met, 4.75);
  });

  it('maps each code to its general band, not the first tier that shares the code', () => {
    // HCP is the 8.0–8.5 pickaxe band (midpoint 8.25), not "dry hard clay" (flat 8.0).
    close(classifyTask('Dig footing', { feelsLikeF: 80, soilCode: 'HCP' }).met, 8.25);
    // HC is hard clay + gravel (7.0–7.5), not "wet clay" (flat 7.5).
    close(classifyTask('Dig footing', { feelsLikeF: 80, soilCode: 'HC' }).met, 7.25);
    close(classifyTask('Dig footing', { feelsLikeF: 80, soilCode: 'SRW' }).met, 9.0);
  });
});
