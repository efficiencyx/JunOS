import { api, apiJson } from '../core/api.js?v=1';
import { COLOR_GROUPS, ITEMS, VARIANTS, VARIANT_OWNER } from './catalog.js?v=1';
import { activeAssets, authorizedAssets, queueWardrobe, saveColors } from './sync.js?v=3';
import { applyColors, applyItems, applyVariants, itemDrawableIds } from './apply.js?v=3';
import { colors, state, variantState } from './current.js?v=1';
import * as Mods from '../mods/mods.js?v=3';
import { hooks } from './hooks.js?v=1';

export function exportPreset() {
  return { items: { ...state }, colors: { ...colors }, variants: { ...variantState } };
}

const SHARE_CODE_MAX_LENGTH = 16 * 1024;

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.has(key));
}

function canonicalPreset(input) {
  if (!plainObject(input)
      || !hasOnlyKeys(input, new Set(['items', 'colors', 'variants']))) {
    throw new Error('invalid outfit');
  }
  const itemInput = input.items === undefined ? {} : input.items;
  const colorInput = input.colors === undefined ? {} : input.colors;
  const variantInput = input.variants === undefined ? {} : input.variants;
  if (!plainObject(itemInput) || !plainObject(colorInput) || !plainObject(variantInput)) {
    throw new Error('invalid outfit');
  }

  const itemKeys = new Set([...ITEMS.map(it => it.key), 'hair_clip']);
  const colorKeys = new Set(COLOR_GROUPS.map(group => group.key));
  const variantKeys = new Set(VARIANTS.map(variant => variant.key));
  if (!hasOnlyKeys(itemInput, itemKeys)
      || !hasOnlyKeys(colorInput, colorKeys)
      || !hasOnlyKeys(variantInput, variantKeys)) {
    throw new Error('invalid outfit');
  }

  const clean = { items: {}, colors: {}, variants: {} };
  if (hasOwn(itemInput, 'hair_clip') && typeof itemInput.hair_clip !== 'boolean') {
    throw new Error('invalid outfit');
  }
  for (const it of ITEMS) {
    const value = hasOwn(itemInput, it.key) ? itemInput[it.key] : it.defaultOn;
    if (typeof value !== 'boolean') throw new Error('invalid outfit');
    clean.items[it.key] = value;
  }
  for (const it of ITEMS) {
    if (!clean.items[it.key]) continue;
    for (const excluded of it.excludes || []) {
      if (clean.items[excluded]) throw new Error('invalid outfit');
    }
  }
  for (const group of COLOR_GROUPS) {
    const fallback = group.defaultColor || null;
    const value = hasOwn(colorInput, group.key) ? colorInput[group.key] : fallback;
    if (value !== null && (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value))) {
      throw new Error('invalid outfit');
    }
    clean.colors[group.key] = typeof value === 'string' ? value.toLowerCase() : null;
  }
  for (const variant of VARIANTS) {
    const legacy = variant.key === 'hair_h0_style' && itemInput.hair_clip === true ? 1 : 0;
    const value = hasOwn(variantInput, variant.key) ? variantInput[variant.key] : legacy;
    if (!Number.isInteger(value) || value < 0 || value >= variant.options.length) {
      throw new Error('invalid outfit');
    }
    clean.variants[variant.key] = value;
  }
  return clean;
}

export function encodeOutfitCode() {
  return btoa(JSON.stringify({ v: 1, outfit: canonicalPreset(exportPreset()) }));
}

export function decodeOutfitCode(value) {
  const code = typeof value === 'string' ? value.trim() : '';
  if (!code || code.length > SHARE_CODE_MAX_LENGTH || !BASE64_PATTERN.test(code)) {
    throw new Error('invalid outfit code');
  }
  let payload;
  try {
    payload = JSON.parse(atob(code));
  } catch (e) {
    throw new Error('invalid outfit code');
  }
  if (!plainObject(payload) || payload.v !== 1
      || !hasOnlyKeys(payload, new Set(['v', 'outfit']))) {
    throw new Error('invalid outfit code');
  }
  return canonicalPreset(payload.outfit);
}

// returns the slots that actually moved, so callers can skip the
// expensive parts of applyAll(). a full applyVariants()
// recomposes every single atlas.
export function loadPresetState(preset) {
  if (!preset || typeof preset !== 'object') return null;
  const { items = {}, colors: cols = {}, variants = {} } = preset;
  const changed = { items: false, itemKeys: [], colors: false, variants: [] };
  for (const it of ITEMS) {
    const on = items[it.key];
    if (typeof on === 'boolean' && state[it.key] !== on) {
      state[it.key] = on;
      changed.items = true;
      changed.itemKeys.push(it.key);
    }
  }
  for (const g of COLOR_GROUPS) {
    const c = cols[g.key];
    if ((typeof c === 'string' || c === null) && colors[g.key] !== c) {
      colors[g.key] = c;
      changed.colors = true;
    }
  }
  for (const v of VARIANTS) {
    const i = variants[v.key];
    if (Number.isInteger(i) && i >= 0 && i < v.options.length && variantState[v.key] !== i) {
      variantState[v.key] = i;
      changed.variants.push(v.key);
    }
  }
  return changed;
}

export function applyChanged(changed) {
  if (!changed) return;
  if (changed.items) applyItems(changed.itemKeys);
  const variantKeys = new Set(changed.variants);
  if (changed.items) {
    const changedItems = new Set(changed.itemKeys);
    for (const v of VARIANTS) {
      if (VARIANT_OWNER[v.key]?.some(key => changedItems.has(key))) variantKeys.add(v.key);
    }
  }
  if (variantKeys.size) applyVariants([...variantKeys]);
  if (changed.colors || changed.variants.length) applyColors();
  // taking a vanilla item off is what tells a mod sitting in the
  // same drawable to wipe the art under it instead of layering over
  // it, so a toggle on anything a mod is holding has to re-bake.
  if (changed.items) {
    const touched = changed.itemKeys
      .map(key => ITEMS.find(it => it.key === key))
      .flatMap(it => (it ? itemDrawableIds(it) : []));
    if (touched.some(id => Mods.owns(id))) Mods.applyAll();
  }
}

export function applyPreset(preset) {
  clearTimeout(previewTimer);
  previewVersion++;
  const clean = canonicalPreset(preset);
  previewBase = null;
  const wardrobeChanged = ITEMS.some(it => state[it.key] !== clean.items[it.key])
    || VARIANTS.some(v => variantState[v.key] !== clean.variants[v.key]);
  const applyPresetColors = () => {
    for (const g of COLOR_GROUPS) colors[g.key] = clean.colors[g.key];
    saveColors();
    applyColors();
  };
  const queued = queueWardrobe((items, variants) => {
    Object.assign(items, clean.items);
    Object.assign(variants, clean.variants);
  }, applyPresetColors);
  if (!wardrobeChanged) applyPresetColors();
  return queued;
}

// previewBase restores the saved look when hover ends. previews
// never write storage.
let previewBase = null;

let previewVersion = 0;

function previewPreset(preset) {
  const version = ++previewVersion;
  const change = () => { if (version === previewVersion) applyPreview(preset); };
  if (hooks.curtains) hooks.curtains(change);
  else change();
}

function applyPreview(preset) {
  if (!preset) return;
  const items = { ...state, ...(preset.items || {}) };
  const variants = { ...variantState, ...(preset.variants || {}) };
  if (!activeAssets(items, variants).every(path => authorizedAssets.has(path))) return;
  if (!previewBase) previewBase = exportPreset();
  applyChanged(loadPresetState(preset));
}

// 90ms debounce, otherwise sliding the pointer down the list
// queues one full re-dress per row it crosses. no thank you.
let previewTimer = null;

export function schedulePreview(preset) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => previewPreset(preset), 90);
}

export function endPreview() {
  clearTimeout(previewTimer);
  const version = ++previewVersion;
  if (!previewBase) return;
  const change = () => {
    if (version !== previewVersion || !previewBase) return;
    const base = previewBase;
    previewBase = null;
    applyChanged(loadPresetState(base));
  };
  if (hooks.curtains) hooks.curtains(change);
  else change();
}

export const Presets = (function () {
  let cache = [];

  async function list() {
    const r = await api('wardrobe.php');
    if (!r.ok) throw new Error('load failed');
    const rows = await r.json();
    if (!Array.isArray(rows)) throw new Error('load failed');
    cache = rows.flatMap(row => {
      try {
        if (!plainObject(row) || typeof row.name !== 'string') return [];
        return [{
          id: row.id,
          name: row.name,
          updated_at: Number.isFinite(row.updated_at) ? row.updated_at : 0,
          data: canonicalPreset(row.data),
        }];
      } catch (e) {
        return [];
      }
    });
    return cache;
  }
  async function save(name) {
    const r = await apiJson('wardrobe.php', { name, data: exportPreset() });
    if (!r.ok) throw new Error('save failed');
    return list();
  }
  async function remove(id) {
    const r = await api('wardrobe.php?id=' + encodeURIComponent(id), { method: 'DELETE' });
    if (!r.ok) throw new Error('delete failed');
    return list();
  }
  const find = (id) => cache.find(p => String(p.id) === String(id)) || null;

  return { list, save, remove, find, get cache() { return cache; } };
})();
