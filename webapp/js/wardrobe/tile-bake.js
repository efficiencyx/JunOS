import * as Live2D from '../live2d/live2d.js?v=4';
import { ITEMS, VARIANTS, VARIANT_OWNER } from '../outfit/catalog.js?v=1';
import { applyChanged, exportPreset, loadPresetState } from '../outfit/presets.js?v=3';
import { itemPatterns } from '../outfit/apply.js?v=3';
import { state, variantState } from '../outfit/current.js?v=1';

// tiles baked by tools/bake-items.html, sitting in the gitignored
// webapp/assets/items/. they're game art, so they never ship.
// whoever ran the extractor bakes their own. no manifest means no
// bake ran here and every tile falls back to the atlas crop
// below.
let bakedTiles = new Set();

export async function loadBakedTiles() {
  try {
    const r = await fetch('assets/items/manifest.json', { credentials: 'same-origin' });
    if (r.ok) bakedTiles = new Set(await r.json());
  } catch (e) {}
}

const bakedTile = (name) => bakedTiles.has(name) ? `assets/items/${name}.png` : null;

// bake actual garment drawables, not atlas wedges. exclude
// glasses, logos and limb styles: they share face/body textures
// and would crop the whole face or body.
function bakeShots() {
  const shots = [];
  const allOff = Object.fromEntries(ITEMS.map(it => [it.key, false]));
  const drawablesOf = (keys) => {
    const ids = new Set();
    for (const key of keys) {
      const it = ITEMS.find(x => x.key === key);
      if (it) for (const id of Live2D.findDrawables(itemPatterns(it), it.colorExcludes)) ids.add(id);
    }
    return ids;
  };
  for (const it of ITEMS) {
    const worn = [it.key, ...(it.requires ? [it.requires] : [])];
    shots.push({
      name: it.key,
      items: { ...allOff, ...Object.fromEntries(worn.map(k => [k, true])) },
      variants: {},
      keep: () => drawablesOf([it.key]),
    });
  }
  for (const key of ['skirt_style', 'sock_style', 'shoe_style']) {
    const v = VARIANTS.find(x => x.key === key);
    const owners = VARIANT_OWNER[key] || [];
    v.options.forEach((opt, i) => {
      shots.push({
        name: `${key}-${i}`,
        items: { ...allOff, ...Object.fromEntries(owners.map(k => [k, true])) },
        variants: { [key]: i },
        keep: () => drawablesOf(owners),
      });
    });
  }
  return shots;
}

// maintainer-only, driven by tools/bake-items.html. moves state
// through loadPresetState/applyChanged rather than setItem, so it
// never PUTs and never waits out writeWardrobe's 500ms spacing.
// 40 shots would otherwise be half a minute of round trips.
export async function bakeAll(onProgress) {
  const restore = exportPreset();
  const shots = bakeShots();
  const out = [];
  try {
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      if (onProgress) onProgress(i, shots.length, shot.name);
      applyChanged(loadPresetState({ items: shot.items, variants: shot.variants }));
      // await applyVariants' atlas work or shots lag one style, giving
      // identical Default/Sneakers tiles.
      await Live2D.texturesSettled();
      await new Promise(r => setTimeout(r, 0));
      const png = Live2D.bakeThumb(shot.keep(), 256);
      if (png) out.push({ name: shot.name, png });
    }
  } finally {
    applyChanged(loadPresetState(restore));
  }
  return out;
}

export function itemThumb(it) {
  const baked = bakedTile(it.key);
  if (baked) return baked;
  const ids = Live2D.findDrawables(itemPatterns(it), it.colorExcludes);
  let best = null, bestPx = 0;
  for (const id of ids) {
    const img = Live2D.drawableThumb(id, 72);
    if (!img) continue;
    // data URL length is a rough proxy for crop detail. good enough
    // tbh.
    const px = img.length;
    if (px > bestPx) { bestPx = px; best = img; }
  }
  return best;
}

export function variantThumb(v, opt) {
  // a baked shot is the whole garment on its own, so it reads fine
  // even when the variant isn't worn. the drawable crop further
  // down only shows anything while the model is actually wearing
  // it.
  const baked = bakedTile(`${v.key}-${v.options.indexOf(opt)}`);
  if (baked) return baked;
  // opt.thumb is the decal png on its own (logos, the two glasses
  // shots), so it reads whether or not she's wearing it.
  // api/assets.php serves those ungated for exactly this.
  if (opt.thumb) return opt.thumb;
  const owners = VARIANT_OWNER[v.key];
  const active = v.options[variantState[v.key] || 0] === opt
    && (!owners || owners.some(key => state[key]));
  if (active) {
    for (const val of Object.values(opt.textures || {})) {
      const url = typeof val === 'object' ? val.url : val;
      if (url) return url;
    }
  }
  return Live2D.drawableThumb(opt.drawable || v.drawables[0], 72);
}
