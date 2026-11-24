import * as Live2D from '../live2d/live2d.js?v=93';
import * as Mods from '../mods/mods.js?v=120';
import { ALWAYS_HIDDEN, COLOR_GROUPS, ITEMS, VARIANTS, VARIANT_OWNER } from './catalog.js?v=7';
import { applyGlassesTexture, applyStockingTexture, cancelStockingTexture, stockingColorMode } from './composite.js?v=49';
import { colors, state, variantState } from './current.js?v=8';
import { hexToRgb01, normalizeHex } from './colors.js?v=1';
import { queueWardrobe, saveColors, textureAvailable } from './sync.js?v=49';
import { snapshot } from './chat-tools.js?v=49';
import { hooks } from './hooks.js?v=1';
import { applyDecals, forgetTints } from './decals.js?v=26';

export const itemPatterns = (it) => it.colorPatterns || it.visibilityPatterns || [];

export const itemDrawableIds = (it) =>
  Live2D.findDrawables(itemPatterns(it), it.colorExcludes);

const moddedItems = new Set();
let moddedOwned = new Set();
const modHidden = new Map();

export function setModdedDrawables(drawables) {
  const owned = drawables instanceof Set ? drawables : new Set(drawables || []);
  moddedOwned = owned;
  const next = new Set();
  const controlled = new Set();
  for (const it of ITEMS) {
    if (!it.param || it.visibilityPatterns) continue;
    const ids = itemDrawableIds(it);
    if (!ids.some(id => owned.has(id))) continue;
    next.add(it.key);
    for (const id of ids) controlled.add(id);
  }
  const changed = new Set([...moddedItems, ...next].filter(key => moddedItems.has(key) !== next.has(key)));
  moddedItems.clear();
  for (const key of next) moddedItems.add(key);
  if (changed.size) applyItems(changed);
  const worn = onceWorn();
  for (const it of ITEMS) if (next.has(it.key) && !changed.has(it.key)) hideUnpainted(it, !isOn(it), worn);
  return controlled;
}

const isOn = (it) => state[it.key] && (!it.requires || state[it.requires]);

// worked out at most once per pass, every modded garment asks
function onceWorn() {
  let worn = null;
  return () => (worn ??= new Set(ITEMS.filter(isOn).flatMap(it => Live2D.findDrawables(itemPatterns(it), []))));
}

// the param shows the whole garment, strings and logo included. worn
// only for a mod, what it doesn't paint is art the game wouldn't show
function hideUnpainted(it, modOnly, worn) {
  const down = modOnly
    ? Live2D.findDrawables(itemPatterns(it), []).filter(id => !moddedOwned.has(id) && !worn().has(id))
    : [];
  for (const id of modHidden.get(it.key) || []) if (!down.includes(id)) Live2D.setDrawableOpacity(id, null);
  for (const id of down) Live2D.setDrawableOpacity(id, 0);
  modHidden.set(it.key, down);
}

// mods/engine.js wakes hidden vanilla drawables, such as Skirt, and
// clears their vanilla art before painting. track what the
// wardrobe hid so mods can do that.
export function hiddenItemDrawables() {
  const hidden = new Set(), worn = new Set();
  for (const it of ITEMS) {
    for (const id of itemDrawableIds(it)) (isOn(it) ? worn : hidden).add(id);
  }
  // patterns overlap ('dress' matches Dress1 too), and worn wins
  for (const id of worn) hidden.delete(id);
  return hidden;
}

export function applyItems(onlyItems) {
  const setParam = hooks.curtains ? Live2D.setNow : Live2D.setTarget;
  const onlyKeys = onlyItems ? new Set(onlyItems) : null;
  const textureMap = {};
  const worn = onceWorn();
  for (const it of ITEMS) {
    if (onlyKeys && !onlyKeys.has(it.key)) continue;
    const on = isOn(it);
    if (it.param) {
      setParam(it.param, on || moddedItems.has(it.key) ? 1 : 0);
      hideUnpainted(it, !on && moddedItems.has(it.key), worn);
    }
    if (it.visibilityPatterns) {
      const visOn  = it.visOn  !== undefined ? it.visOn  : null;
      const visOff = it.visOff !== undefined ? it.visOff : 0;
      const op = on ? visOn : visOff;
      for (const id of Live2D.findDrawables(it.visibilityPatterns, it.visibilityExcludes)) {
        // mods/engine.js has this one up on purpose, don't put it back down
        if (Mods.holds(id)) continue;
        Live2D.setDrawableOpacity(id, op);
      }
    }
    // only set while it's worn. the item that owns them rewrites these
    // every pass, so clearing the override here just fights it.
    if (on && it.hideWhenOn) {
      Live2D.opacityByPattern(it.hideWhenOn, [], 0);
    }
    for (const [drawable, texture] of Object.entries(it.textures || {})) {
      textureMap[drawable] = textureAvailable(texture) ? texture : null;
    }
  }
  if (Object.keys(textureMap).length) Live2D.setDrawableTextures(textureMap);
  applyFootCover();
  applyDecals();
}

export function applyAll() {
  Live2D.opacityByPattern(ALWAYS_HIDDEN, [], 0);
  applyItems();
  applyVariants();
  // applyColors ends by re-running Mods, which has to see the fresh
  // tints
  applyColors();
}

export function applyVariants(onlyKey) {
  const onlyKeys = onlyKey
    ? new Set(Array.isArray(onlyKey) ? onlyKey : [onlyKey])
    : null;
  applyDrawOrder();
  let remod = false;
  for (const v of VARIANTS) {
    if (onlyKeys && !onlyKeys.has(v.key)) continue;
    const opt = v.options[variantState[v.key] || 0];
    if (v.key === 'sock_style' && stockingColorMode()) {
      applyStockingTexture();
    } else if (!v.options.every(o => o.opacity)) {
      if (v.key === 'sock_style') cancelStockingTexture();
      const map = {};
      for (const d of v.drawables) {
        // a mod bake holds the drawable and puts the style under itself
        if (Mods.owns(d)) { remod = true; continue; }
        const texture = opt.textures ? opt.textures[d] || null : null;
        map[d] = texture && textureAvailable(texture) ? texture : null;
      }
      Live2D.setDrawableTextures(map);
    }
    applyVariantVisibility(v);
  }
  if (remod) Mods.applyAll();
  applyFootCover();
  applyDecals();
}

// stocking's soft edge is ~1px inside the mech foot and the grey shows
// thru (a band at the date page zoom). covered foot = not drawn
const SOCK_DRAWABLES = ['StockingL', 'StockingR'];
const FEET = ['AttachLegLFeet', 'AttachLegRFeet'];
export function applyFootCover() {
  const sock = VARIANTS.find(v => v.key === 'sock_style');
  const covered = state.stockings && !sock.options[variantState.sock_style || 0].bareFeet
    && !SOCK_DRAWABLES.some(Mods.owns);
  for (const id of FEET) {
    if (Mods.holds(id)) continue;
    Live2D.setDrawableOpacity(id, covered ? 0 : null);
  }
}

// mod limbs are mech art too. on standard legs the calf's notched
// top lands over the thigh unless they get the experimental order.
export function applyDrawOrder() {
  Live2D.setDrawableOrderBelow(VARIANTS.flatMap(v => {
    const own = v.options[variantState[v.key] || 0].order;
    if (own) return own;
    const mech = v.options.find(o => o.order);
    return mech ? mech.order.filter(pair => pair.some(Mods.owns)) : [];
  }));
}

function applyVariantVisibility(v) {
  const opt = v.options[variantState[v.key] || 0];
  const owners = VARIANT_OWNER[v.key];
  const worn = !owners || owners.some(k => state[k]);
  const show = new Set(opt.show || []);
  const hide = new Set(opt.hide || []);
  const controlled = new Set();
  for (const o of v.options) {
    for (const d of o.show || []) controlled.add(d);
    for (const d of o.hide || []) controlled.add(d);
    for (const d of Object.keys(o.opacity || {})) controlled.add(d);
  }
  for (const d of controlled) {
    const op = owners && !worn ? 0 : show.has(d) ? 1 : hide.has(d) ? 0 : opt.opacity?.[d] ?? null;
    // a mod holding a drawable up needs it left on. null hands it back to
    // the rig, which parks every Moddable* slot at zero
    if (op !== 1 && Mods.holds(d)) continue;
    Live2D.setDrawableOpacity(d, op);
  }
}

// mods/engine.js calls this after it lets go of a drawable it had forced
// visible, so whatever we wanted showing there goes back on.
export function refreshVisibility() {
  applyItems();
  for (const v of VARIANTS) applyVariantVisibility(v);
}

export function setVariant(key, index) {
  const v = VARIANTS.find(x => x.key === key);
  if (!v || !v.options[index]) return;
  return queueWardrobe((items, variants) => { variants[key] = index; }, () => {
    if (key.indexOf('hair_') === 0 && hooks.react) {
      hooks.react({ key, label: v.label, on: true, state: snapshot() });
    }
  });
}

export function applyColors() {
  forgetTints();
  // clear first, or a small tint wipes out the colors of a bigger
  // group
  const touched = new Set();
  for (const g of COLOR_GROUPS) {
    for (const id of Live2D.findDrawables(g.includes, g.excludes)) touched.add(id);
  }
  for (const id of touched) {
    Live2D.setDrawableTint(id, null);
    Live2D.setDrawableScreen(id, null);
  }
  for (const g of COLOR_GROUPS) {
    const rgb = hexToRgb01(colors[g.key]);
    if (!rgb || g.decal) continue;
    if (g.tintMode === 'screen') {
      Live2D.screenByPattern(g.includes, g.excludes, rgb);
    } else {
      Live2D.tintByPattern(g.includes, g.excludes, rgb);
    }
  }
  if (stockingColorMode()) applyStockingTexture();
  // the face-mod slot only follows skin color while it holds face
  // art. glasses sit in the same slot and must NOT get tinted like
  // skin.
  if ((variantState.glasses_style || 0) > 0) Live2D.setDrawableTint('ModdableFace', null);
  applyGlassesTexture();
  applyDecals();
  // a mod holding one of these drawables took its tint off the
  // shader and bakes it in itself, so it has to re-read whatever we
  // just set. every path that recolors her comes through here,
  // which is why the call lives here and not in applyAll.
  Mods.refreshTints();
}

export function setDraftItem(items, key, on) {
  const it = ITEMS.find(x => x.key === key);
  if (!it) return;
  items[key] = !!on;
  if (items[key] && it.excludes) for (const ex of it.excludes) items[ex] = false;
}

export function setItem(key, on) {
  const it = ITEMS.find(x => x.key === key);
  if (!it) return;
  return queueWardrobe((items) => setDraftItem(items, key, on), () => {
    if (hooks.react) {
      hooks.react({ key, label: it.label, on: state[key], state: snapshot() });
    }
  });
}

export function setColor(key, hex) {
  if (!(key in colors)) return;
  const value = hex === null ? null : normalizeHex(hex);
  if (hex !== null && value === null) return;
  colors[key] = value;
  saveColors();
  applyColors();
}

export function reset() {
  return queueWardrobe((items, variants) => {
    for (const it of ITEMS) items[it.key] = it.defaultOn;
    for (const v of VARIANTS) variants[v.key] = 0;
  }, () => {
    for (const g of COLOR_GROUPS) colors[g.key] = g.defaultColor || null;
    saveColors();
    applyColors();
  });
}
