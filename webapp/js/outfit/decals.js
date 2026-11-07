import * as Live2D from '../live2d/live2d.js?v=90';
import * as Mods from '../mods/mods.js?v=100';
import { bakeDrawable } from '../mods/layers.js?v=18';
import { ITEMS, VARIANTS, VARIANT_OWNER, colorGroup } from './catalog.js?v=4';
import { hexToRgb01 } from './colors.js?v=1';
import { colors, state, variantState } from './current.js?v=4';

const rgbToHex = (rgb) => '#' + rgb.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');

let mapping = null;
const loadMapping = () => mapping ??= fetch('assets/variants/decals/mapping.json', { credentials: 'same-origin' })
  .then(r => (r.ok ? r.json() : {})).catch(() => ({}));

const heldTint = new Map();
let painted = new Set();
let bakes = new Map();
let running = null;
let queued = false;
let sheets = {};
let modKey = '[]';

function activeDecals() {
  const active = ITEMS.filter(it => it.decal && state[it.key]).map(it => ({ decal: it.decal, colorKey: it.key }));
  for (const v of VARIANTS) {
    const opt = v.options[variantState[v.key] || 0];
    if (opt.decal && VARIANT_OWNER[v.key]?.some(k => state[k])) active.push({ decal: opt.decal, replace: true });
  }
  return active;
}

// limb styles own these textures, painting here would wipe them
const limbStyled = (id) => (id.startsWith('AttachArm') && variantState.arm_style > 0)
  || (id.startsWith('AttachLeg') && variantState.leg_style > 0);

function holdTint(id) {
  if (heldTint.has(id)) return heldTint.get(id);
  const rgb = Live2D.getDrawableTint(id);
  const hex = rgb ? rgbToHex(rgb) : null;
  heldTint.set(id, hex);
  Live2D.setDrawableTint(id, null);
  return hex;
}

function releaseTint(id) {
  if (!heldTint.has(id)) return;
  const hex = heldTint.get(id);
  heldTint.delete(id);
  if (hex) Live2D.setDrawableTint(id, hexToRgb01(hex));
}

const colorFor = (e) => (e.colorKey ? colors[e.colorKey] || colorGroup(e.colorKey)?.defaultColor || null : null);

// applyColors just re-tinted her, whatever we held is stale
export function forgetTints() {
  heldTint.clear();
}

function layersByDrawable(sheets) {
  const out = new Map();
  for (const { decal, colorKey, replace } of activeDecals()) {
    for (const l of sheets[decal] || []) {
      if (!out.has(l.drawable)) out.set(l.drawable, []);
      out.get(l.drawable).push({
        url: `assets/variants/decals/${decal}.png`, r: l.rect, layer: l.layer, colorIndex: l.color_index,
        colorKey, replace, bypassColorScaler: true, colorOf: colorFor,
      });
    }
  }
  return out;
}

// sorted, the engine and pass() walk these in different orders and a
// key that never matches rebakes forever
const modKeyOf = (layers) => JSON.stringify([...layers].sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([id, es]) => [id, es.map(e => [e.url, e.layer, colorFor(e)])]));

// the mod engine asks mid-bake. its own tint handling takes over here,
// so ours has to be back on the shader for it to read
function modLayers(owned) {
  const all = layersByDrawable(sheets);
  const out = new Map();
  for (const id of owned.keys()) {
    releaseTint(id);
    painted.delete(id);
    if (all.has(id)) out.set(id, all.get(id));
  }
  modKey = modKeyOf(out);
  return out;
}

async function pass() {
  if (!Live2D.hasModel()) return;
  sheets = await loadMapping();
  // here and not at import, mods and this file import each other
  Mods.setDecalHooks({ layers: modLayers, settled: applyDecals });
  const byDrawable = new Map();
  const owned = new Map();
  for (const [id, entries] of layersByDrawable(sheets)) {
    if (Mods.owns(id)) owned.set(id, entries);
    else if (!Mods.holds(id) && !limbStyled(id)) byDrawable.set(id, entries);
  }
  if (modKeyOf(owned) !== modKey) Mods.applyAll();
  const map = {};
  for (const id of painted) {
    if (byDrawable.has(id) || Mods.owns(id)) continue;
    map[id] = null;
    releaseTint(id);
  }
  const baked = new Map();
  for (const [id, entries] of byDrawable) {
    const replace = entries.some(e => e.replace);
    // one multiply covers the whole drawable, her skin colour would
    // dye the makeup. so it comes off the shader and goes on the art
    const baseTint = replace ? null : holdTint(id);
    const key = JSON.stringify([id, entries.map(e => [e.url, e.r, e.layer, colorFor(e)]), baseTint]);
    try {
      const art = bakes.get(key) || await bakeDrawable(id, entries, colorFor, null, replace);
      baked.set(key, art);
      map[id] = { ...art, key, baseTint };
    } catch (e) {
      console.warn('decal missing, run the asset recovery again', id, e);
    }
  }
  bakes = baked;
  // ALL of it every pass, applyVariants nulls the limb drawables and
  // textures.js skips whatever didn't change anyway
  if (Object.keys(map).length) await Live2D.setDrawableTextures(map);
  painted = new Set(byDrawable.keys());
}

// one at a time, the state only ever gets newer so one queued pass is
// enough. dropping a pass halfway is how makeup never got painted
export function applyDecals() {
  if (running) {
    queued = true;
    return running;
  }
  running = pass().catch(e => console.warn('decals failed', e)).finally(() => {
    running = null;
    if (queued) {
      queued = false;
      applyDecals();
    }
  });
  return running;
}
