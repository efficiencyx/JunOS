// rooms live in scene/*.svg and they get INLINED, not dropped in
// an <img>. an <img> svg is its own document. it can't see
// --sky-zenith, --key-warm or any other page custom property, so
// the window would never know what time it is. inlined markup
// also works with the page's css and with getElementById, which
// the date page's plates need.
const pending = new Map();

function load(url) {
  if (!pending.has(url)) {
    pending.set(url, fetch(url).then(r => {
      if (!r.ok) throw new Error(url + ' ' + r.status);
      return r.text();
    }));
  }
  return pending.get(url);
}

// props live in their own files so one can be redrawn without
// touching the room. the room leaves <g data-prop="rail"> slots
// and we drop scene/props/rail.svg inside each one. the slot owns
// the transform, the prop file owns nothing but its own local
// box. that's what makes a prop a drop-in replacement.
async function fillProps(root, dir) {
  const slots = [...root.querySelectorAll('[data-prop]')];
  await Promise.all(slots.map(async (slot) => {
    try {
      const markup = await load(dir + '/' + slot.dataset.prop + '.svg');
      const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
      const src = doc.querySelector('svg');
      if (!src || doc.querySelector('parsererror')) return;
      // defs have to move to the host document or the fills in
      // them resolve against nothing
      for (const node of [...src.childNodes]) slot.appendChild(document.importNode(node, true));
    } catch (e) {
      console.warn('prop', slot.dataset.prop, e);
    }
  }));
}

// a room that fails to load must not take the page with it. you
// can still shop, eat and sing in an empty one.
export async function inject(host, url) {
  const el = typeof host === 'string' ? document.querySelector(host) : host;
  if (!el) return null;
  try {
    el.innerHTML = await load(url);
  } catch (e) {
    console.warn('scene', e);
    return null;
  }
  const svg = el.querySelector('svg');
  if (!svg) return null;
  svg.setAttribute('aria-hidden', 'true');
  await fillProps(svg, url.replace(/\/[^/]+$/, '') + '/props');
  return svg;
}
