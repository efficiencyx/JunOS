// node loader hooks so stream-filters.js can run outside a
// browser. it imports logging.js and mood.js, and those pull in
// dom.js which does getElementById at import time. swap the two
// for stubs. the Live2D renderer gets an empty stub for the same
// reason, and actions.js loads for real (parseActions is under
// test) behind a wrapper whose applyAction records the action
// instead of driving a rig that isn't there. outfit.js gets a
// stub too, actions.js imports it and its graph wants a whole
// page. the ?v= query on the specifier is fine, node ignores it
// for file lookup.
export async function resolve(specifier, context, next) {
  if (/\/(logging|mood)\.js(\?|$)/.test(specifier)) {
    return { url: 'stub:' + specifier, shortCircuit: true };
  }
  if (/\/live2d\.js(\?|$)/.test(specifier)) {
    return { url: 'stub:live2d', shortCircuit: true };
  }
  if (/\/outfit\.js(\?|$)/.test(specifier)) {
    return { url: 'stub:outfit', shortCircuit: true };
  }
  if (/\/actions\.js(\?|$)/.test(specifier) && !specifier.includes('real=1')) {
    const real = await next(specifier + (specifier.includes('?') ? '&' : '?') + 'real=1', context);
    return { url: 'stub:actions?' + encodeURIComponent(real.url), shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url === 'stub:live2d') {
    return { format: 'module', shortCircuit: true, source: 'export {};' };
  }
  if (url === 'stub:outfit') {
    return { format: 'module', shortCircuit: true, source: 'export function wearLook() {} export function syncFromAction() {}' };
  }
  if (url.startsWith('stub:actions?')) {
    const real = decodeURIComponent(url.slice('stub:actions?'.length));
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        export * from ${JSON.stringify(real)};
        export function applyAction(a) { globalThis.__applied.push(a); }
      `,
    };
  }
  if (url.startsWith('stub:')) {
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        export function logAction(level, text) { globalThis.__log.push([level, text]); }
        export function noteEmotionTint() {}
      `,
    };
  }
  return next(url, context);
}
