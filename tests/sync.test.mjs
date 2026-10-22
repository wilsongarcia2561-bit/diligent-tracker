import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import * as store from '../src/store.js';

const entry = (date, extra = {}) => ({ ...store.newEntry(date), ...extra });
const later = '2999-01-01T00:00:00.000Z';
const earlier = '2000-01-01T00:00:00.000Z';

describe('sync bookkeeping and merging', () => {
  beforeEach(() => store.clearAll());

  it('stamps every local change with the key it touched', () => {
    const seen = [];
    const off = store.onLocalChange((k) => seen.push(k));
    store.saveEntry(entry('2026-09-01'));
    store.deleteEntry('2026-09-01');
    store.upsertWeight({ date: '2026-09-02', kg: 58, note: '' });
    store.updateSettings({ breakMinutesDefault: 12 });
    off();
    assert.deepEqual(seen, ['e:2026-09-01', 'e:2026-09-01', 'w', 's']);
    assert.equal(store.syncRecord('e:2026-09-01').del, true, 'the delete is a tombstone, not a hole');
  });

  it('takes a newer remote day and ignores an older or equal one', () => {
    store.saveEntry(entry('2026-09-01', { notes: 'mine' }));
    const at = store.syncAt('e:2026-09-01');
    assert.deepEqual(store.applyRemote([{ k: 'e:2026-09-01', at: earlier, del: false, v: entry('2026-09-01', { notes: 'stale' }) }]), []);
    assert.deepEqual(store.applyRemote([{ k: 'e:2026-09-01', at, del: false, v: entry('2026-09-01', { notes: 'echo' }) }]), []);
    assert.equal(store.getEntry('2026-09-01').notes, 'mine');
    assert.deepEqual(store.applyRemote([{ k: 'e:2026-09-01', at: later, del: false, v: entry('2026-09-01', { notes: 'theirs' }) }]), ['e:2026-09-01']);
    assert.equal(store.getEntry('2026-09-01').notes, 'theirs');
  });

  it('applies a remote deletion, and a later local save revives the day', () => {
    store.saveEntry(entry('2026-09-01'));
    store.applyRemote([{ k: 'e:2026-09-01', at: later, del: true, v: null }]);
    assert.ok(!store.getEntry('2026-09-01'));
    assert.equal(store.syncRecord('e:2026-09-01').del, true);
  });

  it('does not treat applying remote changes as a local edit', () => {
    const seen = [];
    const off = store.onLocalChange((k) => seen.push(k));
    store.applyRemote([{ k: 'e:2026-09-05', at: later, del: false, v: entry('2026-09-05') }]);
    off();
    assert.deepEqual(seen, [], 'nothing is sent back out');
  });

  it('erase-all tombstones everything so another device cannot restore it', () => {
    store.saveEntry(entry('2026-09-01'));
    store.clearAll();
    assert.equal(store.syncRecord('e:2026-09-01').del, true);
    // A stale device still holding the old day (older than the erase) is refused.
    assert.deepEqual(store.applyRemote([{ k: 'e:2026-09-01', at: earlier, del: false, v: entry('2026-09-01') }]), []);
    assert.ok(!store.getEntry('2026-09-01'));
  });

  it('follows the weight log to the bodyweight in effect', () => {
    store.applyRemote([{ k: 'w', at: later, del: false, v: [{ date: '2026-09-20', kg: 61.2, note: '' }] }]);
    assert.equal(store.weightForDate('2026-09-25'), 61.2);
    assert.equal(store.getSettings().weightKg, 61.2);
  });

  it('ignores malformed documents instead of corrupting local data', () => {
    store.saveEntry(entry('2026-09-01', { notes: 'safe' }));
    const bad = [null, {}, { k: 'e:not-a-date', at: later, v: {} }, { k: 'e:2026-09-01', at: later, del: false, v: 'oops' }, { k: 'h:2026-09-01', at: later, v: 'nope' }, { k: 'x:1', at: later, v: {} }];
    assert.deepEqual(store.applyRemote(bad), []);
    assert.equal(store.getEntry('2026-09-01').notes, 'safe');
  });

  it('a restored backup overrides other devices and deletes what it leaves out', () => {
    store.saveEntry(entry('2026-09-01'));
    store.saveEntry(entry('2026-09-02'));
    store.importJson(JSON.stringify({ entries: { '2026-09-02': entry('2026-09-02', { notes: 'restored' }) }, weightLog: [], settings: {} }));
    assert.equal(store.syncRecord('e:2026-09-01').del, true);
    assert.equal(store.getEntry('2026-09-02').notes, 'restored');
  });

  it('keeps an imported row\'s weight on the day without adding it to the weight log', () => {
    const before = store.listWeights().length;
    store.saveEntry(entry('2026-06-01', { weightKg: 57.6 }), { logWeight: false });
    assert.equal(store.listWeights().length, before);
    store.saveEntry(entry('2026-06-02', { weightKg: 58.2 }));
    assert.equal(store.listWeights().length, before + 1);
  });

  it('logs a day\'s weight only when it is entered or changed, not on every re-save', () => {
    const before = store.listWeights().length;
    store.saveEntry(entry('2026-10-09', { weightKg: 57.6 }), { logWeight: false });
    store.saveEntry({ ...store.getEntry('2026-10-09'), notes: 'edited' });
    assert.equal(store.listWeights().length, before, 'an edit that leaves the weight alone does not log it');
    store.saveEntry({ ...store.getEntry('2026-10-09'), weightKg: 58.1 });
    assert.equal(store.listWeights().length, before + 1, 'a changed weight is logged');
  });
});

