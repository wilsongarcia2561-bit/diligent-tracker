/** App shell — tab routing and view mounting. */

import * as store from './store.js';
import * as logView from './views/log.js';
import * as historyView from './views/history.js';
import * as trendsView from './views/trends.js';
import * as toolsView from './views/tools.js';
import * as referenceView from './views/reference.js';
import * as settingsView from './views/settings.js';
import { todayIso } from './ui.js';

const TABS = [
  { id: 'log', label: 'Daily entry' },
  { id: 'history', label: 'History' },
  { id: 'trends', label: 'Trends' },
  { id: 'hrr', label: 'BPM / HRR' },
  { id: 'reference', label: 'Reference' },
  { id: 'settings', label: 'Settings' },
];

let current = 'log';

function mount() {
  const root = document.getElementById('view');
  // A fresh node per render keeps delegated listeners from stacking up.
  const fresh = document.createElement('div');
  fresh.id = 'view';
  fresh.className = `view view-${current}`;
  root.replaceWith(fresh);

  if (current === 'log') {
    logView.render(fresh);
  } else if (current === 'history') {
    historyView.render(fresh, {
      onEdit: (date) => {
        logView.loadDate(date);
        go('log');
      },
    });
  } else if (current === 'trends') {
    trendsView.render(fresh);
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
  location.hash = tab;
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
    btn.setAttribute('aria-selected', String(btn.dataset.tab === tab));
  });
  mount();
}

function renderTabs() {
  const nav = document.getElementById('tabs');
  nav.innerHTML = TABS.map(
    (t) => `<button type="button" role="tab" class="tab" data-tab="${t.id}" aria-selected="false">${t.label}</button>`,
  ).join('');
  nav.addEventListener('click', (e) => {
    const tab = e.target.dataset.tab;
    if (tab) go(tab);
  });
}

function init() {
  store.load();
  logView.loadDate(todayIso());
  renderTabs();
  const fromHash = location.hash.replace('#', '');
  go(TABS.some((t) => t.id === fromHash) ? fromHash : 'log');

  window.addEventListener('hashchange', () => {
    const tab = location.hash.replace('#', '');
    if (TABS.some((t) => t.id === tab) && tab !== current) go(tab);
  });
}

init();
