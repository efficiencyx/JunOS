import * as Live2D from '../live2d/live2d.js?v=84';
import { ITEMS, VARIANTS } from '../outfit/catalog.js?v=2';
import { itemDrawableIds, setItem, setVariant } from '../outfit/apply.js?v=17';
import { state, variantState } from '../outfit/current.js?v=2';
import { isEquipped, mods, setEquipped } from '../mods/engine.js?v=17';
import { itemDrawables } from '../mods/parse.js?v=12';
import { hooks } from '../outfit/hooks.js?v=1';

export const modItemKey = (guid, index) => `mod:${index}:${guid}`;

function modItemByKey(key) {
  const m = /^mod:(\d+):(.+)$/.exec(key);
  const mod = m && mods.find(x => x.guid === m[2]);
  return mod && mod.items[+m[1]] ? { mod, index: +m[1] } : null;
}

function setModItem(key, on) {
  const m = modItemByKey(key);
  if (!m) return false;
  Promise.resolve(setEquipped(m.mod.guid, m.index, on)).then(() => hooks.refresh && hooks.refresh());
  return true;
}

export function wornDrawableMap() {
  const map = new Map();
  // mods go first so a built-in item worn over the same drawable wins the grab
  for (const mod of mods) mod.items.forEach((item, i) => {
    if (!isEquipped(mod, i)) return;
    for (const e of itemDrawables(mod, item)) map.set(e.id, modItemKey(mod.guid, i));
  });
  for (const it of ITEMS) {
    if (!state[it.key]) continue;
    for (const id of itemDrawableIds(it)) map.set(id, it.key);
  }
  if ((variantState.glasses_style || 0) > 0) map.set('ModdableFace', 'glasses_style');
  return map;
}

export function wornLabel(key) {
  const m = modItemByKey(key);
  if (m) return m.mod.items[m.index].label;
  const it = ITEMS.find(x => x.key === key);
  if (it) return it.label;
  const v = VARIANTS.find(x => x.key === key);
  return v ? v.label : key;
}

let lastGlassesIdx = 1;

export function wornRemove(key) {
  if (setModItem(key, false)) return;
  if (key === 'glasses_style') {
    lastGlassesIdx = variantState.glasses_style || 1;
    setVariant(key, 0);
  } else setItem(key, false);
}

export function wornWear(key) {
  if (setModItem(key, true)) return;
  if (key === 'glasses_style') setVariant(key, lastGlassesIdx || 1);
  else setItem(key, true);
}

// small accessories (bow, choker, glasses) are a nightmare to
// grab with an exact mesh test, so the tolerance falls back to
// padded bounding boxes
export function wornHitAt(x, y, worn) {
  return Live2D.drawableAt(x, y, new Set(worn.keys()), 16);
}
