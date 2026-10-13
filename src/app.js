/** App shell — tab routing, per-tab header actions, and calendar-import prefill. */

import * as store from './store.js';
import * as logView from './views/log.js';
import * as historyView from './views/history.js';
import * as trendsView from './views/trends.js';
import * as referenceView from './views/reference.js';
import * as settingsView from './views/settings.js';
import * as sync from './sync.js';
import { reveal, toast, todayIso } from './ui.js';

const TABS = [
  { id: 'log', label: 'Daily entry', short: 'Today' },
  { id: 'history', label: 'History', short: 'History' },
  { id: 'trends', label: 'Trends', short: 'Trends' },
  { id: 'reference', label: 'Reference', short: 'Reference' },
  { id: 'settings', label: 'Settings', short: 'Settings' },
];

/** Phone bottom bar: the four daily screens up front, the rest behind More. */
const PRIMARY = ['log', 'history', 'trends', 'settings'];

let current = 'log';

/**
 * Prefills a day from a `?import=<JSON>` query param, saves it, and jumps to
 * the log tab. Works when the app is served locally; the hosted artifact
 * never passes a query string through.
 */
function importFromQuery() {
  const raw = new URLSearchParams(location.search).get('import');
  if (!raw) return null;
  try {
    const patch = JSON.parse(raw);
    if (!patch || !patch.date) throw new Error('Import payload is missing a date.');
    const entry = {
      ...store.newEntry(patch.date),
      ...patch,
      phases: (patch.phases && patch.phases.length ? patch.phases : [{}]).map((p) => ({
        ...store.newPhase(),
        ...p,
      })),
    };
    store.saveEntry(entry);
    history.replaceState(null, '', location.pathname + '#log');
    toast(`Imported ${entry.date} from calendar data — review and adjust below.`);
    return entry.date;
  } catch (err) {
    console.error('Could not import calendar data.', err);
    toast('Could not read the imported day — check the link.', 'warn');
    return null;
  }
}

function todayLabel() {
  const [y, m, d] = todayIso().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d))
    .toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .replace(/,/g, '')
    .toUpperCase();
}

/**
 * What the sync pill says. A failure to save on this device outranks
 * everything: it is the one state where work can genuinely be lost.
 */
export function syncPillModel() {
  const disk = store.storageStatus();
  const st = sync.getStatus();
  if (!disk.ok && st.state !== 'synced') return { state: 'bad', text: 'Not saved', title: `${disk.error} ${st.state === 'off' ? 'Copy a backup from Settings.' : ''}` };
  if (st.state === 'synced') return { state: 'ok', text: 'Synced', title: st.message };
  if (st.state === 'syncing') return { state: 'busy', text: `Syncing${st.pending ? ` ${st.pending}` : ''}`, title: st.message };
  if (st.state === 'connecting') return { state: 'busy', text: 'Connecting', title: st.message };
  if (st.state === 'error') return { state: 'warn', text: 'Sync issue', title: st.message };
  return { state: 'off', text: 'This device', title: st.message };
}

function syncPillHtml() {
  const m = syncPillModel();
  return `<span id="sync-pill" class="sync-pill" data-state="${m.state}" title="${m.title.replace(/"/g, '&quot;')}">${m.text}</span>`;
}

let warnedStorage = false;

function updateSyncUi() {
  const m = syncPillModel();
  const disk = store.storageStatus();
  if (!disk.ok && !warnedStorage) {
    warnedStorage = true;
    toast(`${disk.error} ${sync.getStatus().state === 'synced' ? 'Your account copy is still being kept.' : 'Use Settings → Back up to keep a copy.'}`, 'warn');
  }
  if (disk.ok) warnedStorage = false;
  const pill = document.getElementById('sync-pill');
  if (pill) {
    pill.dataset.state = m.state;
    pill.textContent = m.text;
    pill.title = m.title;
  }
  const st = sync.getStatus();
  document.querySelectorAll('[data-sync-line]').forEach((el) => {
    el.textContent = `${m.title}${st.lastSync && st.state === 'synced' ? ` Last checked ${new Date(st.lastSync).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ''}`.trim();
    el.dataset.state = disk.ok ? m.state : 'bad';
  });
}

function renderHeaderActions() {
  const host = document.getElementById('header-actions');
  if (current === 'log') {
    host.innerHTML = `${syncPillHtml()}<span id="save-state" class="save-pill" data-state="saved" role="status">● Saved</span>`;
  } else if (current === 'history') {
    const empty = !store.listEntries().length;
    host.innerHTML = `${syncPillHtml()}<button type="button" class="btn ghost" data-header="export-csv" ${empty ? 'disabled' : ''}>Export CSV</button>`;
  } else {
    host.innerHTML = `${syncPillHtml()}<span class="mono-date">${todayLabel()}</span>
      <button type="button" class="btn primary" data-header="log-today">+ Log day</button>`;
  }
}

/** Another device changed something: refresh whatever is on screen without disturbing typing. */
function onRemoteChange(keys) {
  if (current === 'log') {
    logView.onRemoteChange(keys);
  } else {
    const typing = document.activeElement && document.activeElement.closest?.('#view') && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (!typing) mount();
  }
  renderHeaderActions();
  toast(`Updated from another device (${keys.length} change${keys.length === 1 ? '' : 's'}).`);
}

function openDay(date) {
  logView.loadDate(date || todayIso());
  go('log');
}

function mount() {
  const root = document.getElementById('view');
  // A fresh node per render keeps delegated listeners from stacking up.
  const fresh = document.createElement('main');
  fresh.id = 'view';
  fresh.className = `view view-${current}`;
  root.replaceWith(fresh);

  if (current === 'log') {
    logView.render(fresh);
  } else if (current === 'history') {
    historyView.render(fresh, { onEdit: openDay });
  } else if (current === 'trends') {
    trendsView.render(fresh, { onEdit: openDay, onLog: () => openDay(todayIso()) });
  } else if (current === 'reference') {
    referenceView.render(fresh);
  } else if (current === 'settings') {
    settingsView.render(fresh, { onChange: () => {} });
  }
  reveal(fresh);
}

function go(tab) {
  // Every other screen reads from storage, so land any pending edit first.
  logView.flushSave();
  current = tab;
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-current', on ? 'page' : 'false');
  });
  const more = document.querySelector('[data-more]');
  if (more) more.classList.toggle('active', !PRIMARY.includes(tab));
  closeMore();
  renderHeaderActions();
  mount();
  updateSyncUi();
  window.scrollTo(0, 0);
}

function closeMore() {
  const sheet = document.getElementById('more-sheet');
  if (sheet) sheet.hidden = true;
}

function renderNav() {
  document.getElementById('tabs').innerHTML = TABS.map(
    (t) => `<button type="button" class="tab" data-tab="${t.id}">${t.label}</button>`,
  ).join('');

  const bottom = document.getElementById('bottom-nav');
  bottom.innerHTML = `
    ${PRIMARY.map((id) => `<button type="button" data-tab="${id}">${TABS.find((t) => t.id === id).short}</button>`).join('')}
    <button type="button" data-more aria-haspopup="true">More</button>
    <div id="more-sheet" class="more-sheet" hidden>
      ${TABS.filter((t) => !PRIMARY.includes(t.id)).map((t) => `<button type="button" data-tab="${t.id}">${t.label}</button>`).join('')}
    </div>`;

  document.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      if (tab.dataset.tab === 'log' && current !== 'log') logView.loadDate(todayIso());
      go(tab.dataset.tab);
      return;
    }
    if (e.target.closest('[data-more]')) {
      const sheet = document.getElementById('more-sheet');
      sheet.hidden = !sheet.hidden;
      return;
    }
    const action = e.target.closest('[data-header]')?.dataset.header;
    if (action === 'log-today') openDay(todayIso());
    if (action === 'export-csv') historyView.exportCsv();
    if (!e.target.closest('#bottom-nav')) closeMore();
  });
}

function init() {
  store.load();
  const importedDate = importFromQuery();
  logView.loadDate(importedDate || todayIso());
  renderNav();
  const fromHash = location.hash.replace('#', '');
  go(importedDate ? 'log' : TABS.some((t) => t.id === fromHash) ? fromHash : 'log');

  // Closing or backgrounding the page inside the save debounce would drop the last edit.
  window.addEventListener('pagehide', () => logView.flushSave());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') logView.flushSave();
  });

  // Sync last: the app is already usable from this device's own copy.
  sync.onStatus(updateSyncUi);
  store.subscribe(updateSyncUi);
  sync.start({ onRemoteChange });
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="sync-now"]')) {
      if (!sync.syncNow()) toast('Sync isn’t connected in this view.', 'warn');
    }
  });

  window.addEventListener('hashchange', () => {
    const tab = location.hash.replace('#', '');
    if (TABS.some((t) => t.id === tab) && tab !== current) go(tab);
  });
}

init();
