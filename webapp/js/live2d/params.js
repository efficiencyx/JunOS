import { currentValues, holds, loops, markDirty, paramDefault, paramIndex, paramMax, paramMin, pendingSequences, raw, targetParams, velocities } from './state.js?v=75';

let onMissingParam = null;
const reportedMissing = new Set();

// a value pushed into the model's own range for that param
export function clampParam(id, v) {
  const lo = paramMin.get(id), hi = paramMax.get(id);
  if (lo === undefined) return v;
  return Math.max(lo, Math.min(hi, v));
}

export function setOnMissingParam(cb) { onMissingParam = cb; }

export function knows(param) { return paramIndex.has(param); }

function reportMissing(param) {
  // no rig loaded (placeholder art), so every param is "missing"
  // and that's not news
  if (!raw) return;
  if (reportedMissing.has(param)) return;
  reportedMissing.add(param);
  if (onMissingParam) onMissingParam(param);
}

function dropPending(param) {
  for (let i = pendingSequences.length - 1; i >= 0; i--) {
    if (pendingSequences[i].param === param) pendingSequences.splice(i, 1);
  }
}

// whoever sets a param last owns it. a half played nod or a
// fidget hold on the same param would otherwise yank it back a
// moment later
export function setTarget(param, value) {
  if (!paramIndex.has(param)) { reportMissing(param); return false; }
  dropPending(param);
  holds.delete(param);
  targetParams.set(param, clampParam(param, value));
  markDirty();
  return true;
}

export function setNow(param, value) {
  if (!setTarget(param, value)) return false;
  currentValues.set(param, clampParam(param, value));
  velocities.set(param, 0);
  return true;
}

export function hold(param, ms) {
  if (paramIndex.has(param)) holds.set(param, performance.now() + ms);
}

export function cancelPending(paramPrefix) {
  for (let i = pendingSequences.length - 1; i >= 0; i--) {
    if (pendingSequences[i].param.startsWith(paramPrefix)) pendingSequences.splice(i, 1);
  }
}

// loops ADD to whatever the param is doing, they don't replace it.
// starting one that's already running keeps its phase and just
// eases to the new size and speed, restarting it at phase 0 is
// what made the breathing hitch every time the mood changed.
export function startLoop(param, amplitude, period_ms) {
  if (!paramIndex.has(param)) { reportMissing(param); return false; }
  const period = Math.max(50, period_ms);
  const L = loops.get(param);
  if (L) {
    L.targetAmp = amplitude;
    L.targetPeriod = period;
    L.releasing = false;
  } else {
    loops.set(param, {
      amplitude, targetAmp: amplitude,
      period_ms: period, targetPeriod: period,
      phase: 0, env: 0, releasing: false,
    });
  }
  markDirty();
  return true;
}

// fades out, anim.js deletes it once the envelope hits 0
export function stopLoop(param) {
  const L = loops.get(param);
  if (L) L.releasing = true;
  markDirty();
}

export function stopAllLoops() {
  loops.clear();
  markDirty();
}

// returns param -> ms until its last step, so callers can hold
// each one exactly as long as the sequence still needs it
export function scheduleSequence(steps) {
  const start = performance.now();
  const last = new Map();
  let t = start;
  for (const step of steps) {
    t += step.dt_ms || 0;
    for (const param of Object.keys(step.params || {})) {
      if (paramIndex.has(param) && !last.has(param)) dropPending(param);
      last.set(param, t - start);
    }
  }
  t = start;
  for (const step of steps) {
    t += step.dt_ms || 0;
    for (const [param, value] of Object.entries(step.params || {})) {
      if (!paramIndex.has(param)) { reportMissing(param); last.delete(param); continue; }
      pendingSequences.push({ param, value: clampParam(param, value), fire_at_ms: t });
    }
  }
  return last;
}

export function debugParam(param) {
  if (!paramIndex.has(param)) return { error: 'unknown param' };
  const idx = paramIndex.get(param);
  return {
    target: targetParams.get(param),
    current: currentValues.get(param),
    live: raw ? raw.parameters.values[idx] : undefined,
    velocity: velocities.get(param),
    heldFor: holds.has(param) ? Math.max(0, holds.get(param) - performance.now()) : 0,
    min: paramMin.get(param), max: paramMax.get(param), def: paramDefault.get(param),
  };
}
