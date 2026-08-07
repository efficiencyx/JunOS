import { moodInputs, moodPhrases, moodRefreshBtn, moodVals } from './dom.js?v=61';
import { setSidebarOpen } from './sidebar.js?v=62';

const MOOD_PHRASES = {
  affection: [
    [90, "i'm completely yours"], [80, 'i love you so much'], [70, 'i love you'],
    [60, "i'm so happy with you"], [50, 'i really like you'], [40, 'i like being with you'],
    [30, "you're growing on me"], [20, 'you seem nice'], [10, 'still getting to know you'],
    [0, 'who are you again?'],
  ],
  trust: [
    [90, "i'd trust you with anything"], [80, 'i trust you completely'], [70, 'i trust you'],
    [60, "i'm starting to rely on you"], [50, 'i want to trust you'], [40, "i'm still a little guarded"],
    [30, "i'm not sure about you yet"], [20, "you'll have to earn it"], [10, 'i barely know you'],
    [0, "i don't trust you"],
  ],
  tension: [
    [90, "i'm terrified"], [80, "i'm really scared"], [70, "i'm scared"],
    [60, 'this is too much'], [50, "i'm on edge"], [40, 'a little tense'],
    [30, 'slightly uneasy'], [20, 'mostly calm'], [10, 'i feel relaxed'],
    [0, 'totally at ease'],
  ],
};
const EMOTION_TINTS = {
  angry:       { hue: 5,   sat: 20,  light: -8, w: .85 },
  crying:      { hue: 205, sat: -16, light: -6, w: .8 },
  sad:         { hue: 215, sat: -18, light: -4, w: .7 },
  surprised:   { hue: 15,  sat: 12,  light: 2,  w: .6 },
  embarrassed: { hue: 335, sat: 14,  light: 2,  w: .85 },
  excited:     { hue: 350, sat: 16,  light: 4,  w: .7 },
  laughing:    { hue: 340, sat: 14,  light: 4,  w: .6 },
  happy:       { hue: 330, sat: 10,  light: 3,  w: .5 },
  smug:        { hue: 300, sat: 8,   light: 0,  w: .45 },
  pout:        { hue: 250, sat: -6,  light: -2, w: .4 },
  sleepy:      { hue: 235, sat: -25, light: -6, w: .5 },
};
const TINT_EASE_MS = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200;
const tint = { hue: 0, sat: 0, light: 0, w: 0 };
const tintGoal = { hue: 0, sat: 0, light: 0, w: 0 };
const moodBaseline = { affection: 50, trust: 50, tension: 30 };
let tintFrame = 0;
let lastTintTs = 0;

const shortestArc = (a, b) => ((b - a) % 360 + 540) % 360 - 180;

export function noteEmotionTint(action) {
  let entry = null;
  let scale = 1;
  if (action.name === 'emote') {
    entry = EMOTION_TINTS[action.kwargs.type];
  } else if (action.name === 'brow') {
    const key = action.kwargs.emotion === 'worried' ? 'sad' : action.kwargs.emotion;
    entry = EMOTION_TINTS[key];
    scale = 0.55;
  } else if (action.name === 'blush') {
    entry = EMOTION_TINTS.embarrassed;
    const intensity = parseFloat(action.kwargs.intensity);
    scale = 0.45 * (isNaN(intensity) ? 0.5 : intensity);
  } else if (action.name === 'shocked') {
    entry = EMOTION_TINTS.surprised;
  } else if (action.name === 'heart_eyes') {
    entry = EMOTION_TINTS.embarrassed;
  }
  if (!entry) return;
  tintGoal.hue = entry.hue;
  tintGoal.sat = entry.sat;
  tintGoal.light = entry.light;
  tintGoal.w = entry.w * scale;
  startTintLoop();
}

function startTintLoop() {
  if (tintFrame) return;
  lastTintTs = 0;
  tintFrame = requestAnimationFrame(stepTint);
}

function stepTint(ts) {
  const dt = lastTintTs ? Math.min(100, ts - lastTintTs) : 16;
  lastTintTs = ts;
  tintGoal.w *= Math.exp(-dt / 2600);
  const k = TINT_EASE_MS ? 1 - Math.exp(-dt / TINT_EASE_MS) : 1;
  tint.hue += shortestArc(tint.hue, tintGoal.hue) * k;
  tint.sat += (tintGoal.sat - tint.sat) * k;
  tint.light += (tintGoal.light - tint.light) * k;
  tint.w += (tintGoal.w - tint.w) * k;
  paintAccent();
  if (tint.w > 0.004) {
    tintFrame = requestAnimationFrame(stepTint);
  } else {
    tint.w = 0;
    paintAccent();
    tintFrame = 0;
  }
}

function moodAccent(affection, trust, tension) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const a = clamp(affection / 100, 0, 1);
  const t = clamp(trust / 100, 0, 1);
  const x = clamp(tension / 100, 0, 1);
  const calm = 214 + a * 96;                   // distant blue → loving rose
  // tension pulls the whole accent toward the tension gauge colour (#ff7a55
  // in styles.css); at 100 it lands exactly on it, whatever affection/trust say.
  let hue = (calm + shortestArc(calm, 13) * x + 360) % 360;
  let sat = clamp((60 + t * 28) * (1 - x) + 100 * x, 42, 100);
  let light = clamp(74 * (1 - x) + 67 * x, 62, 78);
  if (tint.w > 0) {
    hue = (hue + shortestArc(hue, tint.hue) * tint.w + 360) % 360;
    sat = clamp(sat + tint.sat * tint.w, 38, 100);
    light = clamp(light + tint.light * tint.w, 56, 82);
  }
  return {
    accent: `hsl(${hue} ${sat}% ${light}%)`,
    accent2: `hsl(${hue + 16} ${clamp(sat + 6, 42, 100)}% ${clamp(light + 7, 62, 86)}%)`,
    soft: `hsl(${hue} ${sat}% ${light}% / .12)`,
  };
}
function paintAccent() {
  const c = moodAccent(moodBaseline.affection, moodBaseline.trust, moodBaseline.tension);
  const root = document.documentElement.style;
  root.setProperty('--accent', c.accent);
  root.setProperty('--accent-2', c.accent2);
  root.setProperty('--accent-soft', c.soft);
}
function applyMoodAccent(vals) {
  moodBaseline.affection = vals.affection ?? 50;
  moodBaseline.trust = vals.trust ?? 50;
  moodBaseline.tension = vals.tension ?? 30;
  paintAccent();
}
function currentMood() {
  const dflt = { affection: 50, trust: 50, tension: 30 };
  const v = {};
  for (const k of ['affection', 'trust', 'tension']) {
    v[k] = moodInputs[k] ? (parseInt(moodInputs[k].value, 10) || 0) : dflt[k];
  }
  return v;
}
function setMoodFill(k) {
  const input = moodInputs[k];
  if (!input) return;
  const min = Number(input.min);
  const max = Number(input.max);
  const t = (Number(input.value) - min) / (max - min);
  const row = input.closest('.mood-row') || input;
  const gauge = getComputedStyle(row).getPropertyValue('--gauge').trim();
  row.style.setProperty('--fill', t * 100 + '%');
  row.style.setProperty('--fill-color',
    `color-mix(in srgb, ${gauge} ${Math.round((0.25 + 0.75 * t) * 100)}%, var(--track-empty))`);
  row.style.setProperty('--glow',
    `color-mix(in srgb, ${gauge} ${Math.round(Math.max(0, t - 0.35) / 0.65 * 100)}%, transparent)`);
  setMoodPhrase(k, Number(input.value));
}
function setMoodPhrase(k, value) {
  const el = moodPhrases[k];
  if (!el) return;
  const band = (MOOD_PHRASES[k] || []).find(([min]) => value >= min);
  const text = band ? band[1] : '';
  const next = (text ? text.padEnd(30, '\u2003') : '').repeat(6);
  if (el.textContent === next) return;
  el.textContent = next;
}
function renderMood(state) {
  for (const k of ['affection', 'trust', 'tension']) {
    if (state && typeof state[k] === 'number') {
      if (moodInputs[k]) {
        moodInputs[k].value = state[k];
        setMoodFill(k);
      }
      if (moodVals[k]) moodVals[k].textContent = state[k];
    }
  }
  applyMoodAccent(currentMood());
  if (window.Live2D && Live2D.setMood) Live2D.setMood(state);
}
export async function loadMood() {
  try {
    const r = await fetch('/api/relationship.php', { credentials: 'same-origin' });
    if (r.ok) renderMood(await r.json());
  } catch (e) { /* offline: leave sliders as-is */ }
}
let moodPushTimer = null;
function pushMood() {
  const body = {};
  for (const k of ['affection', 'trust', 'tension']) {
    body[k] = moodInputs[k] ? parseInt(moodInputs[k].value, 10) || 0 : 0;
  }
  if (moodPushTimer) clearTimeout(moodPushTimer);
  moodPushTimer = setTimeout(async () => {
    try {
      const r = await fetch('/api/relationship.php', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.ok) renderMood(await r.json()); // reflect server-side clamping
    } catch (e) { /* drop; next drag retries */ }
  }, 300);
}
for (const k of ['affection', 'trust', 'tension']) {
  if (!moodInputs[k]) continue;
  setMoodFill(k);
  moodInputs[k].addEventListener('input', () => {
    if (moodVals[k]) moodVals[k].textContent = moodInputs[k].value;
    setMoodFill(k);
    const live = {};
    for (const j of ['affection', 'trust', 'tension']) {
      if (moodInputs[j]) live[j] = parseInt(moodInputs[j].value, 10) || 0;
    }
    applyMoodAccent(live);
    if (window.Live2D && Live2D.setMood) Live2D.setMood(live);
  });
  moodInputs[k].addEventListener('change', pushMood);
}
applyMoodAccent(currentMood());
if (moodRefreshBtn) moodRefreshBtn.addEventListener('click', loadMood);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.body.classList.contains('sidebar-open')) {
    setSidebarOpen(false);
    return;
  }
  const d = document.getElementById('settingsDrawer');
  if (d && d.classList.contains('open')) ui.toggleDrawer(false);
});
