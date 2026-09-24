import * as Prefs from '../core/prefs.js?v=1';
import { api, apiJson } from '../core/api.js?v=1';
import { COLOR_GROUPS, GLASSES_STYLES, ITEMS, VARIANTS, VARIANT_OWNER } from './catalog.js?v=1';
import { Presets, applyChanged, loadPresetState } from './presets.js?v=3';
import { applyGlassesTexture } from './composite.js?v=3';
import { applyItems, applyVariants } from './apply.js?v=3';
import { colors, state, variantState } from './current.js?v=1';
import { loadBakedTiles } from '../wardrobe/tile-bake.js?v=3';
import { normalizeHex } from './colors.js?v=1';
import * as Mods from '../mods/mods.js?v=3';
import { hooks } from './hooks.js?v=1';

const STORAGE_KEY = 'omega.outfit.v1';

const COLOR_KEY = 'omega.outfit.colors.v1';

const VARIANT_KEY = 'omega.outfit.variants.v1';

let wardrobeQueue = Promise.resolve();

let pendingWardrobe = null;

export let authorizedAssets = new Set();

export let availableAssets = new Set();

let nextWardrobeWrite = 0;

const assetPath = (value) => {
  const url = typeof value === 'object' ? value.url : value;
  return typeof url === 'string' && url.startsWith('assets/') ? url.slice(7) : null;
};

export const textureAvailable = (value) => {
  const path = assetPath(value);
  return !path || availableAssets.has(path);
};

export function activeAssets(items = state, variants = variantState) {
  const assets = new Set();
  for (const it of ITEMS) {
    if (!items[it.key]) continue;
    for (const value of Object.values(it.textures || {})) {
      const path = assetPath(value);
      if (path) assets.add(path);
    }
  }
  for (const v of VARIANTS) {
    const owners = VARIANT_OWNER[v.key];
    if (owners && !owners.some(key => items[key])) continue;
    const opt = v.options[variants[v.key] || 0];
    for (const value of Object.values(opt.textures || {})) {
      const path = assetPath(value);
      if (path) assets.add(path);
    }
    const thumb = assetPath(opt.thumb);
    if (thumb) assets.add(thumb);
  }
  const glasses = GLASSES_STYLES[variants.glasses_style || 0];
  if (glasses) {
    for (const [part] of glasses.layers) assets.add(`variants/glasses/${glasses.base}_${part}.png`);
  }
  return [...assets];
}

function drawablesForAssets(assets) {
  const paths = new Set(assets);
  const drawables = new Set();
  for (const it of ITEMS) {
    for (const [drawable, texture] of Object.entries(it.textures || {})) {
      if (paths.has(assetPath(texture))) drawables.add(drawable);
    }
  }
  for (const v of VARIANTS) {
    const opt = v.options[variantState[v.key] || 0];
    for (const [drawable, texture] of Object.entries(opt.textures || {})) {
      if (paths.has(assetPath(texture))) drawables.add(drawable);
    }
  }
  if ([...paths].some(path => path.startsWith('variants/glasses/'))) {
    drawables.add('ModdableFace');
  }
  return drawables;
}

export async function writeWardrobe(items, variants) {
  const wait = nextWardrobeWrite - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  nextWardrobeWrite = Date.now() + 500;
  const r = await apiJson('outfit.php', { items, variants, assets: activeAssets(items, variants) }, { method: 'PUT' });
  if (!r.ok) throw new Error(`wardrobe update failed: ${r.status}`);
  return (await r.json()).state;
}

function importWardrobe(saved) {
  if (!saved || typeof saved !== 'object') return;
  authorizedAssets = new Set(Array.isArray(saved.assets) ? saved.assets : []);
  availableAssets = new Set(authorizedAssets);
  for (const it of ITEMS) if (typeof saved.items?.[it.key] === 'boolean') state[it.key] = saved.items[it.key];
  for (const v of VARIANTS) {
    const legacy = v.key === 'hair_h0_style' && typeof saved.items?.hair_clip === 'boolean'
      ? Number(saved.items.hair_clip) : undefined;
    const value = saved.variants?.[v.key] ?? legacy;
    if (Number.isInteger(value) && value >= 0 && value < v.options.length) variantState[v.key] = value;
  }
}

export function queueWardrobe(mutator, after) {
  const change = () => updateWardrobe(mutator, after);
  return hooks.curtains ? hooks.curtains(change) : change();
}

function updateWardrobe(mutator, after) {
  const items = { ...state };
  const variants = { ...variantState };
  mutator(items, variants);
  const changed = loadPresetState({ items, variants });
  const didChange = changed && (changed.items || changed.variants.length);
  if (!didChange) return wardrobeQueue;

  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  try { localStorage.setItem(VARIANT_KEY, JSON.stringify(variantState)); } catch (e) {}
  applyChanged(changed);
  if (hooks.refresh) hooks.refresh();
  if (after) after();

  pendingWardrobe = { items: { ...state }, variants: { ...variantState } };
  wardrobeQueue = wardrobeQueue.then(async () => {
    const pending = pendingWardrobe;
    if (!pending) return;
    pendingWardrobe = null;
    const saved = await writeWardrobe(pending.items, pending.variants);
    const nextAssets = new Set(Array.isArray(saved.assets) ? saved.assets : []);
    const addedAssets = [...nextAssets].filter(asset => !availableAssets.has(asset));
    authorizedAssets = nextAssets;
    for (const asset of nextAssets) availableAssets.add(asset);
    if (addedAssets.length) {
      applyItems();
      applyVariants();
      applyGlassesTexture();
      if ([...drawablesForAssets(addedAssets)].some(drawable => Mods.owns(drawable))) {
        Mods.applyAll();
      }
    }
  }).catch(e => console.error(e));
  return wardrobeQueue;
}

export async function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      for (const it of ITEMS) {
        if (typeof saved[it.key] === 'boolean') state[it.key] = saved[it.key];
      }
    }
  } catch (e) {}
  try {
    const raw = localStorage.getItem(COLOR_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      for (const g of COLOR_GROUPS) {
        const value = saved[g.key];
        if (value === null) colors[g.key] = null;
        else {
          const normalized = normalizeHex(value);
          if (normalized) colors[g.key] = normalized;
        }
      }
    }
  } catch (e) {}
  try {
    const raw = localStorage.getItem(VARIANT_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      for (const v of VARIANTS) {
        const i = saved[v.key];
        if (Number.isInteger(i) && i >= 0 && i < v.options.length) variantState[v.key] = i;
      }
    }
  } catch (e) {}
  const r = await api('outfit.php');
  await loadBakedTiles();
  if (!r.ok) throw new Error(`wardrobe load failed: ${r.status}`);
  const remote = await r.json();
  if (remote.initialized) importWardrobe(remote.state);
  else importWardrobe(await writeWardrobe({ ...state }, { ...variantState }));
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  try { localStorage.setItem(VARIANT_KEY, JSON.stringify(variantState)); } catch (e) {}
  // describe() reads the saved-look names straight off this cache
  // and it runs on the chat page, where nothing else ever opens the
  // Looks modal.
  Presets.list().catch(() => {});
}

export function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
}

export function saveColors() {
  try { localStorage.setItem(COLOR_KEY, JSON.stringify(colors)); } catch (e) {}
  Prefs.pushToServer();
}
