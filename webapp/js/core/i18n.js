export const SUPPORTED = ['de', 'en', 'es', 'fr', 'hi', 'it', 'ja', 'pl', 'pt', 'zh'];

function supported(code) {
  const base = String(code || '').toLowerCase().split('-')[0];
  return SUPPORTED.includes(base) ? base : null;
}

function detect() {
  let pref = null;
  try { pref = localStorage.getItem('ui.lang'); } catch { }
  if (pref && pref !== 'auto' && supported(pref)) return supported(pref);
  const nav = typeof navigator === 'undefined' ? null : navigator;
  for (const l of nav?.languages?.length ? nav.languages : [nav?.language]) {
    const hit = supported(l);
    if (hit) return hit;
  }
  return 'en';
}

export const lang = detect();
// the browser's own regional variant when it matches, so en-GB keeps its 24h clock
export const locale = (typeof navigator === 'undefined' ? [] : navigator.languages || [])
  .find((l) => supported(l) === lang) || lang;

let dict = {};
if (lang !== 'en' && typeof fetch === 'function') {
  try {
    const res = await fetch(new URL('../../i18n/' + lang + '.json', import.meta.url), { cache: 'no-cache' });
    if (res.ok) dict = await res.json();
  } catch { }
}

if (typeof document !== 'undefined') document.documentElement.lang = lang;

export function t(key, fallback, vars) {
  const s = dict[key] ?? fallback;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : s;
}

const ATTRS = { 'data-i18n-placeholder': 'placeholder', 'data-i18n-title': 'title', 'data-i18n-aria-label': 'aria-label' };

function each(root, sel, fn) {
  if (root.matches?.('[' + sel + ']')) fn(root, root.getAttribute(sel));
  for (const el of root.querySelectorAll('[' + sel + ']')) fn(el, el.getAttribute(sel));
}

export function applyI18n(root = document) {
  if (lang === 'en') return;
  each(root, 'data-i18n', (el, k) => { if (k in dict) el.textContent = dict[k]; });
  each(root, 'data-i18n-html', (el, k) => { if (k in dict) el.innerHTML = dict[k]; });
  for (const [sel, attr] of Object.entries(ATTRS)) {
    each(root, sel, (el, k) => { if (k in dict) el.setAttribute(attr, dict[k]); });
  }
}
