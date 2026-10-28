import { daypart, moodFactors, moodTier } from '../core/mood-tier.js?v=2';
import { cameraTween } from './camera.js?v=78';
import { clampParam, hold, scheduleSequence, startLoop, stopLoop } from './params.js?v=4';
import { S, app, currentValues, forcedPartOpacity, holds, loops, markDirty, model, paramDefault, paramIndex, paramMax, paramMin, pendingSequences, raw, targetParams, velocities } from './state.js?v=75';

const ACTIVE_FPS = 60;
const IDLE_FPS = 30;

let lastTickMs = performance.now();
let animating = false;
let wasAnimating = false;
let tickDeltaMs = 0;

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
  holds.clear();
  for (const id of loops.keys()) {
    if (!STATEFUL_PARAMS.has(id)) stopLoop(id);
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

// what idle wants each param to be when nobody else is using it.
// a param a tag or fidget is holding only gets its baseline
// written down here, it goes there once the hold runs out
const baseTargets = new Map();
const baseLoops = new Map();

function trySet(param, value) {
  if (!paramIndex.has(param)) return;
  const v = clampParam(param, value);
  baseTargets.set(param, v);
  if (!holds.has(param)) targetParams.set(param, v);
}

function tryLoop(param, amplitude, period_ms) {
  if (!paramIndex.has(param)) return;
  baseLoops.set(param, { amplitude, period_ms });
  if (!holds.has(param)) startLoop(param, amplitude, period_ms);
}

function dropLoop(param) {
  baseLoops.delete(param);
  if (!holds.has(param)) stopLoop(param);
}

function releaseExpired(now) {
  for (const [id, until] of holds) {
    if (until > now) continue;
    holds.delete(id);
    targetParams.set(id, baseTargets.has(id) ? baseTargets.get(id) : paramDefault.get(id));
    const b = baseLoops.get(id);
    if (b) startLoop(id, b.amplitude, b.period_ms);
    else if (loops.has(id)) stopLoop(id);
  }
}

// [A:idle], hand everything back to idle on the next tick
export function releaseAll() {
  for (const id of holds.keys()) holds.set(id, 0);
  markDirty();
}

// how long a sequence keeps its params after the last step. the
// spring is still on its way to that last value, let it land
const SEQ_SETTLE_MS = 300;

export function playSequence(steps) {
  for (const [param, ms] of scheduleSequence(steps)) hold(param, ms + SEQ_SETTLE_MS);
}

function pose(params, ms) {
  for (const [p, v] of Object.entries(params)) {
    if (!paramIndex.has(p)) continue;
    targetParams.set(p, clampParam(p, v));
    hold(p, ms);
  }
  markDirty();
}

function applyMoodBaseline() {
  const { warmth, fear } = moodFactors(mood);
  const hour = DAYPART_BASELINE[daypart()];
  const drowsy = 1 - Math.min(1, fear / 0.4);

  trySet('ParamMouthForm', warmth > 0 ? warmth * 0.6 : warmth * 0.4);
  const brow = warmth * 0.4 - fear * 0.6;
  trySet('ParamBrowLEmote', brow);
  trySet('ParamBrowREmote', brow);
  trySet('ParamBrowLRot', fear * 9);
  trySet('ParamBrowRRot', -fear * 9);
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
  // this rig's ParamEyeOpen is -1 shut to 0 open. NOT the stock
  // 0..1, write 1 and it clamps to "open" and nothing happens
  const eyeOpen = fear <= 0.3 && warmth < -0.4 ? -0.2 : 0;
  trySet('ParamEyeOpen', eyeOpen + hour.eyeOpen * drowsy);

  if (fear > 0.4) {
    tryLoop('ParamHeadZ', 0.01 + 0.02 * fear, 220);
    tryLoop('ParamHeadX', 0.01 + 0.02 * fear, 120);
    tryLoop('ParamBodyX', 0.01 + 0.01 * fear, 200);
    tryLoop('ParamBodyY', 0.05, 1600);
  } else {
    dropLoop('ParamHeadZ');
    dropLoop('ParamHeadX');
    dropLoop('ParamBodyX');
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

function triggerBlink() {
  if (!paramIndex.has('ParamEyeOpen')) return;
  // a yawn or a doze keeps the eyes shut the Whole time. a blink
  // underneath would pop them open right in the middle of it.
  if (pendingSequences.some(s => s.param === 'ParamEyeOpen')) return;
  const lo = paramMin.get('ParamEyeOpen'), hi = paramMax.get('ParamEyeOpen');
  const open = ((currentValues.get('ParamEyeOpen') ?? hi) - lo) / ((hi - lo) || 1);
  if (open < 0.3) return;
  blinkPhase = { startMs: performance.now(), closeMs: 75, holdMs: 40, openMs: 150 };
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

// weight is relative, default 1, and a moods:/parts: entry counts
// double. ArmL/RUp is NOT a small arm move on this rig, 0.25 swings
// the whole arm out sideways at hip height and reads as the start
// of a wave. so arms only go up in the wave itself, and that one
// is weighted to maybe once every quarter hour of happy idle
const FIDGETS = [
  { kind: 'loop', param: 'ParamTailWiggle', amp: 0.5, period: 900, duration: 2700 },
  { kind: 'tail_side', param: 'Param_Angle_Rotation_1_TailMain', weight: 0.7 },
  { kind: 'loop', param: 'ParamEarsWiggle', amp: 0.4, period: 700, duration: 1400, moods: ['neutral', 'happy', 'nervous'] },
  { kind: 'pose', param: 'ParamEarL', value: -0.7, hold: 260 },
  { kind: 'pose', param: 'ParamEarR', value: -0.7, hold: 260 },
  { kind: 'glance', param: 'ParamEyeballLX', weight: 1.5 },
  { kind: 'pose', param: 'ParamLegL', value: 0.35, hold: 2600, weight: 0.7 },
  { kind: 'pose', param: 'ParamLegR', value: 0.35, hold: 2600, weight: 0.7 },
  { kind: 'pose', param: 'ParamLegL', value: -0.25, hold: 2200, weight: 0.5 },
  { kind: 'pose', param: 'ParamLegR', value: -0.25, hold: 2200, weight: 0.5 },
  { kind: 'pose', param: 'ParamArmLRot', value: 0.4, hold: 1800, weight: 0.5 },
  { kind: 'pose', param: 'ParamArmRRot', value: -0.4, hold: 1800, weight: 0.5 },
  { kind: 'seq', param: 'ParamBodyY', weight: 0.5, steps: [
    { params: { ParamBodyY: 0.45, ParamEyeOpen: -0.15 }, dt_ms: 0 },
    { params: { ParamBodyY: 0.5 }, dt_ms: 700 },
    { params: { ParamBodyY: -0.15, ParamEyeOpen: 0 }, dt_ms: 900 },
    { params: { ParamBodyY: 0 }, dt_ms: 600 },
  ] },

  { moods: ['happy'], kind: 'seq', param: 'ParamArmRUp', weight: 0.03, steps: [
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
    { params: { ParamHeadZ: -0.3 }, dt_ms: 0 },
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
    { params: { ParamMouthOpen: 0.35, ParamEyeOpen: -0.5 }, dt_ms: 0 },
    { params: { ParamMouthOpen: 1, ParamEyeOpen: -1, ParamBrowLY: 0.4, ParamBrowRY: 0.4 }, dt_ms: 500 },
    { params: { ParamMouthOpen: 0.8, ParamEyeOpen: -1 }, dt_ms: 900 },
    { params: { ParamMouthOpen: 0, ParamEyeOpen: 0, ParamBrowLY: 0, ParamBrowRY: 0 }, dt_ms: 700 },
  ] },
  { parts: ['night'], kind: 'seq', param: 'ParamEyeOpen', steps: [
    { params: { ParamEyeOpen: -0.85 }, dt_ms: 0 },
    { params: { ParamEyeOpen: -0.85 }, dt_ms: 2600 },
    { params: { ParamEyeOpen: 0 }, dt_ms: 500 },
  ] },
  { parts: ['night'], kind: 'seq', param: 'ParamHeadY', steps: [
    { params: { ParamHeadY: -0.5, ParamEyeOpen: -0.8 }, dt_ms: 0 },
    { params: { ParamHeadY: -0.55, ParamEyeOpen: -0.9 }, dt_ms: 2200 },
    { params: { ParamHeadY: 0, ParamEyeOpen: 0 }, dt_ms: 600 },
  ] },
  { parts: ['morning'], kind: 'seq', param: 'ParamArmLUp', steps: [
    { params: { ParamArmLUp: 1, ParamArmRUp: 1, ParamBodyY: 0.3, ParamEyeOpen: -0.8 }, dt_ms: 0 },
    { params: { ParamArmLUp: 1, ParamArmRUp: 1, ParamBodyY: 0.35, ParamMouthOpen: 0.4 }, dt_ms: 1100 },
    { params: { ParamArmLUp: 0, ParamArmRUp: 0, ParamBodyY: 0, ParamMouthOpen: 0, ParamEyeOpen: 0 }, dt_ms: 800 },
  ] },
  { parts: ['evening'], kind: 'loop', param: 'ParamTailWiggle', amp: 0.7, period: 750, duration: 3000 },
  { parts: ['day'], kind: 'glance', param: 'ParamEyeballLX', far: true },
];

const FIDGET_DELAYS = {
  happy:   [1400, 3500],
  scared:  [1500, 3500],
  nervous: [1600, 4000],
  upset:   [2500, 6000],
  neutral: [1800, 4500],
};

const GLANCE_PARAMS = ['ParamEyeballLX', 'ParamEyeballRX', 'ParamEyeballLY', 'ParamEyeballRY', 'ParamHeadX', 'ParamHeadY'];

function fidgetParams(f) {
  if (!f.touches) {
    const ids = new Set([f.param]);
    if (f.pair) ids.add(f.pair);
    for (const p of Object.keys(f.pairValue || {})) ids.add(p);
    for (const s of f.steps || []) for (const p of Object.keys(s.params)) ids.add(p);
    if (f.kind === 'glance') for (const p of GLANCE_PARAMS) ids.add(p);
    f.touches = [...ids];
  }
  return f.touches;
}

// eyes jump, head follows late and only part of the way. that's a
// saccade (the quick eye jump people do all day), and the eyeball
// spring being ~2x faster than the head's is what sells it. the
// old sine loop slid the eyes back and forth like a cctv camera.
function glance(far) {
  const reach = far ? 0.85 : 0.6;
  const x = (Math.random() * 2 - 1) * reach;
  const y = (Math.random() * 2 - 1) * reach * 0.45;
  pose({
    ParamEyeballLX: x, ParamEyeballRX: x, ParamEyeballLY: y, ParamEyeballRY: y,
    ParamHeadX: x * 0.2, ParamHeadY: y * 0.25,
  }, 700 + Math.random() * 1300);
}

function runFidget(f) {
  if (f.kind === 'seq') { playSequence(f.steps); return; }
  if (f.kind === 'glance') { glance(f.far); return; }
  if (f.kind === 'tail_side') { tailSideGoal = -tailSideGoal; return; }
  if (f.kind === 'pose') { pose({ [f.param]: f.value, ...f.pairValue }, f.hold); return; }
  startLoop(f.param, f.amp, f.period);
  hold(f.param, f.duration);
  if (f.pair && paramIndex.has(f.pair)) {
    startLoop(f.pair, f.amp, f.period);
    hold(f.pair, f.duration);
  }
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
    let total = 0;
    for (const f of FIDGETS) {
      if (!paramIndex.has(f.param)) continue;
      // a tag is still using one of these, so don't fight it
      if (fidgetParams(f).some(p => holds.has(p))) continue;
      if (f.moods && !f.moods.includes(tier)) continue;
      if (f.parts && !f.parts.includes(now)) continue;
      const w = (f.weight ?? 1) * (f.moods || f.parts ? 2 : 1);
      candidates.push([f, w]);
      total += w;
    }
    let r = Math.random() * total;
    for (const [f, w] of candidates) {
      r -= w;
      if (r <= 0) { runFidget(f); break; }
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
  scheduleWander();
}

export function stopIdle() {
  idleActive = false;
  if (blinkTimeout) { clearTimeout(blinkTimeout); blinkTimeout = null; }
  if (fidgetTimeout) { clearTimeout(fidgetTimeout); fidgetTimeout = null; }
  if (wanderTimeout) { clearTimeout(wanderTimeout); wanderTimeout = null; }
}

// ParamTailWiggle, ParamHairPhysicsBaseToShort and
// ParamPhysicsBoobXL need the missing physics3.json (the rig's
// physics sim file). so drive the nine tail rotation params
// root-to-tip with a delayed sine ourselves, or [A:tail_wag] and
// fidgets never actually move it.
const TAIL_SEGMENTS = Array.from({ length: 9 }, (_, i) => `Param_Angle_Rotation_${i + 1}_TailMain`);
// fractions of each segment's own range, because these are angle
// params and their range is whatever the rigger picked. 0.18 is a
// resting sway, the wiggle on top is what the fidgets and
// [A:tail_wag] actually buy you.
const TAIL_IDLE_AMP = 0.18;
const TAIL_WAG_AMP = 0.7;
const TAIL_PERIOD_MS = 5200;
// how far behind the segment above each one runs, in periods
const TAIL_LAG = 0.1;
// phase has to ACCUMULATE. now / period jumps when wiggle
// changes period. dropping 2800 -> 1260 at now = 100000 moves
// phase by 43 whole cycles in one frame. during a wiggle loop
// that was ~1.7 cycles per frame, and the error grows with time
// since page load. integrating dt / period only changes the
// speed when period moves, so phase stays continuous.
let tailPhase = 0;
let tailLastMs = performance.now();
// straight (all zeros) the tail stands up right behind her torso
// and you never see it. this curve, degrees root to tip, swings
// the root out and curls the tip back up, so it comes out past
// her shoulder. picked off renders of the rig, positive is
// screen-left. tailSide mirrors it, the tail_side fidget flips
// it and it eases across (passing behind her on the way, which
// is just a tail swish)
const TAIL_REST = [18, 12, 6, 0, -6, -8, -8, -6, -4];
const TAIL_SIDE_MS = 700;
let tailSide = 1;
let tailSideGoal = 1;

// ParamTailWiggle is usually a loop, so |value| is a rectified
// sine. feeding that straight into amp pumped the wag twice per
// loop period with a corner at every zero crossing, the tip bounced
// -10 to -33 degrees ~2x a second. so follow its envelope instead,
// up fast, down slow
let wagLevel = 0;

function driveTail(ps, now) {
  // cap the step or a backgrounded tab comes back and skips half a
  // sway
  const step = Math.min(100, Math.max(0, now - tailLastMs));
  const wiggleIdx = paramIndex.get('ParamTailWiggle');
  const wiggle = wiggleIdx === undefined ? 0 : Math.min(1, Math.abs(ps.values[wiggleIdx]));
  wagLevel += (wiggle - wagLevel) * (1 - Math.exp(-step / (wiggle > wagLevel ? 80 : 900)));
  const amp = TAIL_IDLE_AMP + wagLevel * TAIL_WAG_AMP;
  const period = TAIL_PERIOD_MS * (1 - 0.55 * wagLevel);
  tailPhase += step / period;
  tailSide += (tailSideGoal - tailSide) * (1 - Math.exp(-step / TAIL_SIDE_MS));
  tailLastMs = now;
  for (let i = 0; i < TAIL_SEGMENTS.length; i++) {
    const id = TAIL_SEGMENTS[i];
    const idx = paramIndex.get(id);
    if (idx === undefined) continue;
    const span = Math.min(Math.abs(paramMax.get(id) ?? 1), Math.abs(paramMin.get(id) ?? 1)) || 1;
    const reach = (i + 1) / TAIL_SEGMENTS.length;
    const phase = tailPhase - i * TAIL_LAG;
    ps.values[idx] = clampParam(id, TAIL_REST[i] * tailSide + Math.sin(2 * Math.PI * phase) * amp * reach * span);
  }
}

// same missing physics3.json story for the hair. the three
// ParamHairPhysics* params are sway OUTPUTS (base to tip, -1..1,
// +1 swings right) and nothing wrote them, so a head roll swung
// the ponytail round the neck like a plank. the tip went the
// opposite way to the knot.
// a spring chain fixes it. segment 0 chases HAIR_HANG * sway (head
// roll + a bit of turn + body lean), each one after chases the one
// above it, softer, so the tip
// trails. 0.5 makes the ponytail tip hang right under the knot,
// measured off the moc in node, source: trust me bro.
// stiffness/damping give one overshoot and it's still in ~1.8s.
const HAIR_CHAIN = [
  { id: 'ParamHairPhysicsBaseToShort', k: 110, zeta: 0.45 },
  { id: 'ParamHairPhysicsShortToMid', k: 75, zeta: 0.4 },
  { id: 'ParamHairPhysicsMidToLong', k: 50, zeta: 0.35 },
];
const HAIR_HANG = 0.5;
// the hang alone only follows the head, a little late. real hair
// gets left behind when the head moves, then swings past. so
// segment 0 also gets pushed against the head's speed (roll plus
// turn, per second). 0.3 gives a visible swing on a wander shift
// and nothing silly on a nod
const HAIR_FLICK = 0.3;
const HAIR_STEP_S = 1 / 120;
const hairPos = [0, 0, 0];
const hairVel = [0, 0, 0];
let hairMoving = false;
let lastHeadMove = null;

function liveValue(ps, id) {
  const idx = paramIndex.get(id);
  return idx === undefined ? 0 : ps.values[idx];
}

function driveHair(ps, dtMs) {
  const sway = liveValue(ps, 'ParamHeadZ') + 0.3 * liveValue(ps, 'ParamHeadX')
    + liveValue(ps, 'ParamBodyZ');
  const headMove = liveValue(ps, 'ParamHeadZ') + liveValue(ps, 'ParamHeadX');
  const dtS = Math.min(100, dtMs) / 1000;
  const headSpeed = lastHeadMove === null ? 0 : Math.max(-3, Math.min(3, (headMove - lastHeadMove) / dtS));
  lastHeadMove = headMove;
  const anchor = HAIR_HANG * sway - HAIR_FLICK * headSpeed;
  // fixed substeps, a 33ms frame at 30fps idle blows up a k=110
  // spring with plain euler
  const steps = Math.ceil(dtS / HAIR_STEP_S);
  for (let n = 0; n < steps; n++) {
    for (let i = 0; i < HAIR_CHAIN.length; i++) {
      const { k, zeta } = HAIR_CHAIN[i];
      const goal = i ? hairPos[i - 1] : anchor;
      hairVel[i] += (k * (goal - hairPos[i]) - 2 * zeta * Math.sqrt(k) * hairVel[i]) * HAIR_STEP_S;
      hairPos[i] += hairVel[i] * HAIR_STEP_S;
    }
  }
  hairMoving = false;
  for (let i = 0; i < HAIR_CHAIN.length; i++) {
    const idx = paramIndex.get(HAIR_CHAIN[i].id);
    if (idx !== undefined) ps.values[idx] = clampParam(HAIR_CHAIN[i].id, hairPos[i]);
    const goal = i ? hairPos[i - 1] : anchor;
    if (Math.abs(hairVel[i]) > 0.005 || Math.abs(goal - hairPos[i]) > 0.002) hairMoving = true;
  }
}

// spring time per param, roughly how long it takes to get there.
// a critically damped spring and not the old exponential lerp:
// the lerp left at full speed the instant a target changed, which
// is the robotic snap on every tag. this one eases out AND in, and
// a target that moves mid-flight keeps the speed it already had
// instead of kinking. eyeballs fastest (saccades), body slowest.
const SMOOTH_S = [
  [/^ParamEyeball/, 0.07],
  [/^Param(Eye|Brow|Mouth|Iris|Blush|Heart|Pupil)/, 0.1],
  [/^ParamHead[XYZ]$/, 0.16],
  [/^ParamBody[XYZ]$/, 0.24],
  [/^Param(Arm|Leg)/, 0.2],
];
const DEFAULT_SMOOTH_S = 0.12;
const smoothCache = new Map();

function smoothTime(id) {
  let t = smoothCache.get(id);
  if (t === undefined) {
    const hit = SMOOTH_S.find(([re]) => re.test(id));
    t = hit ? hit[1] : DEFAULT_SMOOTH_S;
    smoothCache.set(id, t);
  }
  return t;
}

const LOOP_FADE_IN_MS = 450;
const LOOP_FADE_OUT_MS = 600;
const LOOP_EASE_MS = 400;

// never quite still. two sines per param at periods that don't
// line up, so the sway doesn't visibly repeat for minutes. fractions
// of -1..1, HeadZ 0.05 is ~1 degree of roll. idle only, and it
// fades out when fidgets are off so scripted scenes stay put.
// head ONLY. ParamBodyZ on this rig slides the whole body, 0.04
// already moves her ~6px side to side and 1 throws her off screen,
// so a drift on it reads as her rocking left and right. BodyX
// barely moves anything at this size. measured, don't add them back
const DRIFT = [
  { id: 'ParamHeadX', amp: 0.07, a: 7100, b: 12900, off: 0 },
  { id: 'ParamHeadY', amp: 0.05, a: 5300, b: 9700, off: 1.7 },
  { id: 'ParamHeadZ', amp: 0.05, a: 6300, b: 15100, off: 3.1 },
];
const DRIFT_FADE_MS = 1200;
let driftMs = 0;
let driftEnv = 0;

function driveDrift(ps, dtMs) {
  const goal = idleActive && fidgetsEnabled ? 1 : 0;
  const step = dtMs / DRIFT_FADE_MS;
  driftEnv = goal > driftEnv ? Math.min(goal, driftEnv + step) : Math.max(goal, driftEnv - step);
  if (driftEnv === 0) return;
  driftMs += dtMs;
  const env = driftEnv * driftEnv * (3 - 2 * driftEnv);
  for (const d of DRIFT) {
    const idx = paramIndex.get(d.id);
    if (idx === undefined) continue;
    const w = 0.65 * Math.sin(2 * Math.PI * driftMs / d.a + d.off) + 0.35 * Math.sin(2 * Math.PI * driftMs / d.b);
    ps.values[idx] = clampParam(d.id, ps.values[idx] + w * d.amp * env);
  }
}

// where she holds her head between fidgets. every few seconds it
// picks a new resting angle and springs there, slower than any tag
// (0.45s). that's what a person does, settle, hold, shift. the old
// fidgets swept HeadX through one full sine and back to dead center,
// which is exactly what a robot does. the eyes jump first and come
// back to center while the head catches up, and the turn takes a bit
// of roll with it, so the hair gets something to swing on.
// additive like the drift, and a head param a tag holds only gets a
// third of it, so a [A:look|away] still reads as a look away
const WANDER_SMOOTH_S = 0.45;
const WANDER_AXES = [
  { id: 'ParamHeadX', key: 'x' },
  { id: 'ParamHeadY', key: 'y' },
  { id: 'ParamHeadZ', key: 'z' },
];
const wanderGoal = { x: 0, y: 0, z: 0 };
const wanderPos = { x: 0, y: 0, z: 0 };
const wanderVel = { x: 0, y: 0, z: 0 };
let wanderTimeout = null;
let wanderMoving = false;

function rand(lo, hi) { return lo + Math.random() * (hi - lo); }

function pickWander() {
  const home = Math.random() < 0.3;
  const x = home ? rand(-0.06, 0.06) : rand(-0.32, 0.32);
  const y = home ? rand(-0.03, 0.03) : rand(-0.16, 0.1);
  wanderGoal.x = x;
  wanderGoal.y = y;
  wanderGoal.z = -x * 0.3 + rand(-0.09, 0.09);
  const eyes = ['ParamEyeballLX', 'ParamEyeballRX', 'ParamEyeballLY', 'ParamEyeballRY'];
  if (!home && !eyes.some(p => holds.has(p))) {
    pose({
      ParamEyeballLX: x * 1.8, ParamEyeballRX: x * 1.8,
      ParamEyeballLY: y * 1.8, ParamEyeballRY: y * 1.8,
    }, 380);
  }
}

function scheduleWander() {
  if (wanderTimeout) clearTimeout(wanderTimeout);
  const delay = rand(2500, 7000) * (DAYPART_PACE[daypart()] || 1);
  wanderTimeout = setTimeout(() => {
    if (!idleActive) return;
    if (fidgetsEnabled) pickWander();
    scheduleWander();
  }, delay);
}

function driveWander(ps, dtS) {
  const on = idleActive && fidgetsEnabled;
  const omega = 2 / WANDER_SMOOTH_S;
  const x = omega * dtS;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  wanderMoving = false;
  for (const { id, key } of WANDER_AXES) {
    const goal = on ? wanderGoal[key] * (holds.has(id) ? 0.33 : 1) : 0;
    const change = wanderPos[key] - goal;
    const temp = (wanderVel[key] + omega * change) * dtS;
    wanderVel[key] = (wanderVel[key] - omega * temp) * decay;
    wanderPos[key] = goal + (change + temp) * decay;
    if (Math.abs(wanderVel[key]) > 1e-4 || Math.abs(goal - wanderPos[key]) > 1e-4) wanderMoving = true;
    const idx = paramIndex.get(id);
    if (idx !== undefined) ps.values[idx] = clampParam(id, ps.values[idx] + wanderPos[key]);
  }
}

function driveLoops(ps, dtMs) {
  const ease = 1 - Math.exp(-dtMs / LOOP_EASE_MS);
  for (const [id, L] of loops) {
    L.amplitude += (L.targetAmp - L.amplitude) * ease;
    L.period_ms += (L.targetPeriod - L.period_ms) * ease;
    L.phase += dtMs / L.period_ms;
    L.phase -= Math.floor(L.phase);
    L.env = L.releasing
      ? Math.max(0, L.env - dtMs / LOOP_FADE_OUT_MS)
      : Math.min(1, L.env + dtMs / LOOP_FADE_IN_MS);
    if (L.releasing && L.env === 0) { loops.delete(id); continue; }
    const idx = paramIndex.get(id);
    if (idx === undefined) continue;
    const env = L.env * L.env * (3 - 2 * L.env);
    ps.values[idx] = clampParam(id, ps.values[idx] + Math.sin(2 * Math.PI * L.phase) * L.amplitude * env);
  }
}

export function tick() {
  if (!raw) return;
  const now = performance.now();
  const dt = Math.max(1, now - lastTickMs);
  lastTickMs = now;
  // a backgrounded tab comes back with a dt of minutes. step 100ms
  // and move on, nobody needs to see the catch-up
  const dtMs = Math.min(100, dt);
  const dtS = dtMs / 1000;

  if (pendingSequences.length) {
    for (let i = pendingSequences.length - 1; i >= 0; i--) {
      if (pendingSequences[i].fire_at_ms <= now) {
        const s = pendingSequences[i];
        targetParams.set(s.param, s.value);
        pendingSequences.splice(i, 1);
      }
    }
  }
  if (holds.size) releaseExpired(now);

  let settling = false;
  for (const [id, target] of targetParams) {
    const cur = currentValues.get(id);
    if (cur === undefined) { currentValues.set(id, target); continue; }
    const v0 = velocities.get(id) || 0;
    if (cur === target && v0 === 0) continue;
    // closed form critically damped spring (Game Programming Gems 4,
    // same thing as unity's SmoothDamp). stable at any dt, plain
    // euler on a spring this stiff blows up at 30fps
    const omega = 2 / smoothTime(id);
    const x = omega * dtS;
    const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = cur - target;
    const temp = (v0 + omega * change) * dtS;
    let vel = (v0 - omega * temp) * decay;
    let next = target + (change + temp) * decay;
    // snap when it's close. params that turn drawables (single
    // meshes of the rig) on and off, like ParamHeadpat, have to
    // actually land on the target, not creep at it for Ever.
    if (Math.abs(target - next) < 0.001 && Math.abs(vel) < 0.01) { next = target; vel = 0; }
    else settling = true;
    currentValues.set(id, next);
    velocities.set(id, vel);
  }

  const ps = raw.parameters;
  for (const [id, val] of currentValues) {
    const idx = paramIndex.get(id);
    if (idx === undefined) continue;
    ps.values[idx] = clampParam(id, val);
  }

  driveLoops(ps, dtMs);
  driveDrift(ps, dtMs);
  driveWander(ps, dtS);
  driveTail(ps, now);
  driveHair(ps, dt);

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
      ps.values[idx] = clampParam('ParamMouthOpen', mouthOverride);
      currentValues.set('ParamMouthOpen', mouthOverride);
      velocities.set('ParamMouthOpen', 0);
    }
  }

  // blinks pull the lid toward shut from wherever it IS, so a
  // sleepy or squinting face blinks and comes back sleepy. the old
  // one went to fully open and then sagged back. fast close, slower
  // open, eased both ways.
  if (blinkPhase) {
    const t = now - blinkPhase.startMs;
    const { closeMs, holdMs, openMs } = blinkPhase;
    let shut;
    if (t < closeMs) { const u = Math.max(0, t) / closeMs; shut = u * u; }
    else if (t < closeMs + holdMs) shut = 1;
    else if (t < closeMs + holdMs + openMs) { const u = 1 - (t - closeMs - holdMs) / openMs; shut = u * u; }
    else { shut = 0; blinkPhase = null; }
    const idx = paramIndex.get('ParamEyeOpen');
    if (idx !== undefined) ps.values[idx] += (paramMin.get('ParamEyeOpen') - ps.values[idx]) * shut;
  }

  animating = settling || loops.size > 0 || blinkPhase !== null
    || pendingSequences.length > 0 || mouthOverride != null || cameraTween !== null
    || hairMoving || driftEnv > 0 || wanderMoving;
  app.ticker.maxFPS = animating ? ACTIVE_FPS : IDLE_FPS;
  tickDeltaMs = dt;
}

export function renderIfDirty() {
  if (!raw) return;
  // wasAnimating buys us one more frame. the tick that settles a
  // parameter or ends a blink writes the last value first, then
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
