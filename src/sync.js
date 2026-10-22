/**
 * Cross-device sync through the artifact's `db` capability.
 *
 * Every day, every day's watch heart rate, the weight log and the settings
 * are one small document under the signed-in person's private area
 * (`data/users/<id>/…`), so only they can read it — even if the artifact is
 * shared. localStorage stays the working copy: the app renders from it
 * instantly, works offline, and this layer reconciles with the database in
 * the background. The newest change to each document wins.
 *
 * Outside the artifact viewer (a local `python3 server.py` run) there is no
 * `window.claude`, sync stays off, and the app behaves as it always did.
 */

import * as store from './store.js';

const CONCURRENCY = 4;
const PUSH_DELAY_MS = 400;
const RETRY_MS = 8000;

const listeners = new Set();
let status = { state: 'off', pending: 0, lastSync: null, message: 'Sync is off — this device only.' };

export const getStatus = () => ({ ...status });
export function onStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function setStatus(patch) {
  status = { ...status, ...patch };
  listeners.forEach((fn) => fn(getStatus()));
}

/**
 * "e:2026-09-09" ↔ "e_2026-09-09" (a day), "r:…" ↔ "r_…" (that day's watch
 * heart rate). Anything else in the collection — such as "h_…" documents
 * left by the retired corrected-BPM framework — is ignored.
 */
const docIdFor = (key) => (key === 'w' ? 'weights' : key === 's' ? 'settings' : `${key[0]}_${key.slice(2)}`);
const keyFor = (id) => (id === 'weights' ? 'w' : id === 'settings' ? 's' : /^[er]_\d{4}-\d{2}-\d{2}$/.test(id) ? `${id[0]}:${id.slice(2)}` : null);

let col = null;
let unsubscribe = null;
let readOnly = false;
const queue = new Set();
let flushTimer = null;
let flushing = false;
let onRemote = () => {};

function schedule(delay = PUSH_DELAY_MS) {
  if (!col || readOnly) return;
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, delay);
}

function enqueue(key) {
  if (!col || readOnly) return;
  queue.add(key);
  setStatus({ state: 'syncing', pending: queue.size, message: `Saving ${queue.size} change${queue.size === 1 ? '' : 's'} to your account…` });
  schedule();
}

async function pushOne(key) {
  const record = store.syncRecord(key);
  if (!record) return;
  await col.doc(docIdFor(key)).set(record);
  // Edited again while the write was in flight: send the newer version too.
  if (store.syncAt(key) !== record.at) queue.add(key);
}

async function flush() {
  if (flushing || !col || readOnly) return;
  flushing = true;
  let failure = null;
  try {
    while (queue.size && !failure) {
      const batch = [...queue].slice(0, CONCURRENCY);
      batch.forEach((k) => queue.delete(k));
      const results = await Promise.allSettled(batch.map(pushOne));
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          failure ||= r.reason;
          queue.add(batch[i]);
        }
      });
      setStatus({ pending: queue.size, message: `Saving ${queue.size} change${queue.size === 1 ? '' : 's'} to your account…` });
    }
  } finally {
    flushing = false;
  }
  if (!failure) {
    setStatus({ state: 'synced', pending: 0, lastSync: new Date().toISOString(), message: 'Synced across your devices.' });
    return;
  }
  const code = failure && failure.code;
  if (code === 'invalid_argument') {
    // A viewer who may only look cannot write; stop trying rather than loop.
    readOnly = true;
    queue.clear();
    setStatus({ state: 'error', pending: 0, message: 'This account can view the page but not save to it, so data stays on this device only.' });
  } else if (code === 'quota_exceeded') {
    queue.clear();
    setStatus({ state: 'error', pending: 0, message: 'The artifact’s database is full, so new changes are staying on this device only.' });
  } else if (code === 'revoked') {
    readOnly = true;
    queue.clear();
    setStatus({ state: 'error', pending: 0, message: 'Access to sync was withdrawn. Data stays on this device only.' });
  } else {
    setStatus({ state: 'error', pending: queue.size, message: 'Couldn’t reach your account just now — will retry. Your data is safe on this device.' });
    schedule(RETRY_MS);
  }
}

function fromSnapshotDoc(d) {
  if (!d || !d.exists) return null;
  const data = d.data();
  const key = keyFor(d.id);
  if (!key || !data || typeof data.at !== 'string') return null;
  return { k: key, at: data.at, del: Boolean(data.del), v: data.v ?? null };
}

/** What the database holds, by key → `at`, built up across snapshots. */
const remoteAt = new Map();
let reconciled = false;

/** Send up anything this device has that the database lacks or holds an older version of. */
function reconcile() {
  reconciled = true;
  for (const key of store.syncKeys()) {
    const at = store.syncAt(key);
    if (!remoteAt.has(key) || remoteAt.get(key) < at) queue.add(key);
  }
  if (queue.size) {
    setStatus({ state: 'syncing', pending: queue.size, message: `Saving ${queue.size} change${queue.size === 1 ? '' : 's'} to your account…` });
    schedule(50);
  } else {
    setStatus({ state: 'synced', pending: 0, lastSync: new Date().toISOString(), message: 'Synced across your devices.' });
  }
}

function onSnapshot(snap) {
  const changes = snap.docChanges();
  for (const c of changes) {
    const key = keyFor(c.doc.id);
    if (!key) continue;
    if (c.type === 'removed') remoteAt.delete(key);
    else {
      const d = fromSnapshotDoc(c.doc);
      if (d) remoteAt.set(key, d.at);
    }
  }
  const docs = changes.filter((c) => c.type !== 'removed').map((c) => fromSnapshotDoc(c.doc)).filter(Boolean);
  const changed = store.applyRemote(docs);

  // A snapshot served from cache may be missing documents. Reconciling against
  // it could send older local data over newer data that simply hasn't arrived
  // yet, so wait for a definitive one.
  const definitive = !(snap.metadata && snap.metadata.fromCache);
  if (!reconciled && definitive) reconcile();
  else if (reconciled && !queue.size && !flushing && status.state !== 'error') {
    setStatus({ state: 'synced', pending: 0, lastSync: new Date().toISOString(), message: 'Synced across your devices.' });
  }
  if (changed.length) onRemote(changed);
}

/**
 * Connect if this page is running inside the artifact viewer.
 * @param {{ onRemoteChange?: (keys: string[]) => void }} opts
 */
export async function start({ onRemoteChange } = {}) {
  if (onRemoteChange) onRemote = onRemoteChange;
  const claude = typeof window !== 'undefined' ? window.claude : null;
  if (!claude || typeof claude.use !== 'function') {
    setStatus({ state: 'off', message: 'Sync is off — this copy of the app is running on its own, so data stays on this device.' });
    return false;
  }
  setStatus({ state: 'connecting', message: 'Connecting to your account…' });
  try {
    const [db, user] = await Promise.all([claude.use('db'), claude.use('user')]);
    if (!db || !user) {
      setStatus({ state: 'off', message: 'Sync isn’t available in this view (sign in to claude.ai to sync). Data stays on this device.' });
      return false;
    }
    const id = await user.id();
    if (!id) {
      setStatus({ state: 'off', message: 'Sync needs you to be signed in to claude.ai. Data stays on this device.' });
      return false;
    }
    col = db.collection(`data/users/${id}`);
  } catch (err) {
    setStatus({ state: 'off', message: 'Sync couldn’t start in this view. Data stays on this device.' });
    console.error('Sync setup failed.', err);
    return false;
  }

  store.onLocalChange(enqueue);
  reconciled = false;
  unsubscribe = col.onSnapshot(onSnapshot, (err) => {
    // A terminal error kills the listener; local editing carries on regardless.
    console.error('Sync listener stopped.', err);
    setStatus({
      state: 'error',
      message: err && err.code === 'revoked'
        ? 'Access to sync was withdrawn. Data stays on this device.'
        : 'Sync stopped listening for changes from your other devices. Reload the page to reconnect.',
    });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && queue.size) schedule(50);
  });
  window.addEventListener('online', () => queue.size && schedule(50));
  return true;
}

/** "Sync now": retry anything waiting. Incoming changes already arrive live. */
export function syncNow() {
  if (!col) return false;
  for (const key of store.syncKeys()) {
    // Cheap safety net: re-queue anything this device changed since the last full pass.
    if (store.syncAt(key) && !queue.has(key) && status.state === 'error') queue.add(key);
  }
  readOnly = false;
  if (queue.size) {
    setStatus({ state: 'syncing', pending: queue.size });
    schedule(0);
  }
  return true;
}

export function stop() {
  unsubscribe?.();
  unsubscribe = null;
  col = null;
}
