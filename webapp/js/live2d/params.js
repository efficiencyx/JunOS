import { currentValues, loops, markDirty, paramDefault, paramIndex, paramMax, paramMin, pendingSequences, raw, targetParams } from './state.js?v=11';

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
  if (reportedMissing.has(param)) return;
  reportedMissing.add(param);
  if (onMissingParam) onMissingParam(param);
}

export function setTarget(param, value) {
  if (!paramIndex.has(param)) { reportMissing(param); return false; }
  targetParams.set(param, clampParam(param, value));
  markDirty();
  return true;
}

export function setNow(param, value) {
  if (!setTarget(param, value)) return false;
  currentValues.set(param, clampParam(param, value));
  return true;
}

export function cancelPending(paramPrefix) {
  for (let i = pendingSequences.length - 1; i >= 0; i--) {
    if (pendingSequences[i].param.startsWith(paramPrefix)) pendingSequences.splice(i, 1);
  }
}

export function startLoop(param, amplitude, period_ms, base) {
  if (!paramIndex.has(param)) { reportMissing(param); return false; }
  if (base === undefined) base = paramDefault.get(param) || 0;
  loops.set(param, {
    amplitude,
    period_ms: Math.max(50, period_ms),
    phase_start_ms: performance.now(),
    base,
  });
  return true;
}

export function stopLoop(param) {
  loops.delete(param);
  markDirty();
}

export function stopAllLoops() {
  loops.clear();
  markDirty();
}

export function scheduleSequence(steps) {
  let t = performance.now();
  for (const step of steps) {
    const dt = step.dt_ms || 0;
    t += dt;
    for (const [param, value] of Object.entries(step.params || {})) {
      if (!paramIndex.has(param)) { reportMissing(param); continue; }
      pendingSequences.push({ param, value: clampParam(param, value), fire_at_ms: t });
    }
  }
}

export function debugParam(param) {
  if (!paramIndex.has(param)) return { error: 'unknown param' };
  const idx = paramIndex.get(param);
  return {
    target: targetParams.get(param),
    current: currentValues.get(param),
    live: raw ? raw.parameters.values[idx] : undefined,
    min: paramMin.get(param), max: paramMax.get(param), def: paramDefault.get(param),
  };
}
