import { api } from '../core/api.js?v=1';
import { clamp } from '../core/util.js?v=1';
import * as Feed from './consolidation-feed.js?v=2';
import { runPassNow } from './consolidation.js?v=93';

const STORAGE_KEY = 'omega.devhud.v1';
const GEOM_KEY = 'omega.devhud.geom.v1';
const POLL_MS = 3000;
const TERM_MAX_LINES = 400;
const NOTE_SIGNS = { saved: '+', updated: '~', merged: '&', known: '=', dropped: '-', deleted: 'x' };

let root = null;
let fields = {};
let pollTimer = null;
let visible = false;
let term = null;
let liveLine = null;

let gen = { t0: 0, tFirst: 0, tLast: 0, active: 0, chunks: 0, final: null };

// a turn can just sit there for seconds between rounds while a
// tool runs, and that time is NOT decoding. count it and the live
// number comes out way under what the model is actually doing. so
// every gap gets capped at this, anything longer isn't the space
// between two tokens anyway.
const MAX_TOKEN_GAP_MS = 400;

function fmtBytes(n) {
  if (!n) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(n < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
}

function row(label, id) {
  return `<div class="devhud-row"><span class="devhud-k">${label}</span>` +
         `<span class="devhud-v" id="devhud-${id}">-</span></div>`;
}

function build() {
  root = document.createElement('div');
  root.id = 'devHud';
  root.className = 'devhud';
  root.hidden = true;
  root.innerHTML =
    '<div class="devhud-head"><span>dev</span>' +
    '<button class="devhud-close" title="Hide (Ctrl+Shift+D)" aria-label="Hide dev HUD">×</button></div>' +
    '<div class="devhud-body">' +
      row('tok/s', 'tps') +
      row('TTFT', 'ttft') +
      row('php prep', 'prep') +
      row('prefill', 'prefill') +
      row('gen tok', 'gentok') +
      row('prompt tok', 'ptok') +
      row('context', 'ctx') +
      '<div class="devhud-sep"></div>' +
      row('VRAM', 'vram') +
      row('model RAM', 'mram') +
      row('host RAM', 'hram') +
      row('model', 'model') +
    '</div>' +
    '<div class="devhud-term-head"><span>memory</span><button class="devhud-run" type="button">run now</button></div>' +
    '<div class="devhud-term" role="log" aria-label="Memory pass"></div>';
  document.body.appendChild(root);
  root.querySelector('.devhud-close').addEventListener('click', () => set(false));
  term = root.querySelector('.devhud-term');
  const runBtn = root.querySelector('.devhud-run');
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    termLine('run requested', 'dim');
    if (!(await runPassNow())) termLine('nothing started in 30 s', 'warn');
    runBtn.disabled = false;
  });
  Feed.subscribe(onFeed);
  fields = {};
  root.querySelectorAll('.devhud-v').forEach((el) => { fields[el.id.replace('devhud-', '')] = el; });

  restoreGeom();
  enableDrag(root.querySelector('.devhud-head'));
  if (window.ResizeObserver) {
    new ResizeObserver(() => { if (visible && root.offsetWidth) saveGeom(); }).observe(root);
  }
}

function saveGeom() {
  const r = root.getBoundingClientRect();
  try {
    localStorage.setItem(GEOM_KEY, JSON.stringify({
      left: Math.round(r.left), top: Math.round(r.top),
      w: root.offsetWidth, h: root.offsetHeight,
    }));
  } catch (e) {}
}

function restoreGeom() {
  let g = null;
  try { g = JSON.parse(localStorage.getItem(GEOM_KEY) || 'null'); } catch (e) {}
  if (!g) return;
  root.style.right = 'auto';
  root.style.left = clamp(g.left, 0, window.innerWidth - 60) + 'px';
  root.style.top = clamp(g.top, 0, window.innerHeight - 30) + 'px';
  if (g.w) root.style.width = g.w + 'px';
  if (g.h) root.style.height = g.h + 'px';
}

function enableDrag(handle) {
  let sx = 0, sy = 0, ox = 0, oy = 0;
  function onMove(e) {
    const w = root.offsetWidth, h = root.offsetHeight;
    root.style.left = clamp(ox + (e.clientX - sx), 0, window.innerWidth - w) + 'px';
    root.style.top = clamp(oy + (e.clientY - sy), 0, window.innerHeight - h) + 'px';
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    saveGeom();
  }
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('.devhud-close')) return;
    const r = root.getBoundingClientRect();
    root.style.right = 'auto';
    root.style.left = r.left + 'px';
    root.style.top = r.top + 'px';
    sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
    e.preventDefault();
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function put(id, text) { if (fields[id]) fields[id].textContent = text; }

function termLine(text, kind = '') {
  const stick = term.scrollTop + term.clientHeight >= term.scrollHeight - 8;
  const line = document.createElement('div');
  line.className = 'devhud-tl' + (kind ? ' devhud-tl--' + kind : '');
  line.textContent = text;
  term.append(line);
  while (term.childElementCount > TERM_MAX_LINES) term.firstElementChild.remove();
  if (stick) term.scrollTop = term.scrollHeight;
  return line;
}

const clock = (at) => new Date((at || Date.now() / 1000) * 1000).toTimeString().slice(0, 8);

function onFeed(ev) {
  if (ev.type !== 'tok') liveLine = null;
  switch (ev.type) {
    case 'pass':
      termLine(`${clock(ev.at)} pass · ${ev.chats} chats · ${ev.notes} notes`, 'head');
      break;
    case 'step': {
      const where = ev.step === 1 ? `chat ${ev.i}/${ev.n} ${ev.title}` : ev.step === 2 ? `note ${ev.i}/${ev.n}` : `journal ${ev.i}/${ev.n}`;
      termLine(`${clock(ev.at)} step ${ev.step}/3 · ${where}`, 'head');
      break;
    }
    case 'call':
      termLine(`  > ${ev.label}${ev.think ? ' (thinking)' : ''}`, 'dim');
      break;
    case 'tok':
      if (!liveLine || liveLine.dataset.kind !== ev.kind) {
        liveLine = termLine('    ', ev.kind);
        liveLine.dataset.kind = ev.kind;
      }
      liveLine.textContent += ev.text;
      if (term.scrollTop + term.clientHeight >= term.scrollHeight - 40) term.scrollTop = term.scrollHeight;
      break;
    case 'note':
      termLine(`  ${NOTE_SIGNS[ev.action] || '?'} ${ev.action}${ev.category ? ' [' + ev.category + ']' : ''} ${ev.text}${ev.why ? ' (' + ev.why + ')' : ''}`, 'note');
      break;
    case 'check':
      termLine(`  ? ${ev.text}`, 'dim');
      break;
    case 'journal':
      termLine(`  journal ${ev.date}: ${ev.text}`);
      break;
    case 'stall':
      termLine(ev.client ? '  !! nothing for 30 s, reconnecting' : `  !! stalled, restart ${ev.restart}`, 'warn');
      break;
    case 'done':
      termLine(`${clock(ev.at)} done · ${ev.status}${ev.notes != null ? ' · ' + ev.notes + ' notes' : ''}`, 'head');
      break;
  }
}

function set(on) {
  visible = !!on;
  if (root) root.hidden = !visible;
  try { localStorage.setItem(STORAGE_KEY, visible ? '1' : '0'); } catch (e) {}
  const chk = document.getElementById('devHudChk');
  if (chk) chk.checked = visible;
  if (visible) { poll(); startPolling(); } else { stopPolling(); }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

async function poll() {
  try {
    const r = await api('stats.php', { cache: 'no-store' });
    if (!r.ok) return;
    const s = await r.json();
    put('vram', fmtBytes(s.vram_bytes));
    put('mram', fmtBytes(s.ram_model_bytes));
    if (s.host) {
      put('hram', `${fmtBytes(s.host.used)} / ${fmtBytes(s.host.total)}`);
    }
    const m = (s.models && s.models[0]) || null;
    if (m) {
      const tag = [m.params, m.quant].filter(Boolean).join(' ');
      put('model', tag ? `${m.name} · ${tag}` : m.name);
    } else {
      put('model', 'none loaded');
    }
  } catch (e) { /* upstream down, keep the stale values */ }
}

export function beginGen() {
  gen = { t0: performance.now(), tFirst: 0, tLast: 0, active: 0, chunks: 0, final: null };
  put('tps', '…'); put('ttft', '…'); put('prep', '-'); put('prefill', '-'); put('gentok', '~0'); put('ptok', '-'); put('ctx', '-');
}

// counts stream CHUNKS, not tokens. on the ollama path they're
// the same thing, but an OpenAI style upstream can stuff several
// tokens in one delta. so anything we derive from this is shown
// as an estimate until the upstream's own counters land in
// setGenStats.
export function tickToken() {
  if (!gen.t0) return;
  const now = performance.now();
  if (!gen.tFirst) {
    gen.tFirst = now;
    put('ttft', ((now - gen.t0) / 1000).toFixed(2) + ' s');
  } else {
    gen.active += Math.min(now - gen.tLast, MAX_TOKEN_GAP_MS);
  }
  gen.tLast = now;
  gen.chunks++;
  if (gen.active > 250) put('tps', '~' + (gen.chunks / (gen.active / 1000)).toFixed(1));
  put('gentok', '~' + gen.chunks);
}

export function setGenStats(s) {
  if (!s) return;
  gen.final = s;
  if (s.eval_count && s.eval_duration) {
    put('tps', (s.eval_count / (s.eval_duration / 1e9)).toFixed(1));
    put('gentok', String(s.eval_count));
  }
  if (s.prompt_eval_count) put('ptok', String(s.prompt_eval_count));
  if (s.prep_ms != null) put('prep', s.prep_ms + ' ms');
  if (s.prompt_eval_duration) {
    const ms = Math.round(s.prompt_eval_duration / 1e6) + ' ms';
    put('prefill', s.prompt_new != null ? `${ms} (${s.prompt_new} new)` : ms);
  }
  if (s.num_ctx) {
    const used = (s.prompt_eval_count || 0) + (s.eval_count || 0);
    const pct = Math.round((used / s.num_ctx) * 100);
    put('ctx', `${used} / ${s.num_ctx} (${pct}%)`);
  }
}

export function init() {
  build();
  let stored = '0';
  try { stored = localStorage.getItem(STORAGE_KEY) || '0'; } catch (e) {}
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) { e.preventDefault(); set(!visible); }
  });
  const chk = document.getElementById('devHudChk');
  if (chk) chk.addEventListener('change', () => set(chk.checked));
  set(stored === '1');
}
