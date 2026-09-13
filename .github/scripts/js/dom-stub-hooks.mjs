// node loader hooks so stream-filters.js can run outside a
// browser. it imports logging.js and mood.js, and those pull in
// dom.js which does getElementById at import time. swap the two
// for stubs, everything else loads for real. the ?v= query on the
// specifier is fine, node ignores it for file lookup.
export async function resolve(specifier, context, next) {
  if (/\/(logging|mood)\.js(\?|$)/.test(specifier)) {
    return { url: 'stub:' + specifier, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
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
