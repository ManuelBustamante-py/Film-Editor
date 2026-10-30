/* Utilidades de DOM compartidas por todos los módulos de la interfaz. */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const icon = (n, c) => Icons.icon(n, c);

let __uid = 0;
const uid = (p = 'id') => `${p}${Date.now().toString(36)}${(++__uid).toString(36)}`;

// Crea elementos: h('div', { class: 'x', onclick: fn }, 'texto', otroNodo)
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value') el.value = v;
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function toast(msg, type = 'info', timeout = 3800) {
  const ic = { ok: 'check', err: 'alert', warn: 'alert', info: 'info' }[type] || 'info';
  const t = h('div', { class: `toast ${type}`, html: icon(ic) }, h('div', null, msg));
  $('#toasts').appendChild(t);
  setTimeout(() => { t.classList.add('hide'); setTimeout(() => t.remove(), 300); }, timeout);
}

// Actualiza el relleno de color de un <input type=range>.
function paintRange(input) {
  const min = Number(input.min || 0), max = Number(input.max || 100);
  const p = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty('--p', `${clamp(p, 0, 100)}%`);
}
document.addEventListener('input', (e) => { if (e.target.type === 'range') paintRange(e.target); });

function waitEvent(el, ev, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeout);
    const ok = () => { cleanup(); resolve(); };
    const ko = () => { cleanup(); reject(new Error('error')); };
    function cleanup() { clearTimeout(t); el.removeEventListener(ev, ok); el.removeEventListener('error', ko); }
    el.addEventListener(ev, ok, { once: true });
    el.addEventListener('error', ko, { once: true });
  });
}

function modal({ title, body, foot, wide, onClose }) {
  const root = $('#modal-root');
  const close = () => { bd.remove(); document.removeEventListener('keydown', esc, true); onClose && onClose(); };
  const esc = (e) => { if (e.key === 'Escape' && bd.dataset.lock !== '1') { e.stopPropagation(); close(); } };
  const m = h('div', { class: 'modal', style: wide ? { width: 'min(1040px, 100%)' } : null },
    h('div', { class: 'modal-head' }, h('h2', null, title),
      h('button', { class: 'btn ghost icon-only', html: icon('x'), title: 'Cerrar', onclick: () => bd.dataset.lock !== '1' && close() })),
    h('div', { class: 'modal-body' }, body),
    foot ? h('div', { class: 'modal-foot' }, foot) : null);
  const bd = h('div', { class: 'modal-backdrop' }, m);
  bd.addEventListener('mousedown', (e) => { if (e.target === bd && bd.dataset.lock !== '1') close(); });
  document.addEventListener('keydown', esc, true);
  root.appendChild(bd);
  return { el: m, backdrop: bd, close, setLocked: (v) => (bd.dataset.lock = v ? '1' : '0') };
}

/*
 * Menú contextual. items: [{ label, icon, shortcut, action, disabled, danger, checked, submenu: [...] } | 'sep']
 */
let __menu = null;
function closeContextMenu() {
  if (__menu) { __menu.forEach((m) => m.remove()); __menu = null; }
  document.removeEventListener('pointerdown', __menuOutside, true);
  document.removeEventListener('keydown', __menuKey, true);
  window.removeEventListener('blur', closeContextMenu);
}
function __menuOutside(e) { if (!e.target.closest('.ctx-menu')) closeContextMenu(); }
function __menuKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeContextMenu(); } }

function buildMenu(items, x, y, level = 0, altX = null) {
  const menu = h('div', { class: 'ctx-menu', role: 'menu' });
  let openSub = null;
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep') { menu.appendChild(h('div', { class: 'ctx-sep' })); continue; }
    if (it.header) { menu.appendChild(h('div', { class: 'ctx-header' }, it.header)); continue; }
    const row = h('div', {
      class: `ctx-item${it.disabled ? ' disabled' : ''}${it.danger ? ' danger' : ''}`,
      title: it.title || '',
    },
    h('span', { class: 'ctx-ic', html: it.checked ? icon('check') : it.icon ? icon(it.icon) : '' }),
    h('span', { class: 'ctx-label' }, it.label),
    it.submenu ? h('span', { class: 'ctx-arrow', html: icon('frameFwd') }) : it.shortcut ? h('span', { class: 'ctx-key' }, it.shortcut) : null);
    row.addEventListener('pointerenter', () => {
      if (openSub) { closeFrom(level + 1); openSub = null; }
      if (it.submenu && !it.disabled) {
        const r = row.getBoundingClientRect();
        openSub = buildMenu(it.submenu, r.right - 4, r.top - 5, level + 1, r.left + 4);
      }
    });
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      if (it.disabled || it.submenu) return;
      closeContextMenu();
      it.action && it.action();
    });
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  __menu.splice(level, __menu.length - level, menu);
  // Mantener el menú dentro de la ventana.
  const r = menu.getBoundingClientRect();
  let left = x, top = y;
  if (left + r.width > innerWidth - 6) left = altX != null ? altX - r.width : innerWidth - r.width - 6;
  if (top + r.height > innerHeight - 6) top = Math.max(6, innerHeight - r.height - 6);
  menu.style.left = `${Math.max(6, left)}px`;
  menu.style.top = `${top}px`;
  return menu;
}
function closeFrom(level) {
  if (!__menu) return;
  __menu.splice(level).forEach((m) => m.remove());
}

function contextMenu(e, items) {
  e.preventDefault();
  closeContextMenu();
  __menu = [];
  buildMenu(items, e.clientX, e.clientY, 0);
  setTimeout(() => {
    document.addEventListener('pointerdown', __menuOutside, true);
    document.addEventListener('keydown', __menuKey, true);
    window.addEventListener('blur', closeContextMenu);
  });
}

function cleanIpcError(msg) {
  return String(msg || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function baseName(p) {
  return String(p).split(/[\\/]/).pop();
}

function stripExt(name) {
  return name.replace(/\.[^.]+$/, '');
}

function dirName(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i >= 0 ? p.slice(0, i) : '';
}
