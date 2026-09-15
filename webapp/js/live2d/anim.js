import { LERP_TAU_MS, app, currentValues, forcedPartOpacity, loops, markDirty, model, paramDefault, paramIndex, paramMax, paramMin, pendingSequences, raw, scheduleSequence, startLoop, stopLoop, targetParams } from '../live2d.js?v=10';
import { daypart, moodFactors, moodTier } from '../mood-tier.js?v=10';
import { cameraTween } from './camera.js?v=10';
import { clamp } from './geometry.js?v=10';
import { S } from './state.js?v=10';

const ACTIVE_FPS = 60;
const IDLE_FPS = 30;

let lastTickMs = performance.now();
let animating = false;
let wasAnimating = false;
let tickDeltaMs = 0;

// tints, opacity, order, atlases and camera changes bypass
// parameters. mark them dirty here or the canvas stays stale.
const STATEFUL_PARAMS = new Set([
  'ParamShirtEnabled', 'ParamBraEnabled', 'ParamPantiesEnabled',
  'ParamSkirtEnabled', 'ParamHoodieEnabled', 'ParamPantsEnabled',
  'ParamDress2Enabled', 'ParamShoeLOn', 'ParamShoeROn',
  'ParamHandholdingLEnable', 'ParamHandholdingREnable',
  'ParamCuddleHandholdingEnable', 'ParamFaceRubEnable',
]);

export function resetIdle() {
  const preserved = new Map();
  for (const id of STATEFUL_PARAMS) {
    if (!paramIndex.has(id)) continue;
    const t = targetParams.get(id);
    const c = currentValues.get(id);
    preserved.set(id, t !== undefined ? t : (c !== undefined ? c : paramDefault.get(id)));
  }
  targetParams.clear();
  pendingSequences.length = 0;
  for (const id of [...loops.keys()]) {
    if (!STATEFUL_PARAMS.has(id)) loops.delete(id);
  }
  for (const [id, def] of paramDefault) {
    if (STATEFUL_PARAMS.has(id)) continue;
    targetParams.set(id, def);
  }
  for (const [id, v] of preserved) {
    targetParams.set(id, v);
    currentValues.set(id, v);
  }
}

let idleActive = false;
let blinkTimeout = null;
let fidgetTimeout = null;
const mood = { affection: 50, trust: 50, tension: 0 };

export function setMood(m) {
  for (const k of ['affection', 'trust', 'tension']) {
    const v = Number(m && m[k]);
    if (Number.isFinite(v)) mood[k] = Math.max(0, Math.min(100, v));
  }
  if (idleActive) applyMoodBaseline();
}

const DAYPART_PACE = { night: 2.1, morning: 1.35, day: 1, evening: 0.85 };

const DAYPART_BASELINE = {
  night:   { eyeOpen: -0.28, browY: -0.15, breath: 1.5, ear: -0.4 },
  morning: { eyeOpen: -0.12, browY: -0.05, breath: 1.2, ear: -0.15 },
  day:     { eyeOpen: 0, browY: 0, breath: 1, ear: 0 },
  evening: { eyeOpen: 0, browY: 0.05, breath: 0.9, ear: 0.1 },
};

function trySet(param, value) {
  if (paramIndex.has(param)) targetParams.set(param, clamp(param, value));
}

function applyMoodBaseline() {
  const { warmth, fear } = moodFactors(mood);
  const hour = DAYPART_BASELINE[daypart()];
  const drowsy = 1 - Math.min(1, fear / 0.4);

  trySet('ParamMouthForm', warmth > 0 ? warmth * 0.6 : warmth * 0.4);
  const brow = warmth * 0.4 - fear * 0.6;
  trySet('ParamBrowLEmote', brow);
  trySet('ParamBrowREmote', brow);
  trySet('ParamBrowLRot', fear * 0.3);
  trySet('ParamBrowRRot', -fear * 0.3);
  const browY = warmth * 0.2 + fear * 0.3 + hour.browY * drowsy;
  trySet('ParamBrowLY', browY);
  trySet('ParamBrowRY', browY);

  let ear = fear > 0.3 ? -1 : (warmth > 0.3 ? 1 : (warmth < -0.3 ? -0.6 : 0));
  ear += hour.ear * drowsy;
  trySet('ParamEarL', ear);
  trySet('ParamEarR', ear);

  trySet('ParamEyesHappy', warmth >= 0.7 && fear === 0 ? 0.6 : 0);
  trySet('ParamBlush', warmth >= 0.7 && fear === 0 ? 0.25 : 0);
  trySet('ParamIrisZoom', -0.4 * fear);
  const eyeOpen = fear > 0.3 ? 1 : (warmth < -0.4 ? 0.7 : 1);
  trySet('ParamEyeOpen', eyeOpen + hour.eyeOpen * drowsy);

  if (fear > 0.4) {
    tryLoop('ParamHeadZ', 0.01 + 0.02 * fear, 220);
    tryLoop('ParamHeadX', 0.01 + 0.02 * fear, 120);
    tryLoop('ParamBodyX', 0.01 + 0.01 * fear, 200);
    tryLoop('ParamBodyY', 0.05, 1600);
  } else {
    stopLoop('ParamHeadZ');
    stopLoop('ParamHeadX');
    stopLoop('ParamBodyX');
    trySet('ParamHeadZ', paramDefault.get('ParamHeadZ') || 0);
    trySet('ParamHeadX', paramDefault.get('ParamHeadX') || 0);
    trySet('ParamBodyX', paramDefault.get('ParamBodyX') || 0);
    tryLoop('ParamBodyY', warmth > 0.4 ? 0.2 : 0.15, (warmth > 0.4 ? 3000 : 3800) * hour.breath);
  }
}
let blinkPhase = null;
let mouthOverride = null;

export function setMouthOverride(v) {
  markDirty();
  if (v == null) { mouthOverride = null; return; }
  mouthOverride = Math.max(0, Math.min(1, v));
}

function tryLoop(param, amplitude, period_ms) {
  if (paramIndex.has(param)) startLoop(param, amplitude, period_ms);
}

function triggerBlink() {
  if (!paramIndex.has('ParamEyeOpen')) return;
  // a yawn or a doze keeps the eyes shut the Whole time. a blink
  // underneath would pop them open right in the middle of it.
  if (pendingSequences.some(s => s.param === 'ParamEyeOpen')) return;
  blinkPhase = { startMs: performance.now(), closeMs: 70, holdMs: 50, openMs: 120 };
}

function scheduleBlink() {
  if (blinkTimeout) clearTimeout(blinkTimeout);
  const delay = 2200 + Math.random() * 4000;
  blinkTimeout = setTimeout(() => {
    if (!idleActive) return;
    triggerBlink();
    if (Math.random() < 0.18) {
      setTimeout(() => { if (idleActive) triggerBlink(); }, 280);
    }
    scheduleBlink();
  }, delay);
}

const FIDGETS = [
  { kind: 'loop', param: 'ParamTailWiggle', amp: 0.5, period: 900, duration: 2400 },
  { kind: 'loop', param: 'ParamEarsWiggle', amp: 0.4, period: 700, duration: 1400, moods: ['neutral', 'happy', 'nervous'] },
  { kind: 'loop', param: 'ParamHeadX', amp: 1.2, period: 4200, duration: 4200, moods: ['neutral', 'happy', 'upset', 'nervous'] },
  { kind: 'loop', param: 'ParamHeadY', amp: 0.8, period: 3800, duration: 3800 },
  { kind: 'loop', param: 'ParamEyeballLX', amp: 0.3, period: 2600, duration: 2600, pair: 'ParamEyeballRX' },
  { kind: 'loop', param: 'ParamBodyX', amp: 0.2, period: 5000, duration: 5000, moods: ['neutral', 'happy', 'upset'] },
  { kind: 'pose', param: 'ParamLegL', value: 0.35, hold: 1800 },
  { kind: 'pose', param: 'ParamLegR', value: 0.35, hold: 1800 },
  { kind: 'pose', param: 'ParamLegL', value: -0.25, hold: 1500 },
  { kind: 'pose', param: 'ParamLegR', value: -0.25, hold: 1500 },
  { kind: 'pose', param: 'ParamArmLUp', value: 0.25, hold: 1600, moods: ['neutral', 'happy', 'nervous'] },
  { kind: 'pose', param: 'ParamArmRUp', value: 0.25, hold: 1600, moods: ['neutral', 'happy', 'nervous'] },
  { kind: 'pose', param: 'ParamArmLRot', value: 0.3, hold: 1400 },
  { kind: 'pose', param: 'ParamArmRRot', value: -0.3, hold: 1400 },
  { kind: 'pose', param: 'ParamArmLGesture', value: 0.4, hold: 1200 },
  { kind: 'pose', param: 'ParamArmRGesture', value: 0.4, hold: 1200 },

  { moods: ['happy'], kind: 'seq', param: 'ParamArmRUp', steps: [
    { params: { ParamArmRUp: 1, ParamArmRGesture: 2 }, dt_ms: 0 },
    { params: { ParamArmRRot: 0.4 }, dt_ms: 250 },
    { params: { ParamArmRRot: -0.4 }, dt_ms: 250 },
    { params: { ParamArmRRot: 0.4 }, dt_ms: 250 },
    { params: { ParamArmRRot: 0, ParamArmRUp: 0, ParamArmRGesture: 1 }, dt_ms: 350 },
  ] },
  { moods: ['happy'], kind: 'seq', param: 'ParamHeart', steps: [
    { params: { ParamHeart: 1, ParamIrisZoom: 0.5 }, dt_ms: 0 },
    { params: { ParamHeart: 0, ParamIrisZoom: 0 }, dt_ms: 2200 },
  ] },
  { moods: ['happy'], kind: 'seq', param: 'ParamEyesHappy', steps: [
    { params: { ParamEyesHappy: 1, ParamMouthForm: 1 }, dt_ms: 0 },
    { params: { ParamEyesHappy: 0.6, ParamMouthForm: 0.6 }, dt_ms: 2400 },
  ] },
  { moods: ['happy'], kind: 'loop', param: 'ParamTailWiggle', amp: 1, period: 600, duration: 2600 },
  { moods: ['happy'], kind: 'seq', param: 'ParamHeadZ', steps: [
    { params: { ParamHeadZ: -10 }, dt_ms: 0 },
    { params: { ParamHeadZ: 0 }, dt_ms: 1800 },
  ] },

  { moods: ['upset'], kind: 'seq', param: 'ParamEyeballLY', steps: [
    { params: { ParamEyeballLY: -0.8, ParamEyeballRY: -0.8, ParamHeadY: -0.3 }, dt_ms: 0 },
    { params: { ParamEyeballLY: 0, ParamEyeballRY: 0, ParamHeadY: 0 }, dt_ms: 2600 },
  ] },
  { moods: ['upset'], kind: 'seq', param: 'ParamHeadX', steps: [
    { params: { ParamHeadX: 0.4, ParamEyeballLX: 0.7, ParamEyeballRX: 0.7 }, dt_ms: 0 },
    { params: { ParamHeadX: 0, ParamEyeballLX: 0, ParamEyeballRX: 0 }, dt_ms: 2400 },
  ] },
  { moods: ['upset'], kind: 'seq', param: 'ParamBodyY', steps: [
    { params: { ParamBodyY: 0.3 }, dt_ms: 0 },
    { params: { ParamBodyY: -0.2, ParamMouthOpen: 0.3 }, dt_ms: 500 },
    { params: { ParamBodyY: 0, ParamMouthOpen: 0 }, dt_ms: 700 },
  ] },

  { moods: ['nervous', 'scared'], kind: 'seq', param: 'ParamEyeballLX', steps: [
    { params: { ParamEyeballLX: -0.8, ParamEyeballRX: -0.8 }, dt_ms: 0 },
    { params: { ParamEyeballLX: 0.8, ParamEyeballRX: 0.8 }, dt_ms: 380 },
    { params: { ParamEyeballLX: 0, ParamEyeballRX: 0 }, dt_ms: 380 },
  ] },
  { moods: ['scared'], kind: 'seq', param: 'ParamEyeLShock', steps: [
    { params: { ParamEyeLShock: 1, ParamEyeRShock: 1 }, dt_ms: 0 },
    { params: { ParamEyeLShock: 0, ParamEyeRShock: 0 }, dt_ms: 1400 },
  ] },
  { moods: ['scared'], kind: 'pose', param: 'ParamArmLUp', value: -1, pairValue: { ParamArmRUp: -1 }, hold: 2600 },
  { moods: ['nervous'], kind: 'pose', param: 'ParamArmLRot', value: 0.2, pairValue: { ParamArmRRot: -0.2 }, hold: 1200 },

  { parts: ['night', 'morning'], kind: 'seq', param: 'ParamMouthOpen', steps: [
    { params: { ParamMouthOpen: 0.35, ParamEyeOpen: 0.5 }, dt_ms: 0 },
    { params: { ParamMouthOpen: 1, ParamEyeOpen: 0, ParamBrowLY: 0.4, ParamBrowRY: 0.4 }, dt_ms: 500 },
    { params: { ParamMouthOpen: 0.8, ParamEyeOpen: 0 }, dt_ms: 900 },
    { params: { ParamMouthOpen: 0, ParamEyeOpen: 1, ParamBrowLY: 0, ParamBrowRY: 0 }, dt_ms: 700 },
  ] },
  { parts: ['night'], kind: 'seq', param: 'ParamEyeOpen', steps: [
    { params: { ParamEyeOpen: 0.15 }, dt_ms: 0 },
    { params: { ParamEyeOpen: 0.15 }, dt_ms: 2600 },
    { params: { ParamEyeOpen: 1 }, dt_ms: 500 },
  ] },
  { parts: ['night'], kind: 'seq', param: 'ParamHeadY', steps: [
    { params: { ParamHeadY: -0.5, ParamEyeOpen: 0.2 }, dt_ms: 0 },
    { params: { ParamHeadY: -0.55, ParamEyeOpen: 0.1 }, dt_ms: 2200 },
    { params: { ParamHeadY: 0, ParamEyeOpen: 1 }, dt_ms: 600 },
  ] },
  { parts: ['night'], kind: 'pose', param: 'ParamArmLUp', value: 0.4, pairValue: { ParamArmLRot: 0.5 }, hold: 2000 },
  { parts: ['morning'], kind: 'seq', param: 'ParamArmLUp', steps: [
    { params: { ParamArmLUp: 1, ParamArmRUp: 1, ParamBodyY: 0.3, ParamEyeOpen: 0.2 }, dt_ms: 0 },
    { params: { ParamArmLUp: 1, ParamArmRUp: 1, ParamBodyY: 0.35, ParamMouthOpen: 0.4 }, dt_ms: 1100 },
    { params: { ParamArmLUp: 0, ParamArmRUp: 0, ParamBodyY: 0, ParamMouthOpen: 0, ParamEyeOpen: 1 }, dt_ms: 800 },
  ] },
  { parts: ['evening'], kind: 'loop', param: 'ParamTailWiggle', amp: 0.7, period: 750, duration: 3000 },
  { parts: ['evening'], kind: 'loop', param: 'ParamBodyX', amp: 0.35, period: 2400, duration: 4800 },
  { parts: ['day'], kind: 'loop', param: 'ParamEyeballLX', amp: 0.45, period: 2000, duration: 4000, pair: 'ParamEyeballRX' },
];

const FIDGET_DELAYS = {
  happy:   [1500, 4000],
  scared:  [1500, 3500],
  nervous: [1800, 4500],
  upset:   [3000, 7000],
  neutral: [2000, 6000],
};

function runFidget(f) {
  if (f.kind === 'seq') {
    scheduleSequence(f.steps);
    // the last step of a sequence is a fixed value, so anything it
    // touched that the baseline also owns (eyes, brows, mouth form)
    // just stays where the sequence left it until the gauges move
    // again. so put it back once the sequence is done.
    const total = f.steps.reduce((sum, s) => sum + s.dt_ms, 0);
    setTimeout(() => { if (idleActive) applyMoodBaseline(); }, total + 200);
    return;
  }
  if (f.kind === 'pose') {
    targetParams.set(f.param, clamp(f.param, f.value));
    const extras = f.pairValue || {};
    for (const [p, v] of Object.entries(extras)) {
      if (paramIndex.has(p)) targetParams.set(p, clamp(p, v));
    }
    setTimeout(() => {
      targetParams.set(f.param, paramDefault.get(f.param));
      for (const p of Object.keys(extras)) {
        if (paramIndex.has(p)) targetParams.set(p, paramDefault.get(p));
      }
    }, f.hold);
    return;
  }
  startLoop(f.param, f.amp, f.period);
  if (f.pair && paramIndex.has(f.pair)) startLoop(f.pair, f.amp, f.period);
  setTimeout(() => {
    stopLoop(f.param);
    if (f.pair) stopLoop(f.pair);
    targetParams.set(f.param, paramDefault.get(f.param));
    if (f.pair) targetParams.set(f.pair, paramDefault.get(f.pair));
  }, f.duration);
}

let lastDaypart = '';
let fidgetsEnabled = true;

// blinking keeps going ON PURPOSE. a scripted scene wants the
// arms and head left alone, but a model that stops blinking for
// ten seconds looks dead.
export function setFidgetsEnabled(on) {
  fidgetsEnabled = !!on;
  if (fidgetsEnabled && idleActive) scheduleFidget();
}

function scheduleFidget() {
  if (fidgetTimeout) clearTimeout(fidgetTimeout);
  const tier = moodTier(mood);
  const part = daypart();
  const [lo, hi] = FIDGET_DELAYS[tier] || FIDGET_DELAYS.neutral;
  const pace = DAYPART_PACE[part] || 1;
  const delay = (lo + Math.random() * (hi - lo)) * pace;
  fidgetTimeout = setTimeout(() => {
    if (!idleActive) return;
    if (!fidgetsEnabled) return;
    const now = daypart();
    // the hour changes during a long session, and otherwise we only
    // redo the baseline when the gauges move, which could be hours
    // away
    if (now !== lastDaypart) {
      lastDaypart = now;
      applyMoodBaseline();
    }
    const candidates = [];
    for (const f of FIDGETS) {
      if (!paramIndex.has(f.param)) continue;
      if (f.moods && !f.moods.includes(tier)) continue;
      if (f.parts && !f.parts.includes(now)) continue;
      candidates.push(f);
      if (f.moods || f.parts) candidates.push(f);
    }
    if (candidates.length) {
      runFidget(candidates[Math.floor(Math.random() * candidates.length)]);
    }
    scheduleFidget();
  }, delay);
}

export function startIdle() {
  idleActive = true;
  lastDaypart = daypart();
  applyMoodBaseline();
  scheduleBlink();
  scheduleFidget();
}

export function stopIdle() {
  idleActive = false;
  if (blinkTimeout) { clearTimeout(blinkTimeout); blinkTimeout = null; }
  if (fidgetTimeout) { clearTimeout(fidgetTimeout); fidgetTimeout = null; }
}

// ParamTailWiggle, ParamHairPhysicsBaseToShort and
// ParamPhysicsBoobXL need the missing physics3.json. drive the
// nine tail rotation params root-to-tip with a delayed sine so
// [A:tail_wag] and fidgets actually move it.
const TAIL_SEGMENTS = Array.from({ length: 9 }, (_, i) => `Param_Angle_Rotation_${i + 1}_TailMain`);
// fractions of each segment's own range, because these are angle
// params and their range is whatever the rigger picked. 0.18 is a
// resting sway, the wiggle on top is what the fidgets and
// [A:tail_wag] actually buy you now.
const TAIL_IDLE_AMP = 0.18;
const TAIL_WAG_AMP = 0.7;
const TAIL_PERIOD_MS = 5200;
// how far behind the segment above each one runs, in periods
const TAIL_LAG = 0.1;
/* phase has to ACCUMULATE. now / period jumps when wiggle
   changes period. dropping 2800 -> 1260 at now = 100000 moves
   phase by 43 whole cycles in one frame. during a wiggle loop
   this was ~1.7 cycles per frame, and the error grows with time
   since page load. integrating dt / period changes only the
   speed when period moves, keeping phase continuous. */
let tailPhase = 0;
let tailLastMs = performance.now();

function driveTail(ps, now) {
  const wiggleIdx = paramIndex.get('ParamTailWiggle');
  const wiggle = wiggleIdx === undefined ? 0 : Math.min(1, Math.abs(ps.values[wiggleIdx]));
  const amp = TAIL_IDLE_AMP + wiggle * TAIL_WAG_AMP;
  const period = TAIL_PERIOD_MS * (1 - 0.55 * wiggle);
  // cap the step or a backgrounded tab comes back and skips half a
  // sway
  tailPhase += Math.min(100, Math.max(0, now - tailLastMs)) / period;
  tailLastMs = now;
  for (let i = 0; i < TAIL_SEGMENTS.length; i++) {
    const id = TAIL_SEGMENTS[i];
    const idx = paramIndex.get(id);
    if (idx === undefined) continue;
    const span = Math.min(Math.abs(paramMax.get(id) ?? 1), Math.abs(paramMin.get(id) ?? 1)) || 1;
    const reach = (i + 1) / TAIL_SEGMENTS.length;
    const phase = tailPhase - i * TAIL_LAG;
    ps.values[idx] = clamp(id, Math.sin(2 * Math.PI * phase) * amp * reach * span);
  }
}

export function tick() {
  if (!raw) return;
  const now = performance.now();
  const dt = Math.max(1, now - lastTickMs);
  lastTickMs = now;

  if (pendingSequences.length) {
    for (let i = pendingSequences.length - 1; i >= 0; i--) {
      if (pendingSequences[i].fire_at_ms <= now) {
        const s = pendingSequences[i];
        targetParams.set(s.param, s.value);
        pendingSequences.splice(i, 1);
      }
    }
  }

  const alpha = 1 - Math.exp(-dt / LERP_TAU_MS);
  let settling = false;
  for (const [id, target] of targetParams) {
    const cur = currentValues.get(id);
    if (cur === undefined) { currentValues.set(id, target); continue; }
    let next = cur + (target - cur) * alpha;
    // snap when it's close. params that turn drawables on and off, like
    // ParamHeadpat, have to ACTUALLY hit 0, not creep at it for Ever.
    if (Math.abs(target - next) < 0.001) next = target;
    else settling = true;
    currentValues.set(id, next);
  }

  const ps = raw.parameters;
  for (const [id, val] of currentValues) {
    const idx = paramIndex.get(id);
    if (idx === undefined) continue;
    ps.values[idx] = val;
  }

  for (const [id, L] of loops) {
    const phase = (now - L.phase_start_ms) / L.period_ms;
    const v = L.base + Math.sin(2 * Math.PI * phase) * L.amplitude;
    const idx = paramIndex.get(id);
    if (idx !== undefined) ps.values[idx] = clamp(id, v);
  }

  driveTail(ps, now);

  if (forcedPartOpacity.size && raw.parts && raw.parts.opacities) {
    for (const [id, op] of forcedPartOpacity) {
      const i = raw.parts.ids.indexOf(id);
      if (i >= 0) raw.parts.opacities[i] = op;
    }
  }

  // skip the smoothing so lipsync stays tight on the audio level
  if (mouthOverride != null) {
    const idx = paramIndex.get('ParamMouthOpen');
    if (idx !== undefined) {
      ps.values[idx] = clamp('ParamMouthOpen', mouthOverride);
      currentValues.set('ParamMouthOpen', mouthOverride);
    }
  }

  if (blinkPhase) {
    const t = now - blinkPhase.startMs;
    const total = blinkPhase.closeMs + blinkPhase.holdMs + blinkPhase.openMs;
    const hi = paramMax.get('ParamEyeOpen');
    const lo = paramMin.get('ParamEyeOpen');
    let v;
    if (t <= 0) {
      v = hi;
    } else if (t < blinkPhase.closeMs) {
      v = hi + (lo - hi) * (t / blinkPhase.closeMs);
    } else if (t < blinkPhase.closeMs + blinkPhase.holdMs) {
      v = lo;
    } else if (t < total) {
      const u = (t - blinkPhase.closeMs - blinkPhase.holdMs) / blinkPhase.openMs;
      v = lo + (hi - lo) * u;
    } else {
      v = hi;
      blinkPhase = null;
    }
    const idx = paramIndex.get('ParamEyeOpen');
    if (idx !== undefined) ps.values[idx] = v;
    currentValues.set('ParamEyeOpen', v);
  }

  animating = settling || loops.size > 0 || blinkPhase !== null
    || pendingSequences.length > 0 || mouthOverride != null || cameraTween !== null;
  app.ticker.maxFPS = animating ? ACTIVE_FPS : IDLE_FPS;
  tickDeltaMs = dt;
}

export function renderIfDirty() {
  if (!raw) return;
  // wasAnimating buys us one more frame. the tick that settles a
  // parameter or ends a blink writes the last value FIRST, then
  // reports idle.
  const draw = animating || wasAnimating || S.needsRender;
  wasAnimating = animating;
  if (!draw) return;
  S.needsRender = false;
  // _render only pushes parameters into the drawables when
  // deltaTime isn't zero, so we have to feed the accumulator on
  // every frame we draw
  model.update(tickDeltaMs);
  app.render();
}
