/** Small DOM/formatting helpers shared by the views. */

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function kcal(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return Math.round(Number(value)).toLocaleString();
}

export function num(value, digits = 1) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '—';
  return Number(value).toFixed(digits);
}

export function pct(value, digits = 0) {
  if (!Number.isFinite(Number(value))) return '—';
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function prettyDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export function kgToLb(kg) {
  return Number(kg) * 2.2046226218;
}

export function lbToKg(lb) {
  return Number(lb) / 2.2046226218;
}

export function debounce(fn, ms = 350) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function toast(message, kind = 'ok') {
  const host = document.getElementById('toast-host');
  if (!host) return;
  const node = document.createElement('div');
  node.className = `toast toast-${kind}`;
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 300);
  }, 2600);
}

/**
 * Two-step destructive button: the first click arms it and relabels it, a
 * second click within 4s confirms. Built in-page because the hosted artifact
 * viewer silently answers window.confirm() with false.
 */
export function confirmClick(btn, prompt = 'Click again to confirm') {
  if (btn.dataset.armed === '1') {
    clearTimeout(btn._disarm);
    btn.dataset.armed = '';
    btn.textContent = btn.dataset.label;
    btn.classList.remove('armed');
    return true;
  }
  btn.dataset.label = btn.textContent;
  btn.dataset.armed = '1';
  btn.textContent = prompt;
  btn.classList.add('armed');
  btn._disarm = setTimeout(() => {
    btn.dataset.armed = '';
    btn.textContent = btn.dataset.label;
    btn.classList.remove('armed');
  }, 4000);
  return false;
}

/**
 * Shows exported text (CSV, JSON backup) in a dialog with a Copy button.
 * Copy-to-clipboard instead of a file download, because the hosted viewer
 * blocks every download a page starts; paste it into a file to keep it.
 */
export function openTextPanel({ title, hint, text }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div class="modal-head">
        <h2 id="modal-title">${esc(title)}</h2>
        <button type="button" class="icon-btn" data-close aria-label="Close">✕</button>
      </div>
      ${hint ? `<p class="muted small">${esc(hint)}</p>` : ''}
      <textarea id="export-text" readonly spellcheck="false"></textarea>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-close>Close</button>
        <button type="button" class="btn primary" data-copy>Copy to clipboard</button>
      </div>
    </div>`;
  const area = backdrop.querySelector('textarea');
  area.value = text;
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', async (e) => {
    if (e.target === backdrop || e.target.closest('[data-close]')) {
      close();
    } else if (e.target.closest('[data-copy]')) {
      try {
        await navigator.clipboard.writeText(text);
        toast('Copied to clipboard');
      } catch {
        area.focus();
        area.select();
        toast('Selected — press Ctrl+C (⌘C) to copy', 'warn');
      }
    }
  });
  document.body.append(backdrop);
  backdrop.querySelector('[data-copy]').focus();
}
