import * as Names from '../core/names.js?v=1';

// her absence texts as desktop notifications. the server writes them
// during the idle pass, this page fetches them while it still can and
// fires each one on its own clock, so stopping the stack later
// doesn't stop her. held in memory only, never in localStorage
const PREF = 'notify.away';
const POLL_MS = 5 * 60 * 1000;
const TICK_MS = 60 * 1000;
// a laptop waking after a day would otherwise dump a whole day of texts at once
const STALE_MS = 30 * 60 * 1000;

let plan = null;
let lastHere = Date.now();
let shownFor = 0;
const shown = new Set();

export function supported() {
  return 'Notification' in window && window.isSecureContext;
}

export function enabled() {
  try { return supported() && localStorage.getItem(PREF) === '1' && Notification.permission === 'granted'; } catch (e) { return false; }
}

export async function setEnabled(on) {
  if (on && Notification.permission !== 'granted' && await Notification.requestPermission() !== 'granted') on = false;
  try { localStorage.setItem(PREF, on ? '1' : '0'); } catch (e) {}
  if (on) refresh(); else plan = null;
  return on;
}

async function refresh() {
  if (!enabled()) return;
  try {
    const r = await fetch('api/consolidate.php?action=pending', { credentials: 'same-origin' });
    if (!r.ok) return;
    const d = await r.json();
    const items = [];
    for (const t of Array.isArray(d.tiers) ? d.tiers : []) {
      (t.texts || []).forEach((text, i) => items.push({ key: t.tier + ':' + i, offset: (t.after + i * (t.gap || 0)) * 1000, text }));
    }
    plan = { idleSince: (d.idle_since || 0) * 1000, items };
  } catch (e) {
    // stack is down, the plan from the last good fetch still runs
  }
}

async function show(text, key) {
  const opts = { body: Names.apply(text), tag: 'jun-away-' + key, icon: 'icon-192.png' };
  const title = Names.getBot() || 'Jun';
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) { await reg.showNotification(title, opts); return; }
  } catch (e) {}
  const n = new Notification(title, opts);
  n.onclick = () => { window.focus(); n.close(); };
}

function tick() {
  if (!plan || !enabled()) return;
  const start = Math.max(plan.idleSince, lastHere);
  if (start !== shownFor) { shown.clear(); shownFor = start; }
  const now = Date.now();
  for (const it of plan.items) {
    const due = start + it.offset;
    if (due > now || shown.has(it.key)) continue;
    shown.add(it.key);
    if (now - due < STALE_MS) show(it.text, it.key);
  }
}

export function init() {
  const row = document.getElementById('awayNotifyRow');
  const chk = document.getElementById('awayNotifyChk');
  if (!supported() || !row || !chk) return;
  row.hidden = false;
  chk.checked = enabled();
  chk.addEventListener('change', async () => { chk.checked = await setEnabled(chk.checked); });
  // him touching this page ends the absence even if the server never hears of it
  for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, () => { lastHere = Date.now(); }, { passive: true });
  refresh();
  setInterval(refresh, POLL_MS);
  setInterval(tick, TICK_MS);
}

// the phone app does this natively, WorkManager writes and posts them
// with the app closed. the page only flips the switch and hands over the names
async function nativeCall(enabled) {
  const r = await fetch('api/consolidate.php?action=notify', enabled === undefined ? { credentials: 'same-origin' } : {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled, player: Names.getPlayer(), bot: Names.getBot() }),
  });
  if (!r.ok) throw new Error('notify ' + r.status);
  return r.json();
}

export async function initNative(toast) {
  const row = document.getElementById('awayNotifyRow');
  const chk = document.getElementById('awayNotifyChk');
  if (!row || !chk) return;
  let state;
  try { state = await nativeCall(); } catch (e) { return; }
  row.hidden = false;
  row.querySelector('.set-row-desc').textContent = 'Even with the app closed.';
  chk.checked = state.enabled;
  if (state.enabled) nativeCall(true).catch(() => {});
  chk.addEventListener('change', async () => {
    try { state = await nativeCall(chk.checked); } catch (e) { state = { enabled: false, permitted: true }; }
    chk.checked = state.enabled;
    if (!state.permitted) toast?.('Allow notifications for Jun OS in Android settings first.', 'error');
  });
}
