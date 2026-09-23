/** App shell — tab routing, per-tab header actions, and calendar-import prefill. */

import * as store from './store.js';
import * as logView from './views/log.js';
import * as historyView from './views/history.js';
import * as trendsView from './views/trends.js';
import * as toolsView from './views/tools.js';
import * as referenceView from './views/reference.js';
import * as settingsView from './views/settings.js';
import { toast, todayIso } from './ui.js';

const TABS = [
  { id: 'log', label: 'Daily entry', short: 'Today' },
  { id: 'history', label: 'History', short: 'History' },
  { id: 'trends', label: 'Trends', short: 'Trends' },
  { id: 'hrr', label: 'BPM / HRR', short: 'HRR' },
  { id: 'reference', label: 'Reference', short: 'Reference' },
  { id: 'settings', label: 'Settings', short: 'Settings' },
];

/** Phone bottom bar: the four daily screens up front, the rest behind More. */
const PRIMARY = ['log', 'history', 'trends', 'hrr'];

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

function renderHeaderActions() {
  const host = document.getElementById('header-actions');
  if (current === 'log') {
    host.innerHTML = '<span id="save-state" class="save-pill" data-state="saved" role="status">● Saved</span>';
  } else if (current === 'history') {
    const empty = !store.listEntries().length;
    host.innerHTML = `<button type="button" class="btn ghost" data-header="export-csv" ${empty ? 'disabled' : ''}>Export CSV</button>`;
  } else {
    host.innerHTML = `<span class="mono-date">${todayLabel()}</span>
      <button type="button" class="btn primary" data-header="log-today">+ Log day</button>`;
  }
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
  } else if (current === 'hrr') {
    toolsView.render(fresh);
  } else if (current === 'reference') {
    referenceView.render(fresh);
  } else if (current === 'settings') {
    settingsView.render(fresh, { onChange: () => {} });
  }
}

function go(tab) {
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

  window.addEventListener('hashchange', () => {
    const tab = location.hash.replace('#', '');
    if (TABS.some((t) => t.id === tab) && tab !== current) go(tab);
  });
}

init();
