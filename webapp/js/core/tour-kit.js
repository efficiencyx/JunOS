// the tour's chrome: spotlight, lower third, the skippable waits.
// app/tour.js runs the chat page on it, wardrobe/tour-shop.js the shop

const NARRATOR = 'efficiencyx';
const NARRATOR_ART = 'tour-narrator.png?v=1';
const RING_PAD = 6;
const RING_RADIUS = 12;
const SPOT_MS = 520;
const CAPTION_FADE_MS = 240;
const LEAVE_MS = 320;
const DOCKS = ['bl', 'br', 'tl', 'tr'];
const DOCK_CLEARANCE = 12;
export const SKIPPED = Symbol('skipped');

function build() {
  const root = document.createElement('div');
  root.className = 'tour';
  root.dataset.dock = DOCKS[0];
  root.innerHTML = `
    <div class="tour-block"></div>
    <div class="tour-fx"></div>
    <div class="tour-spot"></div>
    <div class="tour-scrim"></div>
    <div class="tour-l3 signon swap" role="status" hidden>
      <div class="tour-text">
        <div class="tour-who"><img class="tour-face" src="${NARRATOR_ART}" alt="" width="22" height="22">${NARRATOR}</div>
        <p class="tour-label"></p>
        <div class="tour-rule"></div>
        <p class="tour-cap"></p>
      </div>
      <button class="tour-next" type="button">next</button>
    </div>
    <button class="tour-skip ghost" type="button">skip</button>
    <div class="tour-black"></div>`;
  const q = (c) => root.querySelector(c);
  return {
    root, block: q('.tour-block'), spot: q('.tour-spot'), l3: q('.tour-l3'), label: q('.tour-label'),
    cap: q('.tour-cap'), next: q('.tour-next'), skip: q('.tour-skip'),
  };
}

export function unionRect(els) {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const el of els) {
    const box = el.getBoundingClientRect();
    if (!box.width && !box.height) continue;
    // rows scrolled out of the dialog still measure, the spot must not
    const clip = el.closest('.settings-drawer')?.getBoundingClientRect() || box;
    l = Math.min(l, Math.max(box.left, clip.left)); t = Math.min(t, Math.max(box.top, clip.top));
    r = Math.max(r, Math.min(box.right, clip.right)); b = Math.max(b, Math.min(box.bottom, clip.bottom));
  }
  if (r < l) return null;
  const W = window.innerWidth, H = window.innerHeight;
  l = Math.max(4, l - RING_PAD); t = Math.max(4, t - RING_PAD);
  r = Math.min(W - 4, r + RING_PAD); b = Math.min(H - 4, b + RING_PAD);
  return { x: l, y: t, w: r - l, h: b - t };
}

const viewportBox = () => ({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight, r: 0 });

function mix(a, b, e) {
  const out = {};
  for (const k of ['x', 'y', 'w', 'h', 'r']) out[k] = a[k] + (b[k] - a[k]) * e;
  return out;
}

function overlap(a, b) {
  const w = Math.min(a.right, b.x + b.w + DOCK_CLEARANCE) - Math.max(a.left, b.x - DOCK_CLEARANCE);
  const h = Math.min(a.bottom, b.y + b.h + DOCK_CLEARANCE) - Math.max(a.top, b.y - DOCK_CLEARANCE);
  return Math.max(0, w) * Math.max(0, h);
}

function pickDock(el, rect) {
  if (!rect) return DOCKS[0];
  let best = DOCKS[0], least = Infinity;
  for (const dock of DOCKS) {
    el.root.dataset.dock = dock;
    const area = overlap(el.l3.getBoundingClientRect(), rect);
    if (area < least) { least = area; best = dock; }
  }
  return best;
}

export function makeRun() {
  const el = build();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const timers = new Set();
  const waiting = new Set();
  const state = { el, reduced, target: null, box: viewportBox(), from: null, t0: 0, lit: false, raf: 0, skipped: false, talking: false };

  state.until = (arm) => new Promise((resolve, reject) => {
    if (state.skipped) return reject(SKIPPED);
    waiting.add(reject);
    arm(() => { waiting.delete(reject); resolve(); });
  });
  state.wait = (ms) => state.until((done) => timers.add(setTimeout(done, ms)));
  state.clearTimers = () => { for (const t of timers) clearTimeout(t); timers.clear(); };
  state.skip = () => {
    state.skipped = true;
    for (const reject of waiting) reject(SKIPPED);
    waiting.clear();
  };

  state.aim = (targets) => {
    state.target = targets && targets.length ? () => targets : null;
    state.from = state.box;
    state.t0 = performance.now();
    state.landed = false;
  };

  // the spot chases whatever the target measures THIS frame, so a
  // drawer still sliding or a list still loading can't leave it
  // pointing at where the thing used to be
  let drawn = '';
  const tick = (now) => {
    state.raf = requestAnimationFrame(tick);
    const rect = state.target ? unionRect(state.target()) : null;
    if (!!rect !== state.lit) {
      state.lit = !!rect;
      state.from = state.box;
      state.t0 = now;
      state.landed = false;
      el.root.classList.toggle('has-target', state.lit);
    }
    const goal = rect ? { ...rect, r: Math.min(RING_RADIUS, rect.w / 2, rect.h / 2) } : viewportBox();
    const p = reduced || !state.from ? 1 : Math.max(0, Math.min(1, (now - state.t0) / SPOT_MS));
    const b = state.box = mix(state.from || goal, goal, 1 - (1 - p) ** 4);
    const css = `${b.x.toFixed(1)} ${b.y.toFixed(1)} ${b.w.toFixed(1)} ${b.h.toFixed(1)} ${b.r.toFixed(1)}`;
    if (css !== drawn) {
      drawn = css;
      el.spot.style.transform = `translate(${b.x}px, ${b.y}px)`;
      el.spot.style.width = b.w + 'px';
      el.spot.style.height = b.h + 'px';
      el.spot.style.borderRadius = b.r + 'px';
    }
    if (p === 1 && rect && !state.landed) {
      state.landed = true;
      el.spot.classList.remove('ping');
      void el.spot.offsetWidth;
      el.spot.classList.add('ping');
    }
  };

  state.onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    state.skip();
  };
  el.skip.addEventListener('click', state.skip);
  window.addEventListener('keydown', state.onKey, true);
  document.body.appendChild(el.root);
  document.body.classList.add('tour-mode');
  state.raf = requestAnimationFrame(tick);
  return state;
}

export function hush(s) {
  const was = s.el.root.classList.contains('captioned');
  s.el.root.classList.remove('captioned');
  s.el.l3.classList.add('swap');
  return was;
}

// old caption fades out first, the new one wipes in after. a
// straight text swap is one frame of the wrong words
export async function caption(s, text, rect) {
  const { el } = s;
  if (hush(s) && !s.reduced) await s.wait(CAPTION_FADE_MS);
  [el.label.textContent, el.cap.textContent] = text;
  el.l3.classList.toggle('signon', !s.signedOn);
  s.signedOn = true;
  el.l3.hidden = false;
  el.root.dataset.dock = pickDock(el, rect);
  el.l3.classList.remove('play', 'swap');
  void el.l3.offsetWidth;
  el.l3.classList.add('play');
  el.root.classList.add('captioned');
}

export async function close(s) {
  s.clearTimers();
  window.removeEventListener('keydown', s.onKey, true);
  s.el.root.classList.add('is-leaving');
  // the dialog is still fading. pull the band NOW and it jumps
  if (!s.reduced) await new Promise((r) => setTimeout(r, LEAVE_MS));
  cancelAnimationFrame(s.raf);
  document.body.classList.remove('tour-mode', 'tour-band', 'tour-stage');
  s.el.root.remove();
}
