import { api, apiJson } from '../core/api.js?v=1';
import { escapeHtml } from '../core/util.js?v=1';
import { TIER_NAMES, emblem } from './emblems.js?v=2';

let data = null;
let drawer = null;
let backdrop = null;
let opener = null;
let checking = null;
let group = 'all';
let wired = false;

const fmt = (n) => Number(n).toLocaleString();

const ICON = (d) => `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const GROUPS = [
  ['all', 'All', ICON('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>')],
  ['chat', 'Chatting', ICON('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>')],
  ['outings', 'Outings', ICON('<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>')],
  ['feelings', 'Feelings', ICON('<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>')],
  ['habits', 'Her habits', ICON('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z"/>')],
];

async function load() {
  try {
    const r = await api('achievements.php', { cache: 'no-store' });
    if (r.ok) data = await r.json();
  } catch {}
  return data;
}

// asks the server what unlocked since the last toast. it keeps
// the "seen" tier per achievement, so an unlock that happened on
// the date or karaoke page still gets its toast once we're home.
// calls that pile up share one request
export function check() {
  if (checking) return checking;
  checking = (async () => {
    const d = await load();
    if (!d) return;
    if (drawer) render();
    if (!d.fresh.length) return;
    d.fresh.forEach((f, i) => setTimeout(() => toast(f), i * 900));
    apiJson('achievements.php?action=seen', { items: d.fresh.map(({ id, tier }) => ({ id, tier })) }).catch(() => {});
  })().finally(() => { checking = null; });
  return checking;
}

export function bump(stat) {
  if (!wired) return;
  apiJson('achievements.php?action=bump', { stat }).then(check, () => {});
}

function toast(f) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast toast-ach tier-' + f.tier;
  el.innerHTML = `${emblem(f.tier, { size: 44 })}
    <span class="toast-ach-text">
      <span class="toast-ach-name">${TIER_NAMES[f.tier - 1]} ${escapeHtml(f.name)}</span>
    </span>`;
  const dismiss = () => {
    el.classList.remove('toast-visible');
    el.classList.add('toast-hiding');
    setTimeout(() => el.remove(), 300);
  };
  el.addEventListener('click', () => { dismiss(); open(); });
  box.appendChild(el);
  el.getBoundingClientRect();
  el.classList.add('toast-visible');
  setTimeout(dismiss, 6000);
}

function progress(a) {
  const t = a.tier;
  if (t >= 4) return { pct: 100, text: 'Maxed out' };
  const next = a.tiers[t];
  const v = a.value;
  if (a.low) {
    // counts down. from 100 to bronze, then from each tier to the next
    const from = t === 0 ? 100 : a.tiers[t - 1];
    const pct = v === null ? 0 : ((from - v) / (from - next)) * 100;
    return { pct, text: `Lowest ${v === null ? '-' : fmt(v)}, ${TIER_NAMES[t]} at ${fmt(next)} or less` };
  }
  const from = t === 0 ? 0 : a.tiers[t - 1];
  return { pct: (((v || 0) - from) / (next - from)) * 100, text: `${fmt(v || 0)} / ${fmt(next)} for ${TIER_NAMES[t]}` };
}

// the dev buttons jump a whole tier, the box takes an exact number.
// both go by the tier reached, not the raw value, or 50 messages
// minus one tier lands on 25 and is still bronze
function stepValue(a, dir) {
  const t = a.tier + dir;
  if (t < 1) return null;
  if (t > 4) return a.value;
  return a.tiers[t - 1];
}

// best first: highest tier, then furthest toward the next one.
// the ??? rows sink to the bottom, sort is stable so ties keep
// the catalog order
function byRank(a, b) {
  const score = (x) => x.name === null ? -1 : x.tier + Math.max(0, Math.min(99.9, progress(x).pct)) / 100;
  return score(b) - score(a);
}

function devControls(a) {
  if (!data.dev) return '';
  return `<div class="set-row-control ach-dev" data-id="${a.id}">
    <button type="button" class="ach-step" data-dir="-1" aria-label="Previous tier for ${escapeHtml(a.name)}" title="Previous tier">&minus;</button>
    <input type="number" min="0" step="1" inputmode="numeric" value="${a.value ?? ''}" placeholder="-" aria-label="${escapeHtml(a.name)} value">
    <button type="button" class="ach-step" data-dir="1" aria-label="Next tier for ${escapeHtml(a.name)}" title="Next tier">+</button>
  </div>`;
}

function row(a) {
  if (a.name === null) {
    return `<div class="set-row ach-row secret">
      <div class="ach-emblem">${emblem(0, { size: 48, locked: true, label: 'Hidden achievement' })}</div>
      <div class="set-row-text">
        <div class="set-row-title">???</div>
        <div class="set-row-desc">Hidden. Keep going.</div>
      </div>
    </div>`;
  }
  const p = progress(a);
  const pct = Math.max(0, Math.min(100, p.pct));
  const tierName = a.tier ? TIER_NAMES[a.tier - 1] : '';
  return `<div class="set-row ach-row tier-${a.tier}">
    <div class="ach-emblem">${emblem(a.tier, { size: 48, locked: a.secret, label: tierName ? tierName + ' tier' : 'Not unlocked yet' })}</div>
    <div class="set-row-text">
      <div class="set-row-title">${escapeHtml(a.name)}${a.secret ? '<span class="ach-tier hidden-tag">Hidden</span>' : ''}</div>
      <div class="set-row-desc">${escapeHtml(a.desc)}</div>
      <div class="ach-meter" role="progressbar" aria-label="${escapeHtml(a.name)} progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" style="--fill:${pct}%"></div>
      <div class="ach-meta">${p.text}</div>
    </div>
    ${devControls(a)}
  </div>`;
}

function render() {
  if (!drawer) return;
  const body = drawer.querySelector('.ach-rows');
  const title = drawer.querySelector('.settings-main-title');
  const sum = drawer.querySelector('.ach-summary');
  const label = GROUPS.find(g => g[0] === group)[1];
  title.textContent = group === 'all' ? 'Achievements' : label;
  for (const btn of drawer.querySelectorAll('.settings-navitem')) {
    const on = btn.dataset.group === group;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', String(on));
  }
  if (!data) {
    sum.textContent = '';
    body.innerHTML = '<div class="ach-empty">Couldn\'t load achievements.</div>';
    return;
  }
  const shown = (group === 'all' ? data.list : data.list.filter(a => a.group === group)).slice().sort(byRank);
  const unlocked = shown.filter(a => a.tier > 0).length;
  sum.textContent = `${unlocked} of ${shown.length} unlocked${data.dev ? '. Developer: the buttons jump a tier, the box sets an exact value' : ''}`;

  const focused = document.activeElement?.closest?.('.ach-dev')?.dataset.id;
  body.innerHTML = shown.map(row).join('');
  if (focused) body.querySelector(`.ach-dev[data-id="${focused}"] input`)?.focus();
}

async function setValue(id, value) {
  try {
    const r = await apiJson('achievements.php?action=set', { id, value });
    if (!r.ok) return;
    data = await r.json();
    render();
  } catch {}
}

function onDevInput(e) {
  const box = e.target.closest('.ach-dev');
  if (!box || !data) return;
  const a = data.list.find(x => x.id === box.dataset.id);
  if (!a) return;
  if (e.type === 'click') {
    const dir = Number(e.target.closest('.ach-step')?.dataset.dir);
    if (dir) setValue(a.id, stepValue(a, dir));
  } else if (e.type === 'change' && e.target.matches('input')) {
    const raw = e.target.value.trim();
    setValue(a.id, raw === '' ? null : Math.max(0, Math.floor(Number(raw)) || 0));
  }
}

function onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); close(); }
}

export function open() {
  if (drawer) return;
  opener = document.activeElement;
  backdrop = document.createElement('div');
  backdrop.className = 'drawer-backdrop ach-drawer-backdrop';
  drawer = document.createElement('div');
  drawer.className = 'settings-drawer ach-drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');
  drawer.setAttribute('aria-labelledby', 'achTitle');
  drawer.innerHTML = `<nav class="settings-nav" aria-label="Achievement groups">
      <button type="button" class="settings-close" aria-label="Close achievements" title="Close">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <div class="settings-navlist" role="tablist">
        ${GROUPS.map(([key, label, icon]) => `<button type="button" class="settings-navitem" role="tab" data-group="${key}">${icon}<span>${label}</span></button>`).join('')}
      </div>
    </nav>
    <div class="settings-main">
      <header class="settings-main-head">
        <h2 class="settings-main-title" id="achTitle">Achievements</h2>
        <div class="set-row-desc ach-summary" aria-live="polite"></div>
      </header>
      <div class="settings-main-body"><div class="ach-rows"><div class="ach-empty">Loading...</div></div></div>
    </div>`;
  backdrop.addEventListener('click', close);
  drawer.querySelector('.settings-close').addEventListener('click', close);
  drawer.querySelector('.settings-navlist').addEventListener('click', (e) => {
    const btn = e.target.closest('.settings-navitem');
    if (!btn) return;
    group = btn.dataset.group;
    render();
    drawer.querySelector('.settings-main-body').scrollTop = 0;
  });
  const rows = drawer.querySelector('.ach-rows');
  rows.addEventListener('click', onDevInput);
  rows.addEventListener('change', onDevInput);
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop, drawer);
  document.body.classList.add('drawer-open');
  drawer.getBoundingClientRect();
  backdrop.classList.add('open');
  drawer.classList.add('open');
  drawer.querySelector('.settings-close').focus();
  render();
  check();
}

export function close() {
  if (!drawer) return;
  const els = [drawer, backdrop];
  drawer = backdrop = null;
  document.removeEventListener('keydown', onKey);
  document.body.classList.remove('drawer-open');
  for (const el of els) el.classList.remove('open');
  setTimeout(() => els.forEach(el => el.remove()), 240);
  if (opener && opener.focus && document.contains(opener)) opener.focus();
  opener = null;
}

export function wire(button) {
  wired = true;
  if (button) button.addEventListener('click', open);
  check();
}
