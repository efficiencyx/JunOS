import * as Live2D from '../live2d/live2d.js?v=4';
import { ITEMS, VARIANTS } from '../outfit/catalog.js?v=1';
import { itemDrawableIds, setItem, setVariant } from '../outfit/apply.js?v=3';
import { state, variantState } from '../outfit/current.js?v=1';

export function wornDrawableMap() {
  const map = new Map();
  for (const it of ITEMS) {
    if (!state[it.key]) continue;
    for (const id of itemDrawableIds(it)) map.set(id, it.key);
  }
  if ((variantState.glasses_style || 0) > 0) map.set('ModdableFace', 'glasses_style');
  return map;
}

export function wornLabel(key) {
  const it = ITEMS.find(x => x.key === key);
  if (it) return it.label;
  const v = VARIANTS.find(x => x.key === key);
  return v ? v.label : key;
}

let lastGlassesIdx = 1;

export function wornRemove(key) {
  if (key === 'glasses_style') {
    lastGlassesIdx = variantState.glasses_style || 1;
    setVariant(key, 0);
  } else setItem(key, false);
}

export function wornWear(key) {
  if (key === 'glasses_style') setVariant(key, lastGlassesIdx || 1);
  else setItem(key, true);
}

// small accessories (bow, choker, glasses) are a nightmare to
// grab with an exact mesh test, so the tolerance falls back to
// padded bounding boxes
export function wornHitAt(x, y, worn) {
  return Live2D.drawableAt(x, y, new Set(worn.keys()), 16);
}
