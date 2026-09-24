import * as Live2D from '../live2d/live2d.js?v=4';
import * as Prefs from '../core/prefs.js?v=1';
import { idbStore } from '../core/idb.js?v=1';
import { hexToRgb01 } from '../outfit/colors.js?v=1';
import { hiddenItemDrawables, refreshVisibility, setModdedDrawables } from '../outfit/apply.js?v=3';
import { unzip } from './zip.js?v=1';
import { itemDrawables, parseMod } from './parse.js?v=3';
import { MOD_SLOT, bakeDrawable, fileUrl } from './layers.js?v=3';
import { hooks } from '../outfit/hooks.js?v=1';

const STATE_KEY = 'omega.mods.state.v1';
const zips = idbStore('omega-mods', 'zips', 'guid');

export let mods = [];
let state = {};
let readyPromise = null;
let appliedIds = new Set();

// the game turns its ten mod slots on by raising their parent
// part from opacity 0. the rig never does that. so we match the
// outfit/catalog.js show lists, or ModdableFace patches stay
// invisible.
const shownSlots = new Set();

function loadState() {
  try { state = JSON.parse(localStorage.getItem(STATE_KEY)) || {}; } catch (e) { state = {}; }
}
function saveState() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) { }
  Prefs.pushToServer();
}
export const modState = (guid) => (state[guid] = state[guid] || { items: {}, colors: [] });
export const isEquipped = (mod, i) => !!modState(mod.guid).items[i];

export async function ensureLoaded() {
  if (!readyPromise) {
    readyPromise = (async () => {
      loadState();
      for (const rec of await zips.all()) {
        try { mods.push(parseMod(rec.guid, await unzip(rec.buf))); }
        catch (e) { console.warn('Mod load failed', rec.guid, e); }
      }
    })();
  }
  return readyPromise;
}

// the outfit colour of every drawable we took the shader tint
// away from, so we can hand it back when the item comes off. the
// uniform itself is null while we hold it, so it can't be read
// back.
const heldTint = new Map();

const rgbToHex = (rgb) => '#' + rgb
  .map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0'))
  .join('');

// one multiply uniform (a value the shader applies to every
// pixel) tints the whole drawable, mod pixels included. so it
// comes off and textures.js applies baseTint to vanilla and
// opted-in layers only. BypassColorScaler layers keep their own
// colour, SkinBodyFront and ModdableHairFront accessories too.
function hostTintFor(id) {
  if (heldTint.has(id)) return heldTint.get(id);
  const rgb = Live2D.getDrawableTint(id);
  return rgb ? rgbToHex(rgb) : null;
}

function releaseTint(id) {
  if (!heldTint.has(id)) return;
  const hex = heldTint.get(id);
  heldTint.delete(id);
  Live2D.setDrawableTint(id, hexToRgb01(hex));
}

// outfit just re-tinted the model, so every colour we remembered
// is stale.
export function refreshTints() {
  heldTint.clear();
  return applyAll();
}

// yield by elapsed work, not per bake. at ~1ms per bake and 16ms
// per frame, 59 yields turned a 54ms job into 1.4s. an 8ms budget
// leaves half a 60Hz frame for drawing during baking and atlas
// recomposition.
const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));
let sliceStart = 0;
async function breathe() {
  if (performance.now() - sliceStart < 8) return;
  await nextFrame();
  sliceStart = performance.now();
}

// cache by bake inputs so removing one item does not rebake the
// rest. replacing the map with this pass's hits evicts unused
// canvases.
let bakeCache = new Map();

function bakeKey(id, entries, colorsFor, tint, replaceVanilla) {
  return id + '|' + entries.map(e => [e.url, e.r.x, e.r.y, e.r.w, e.r.h, e.layer, e.colorIndex,
    e.dontIncludeVanilla ? 1 : 0, e.bypassColorScaler ? 1 : 0, colorsFor(e) || ''].join()).join(';')
    + '|' + (tint || '') + (replaceVanilla ? '|R' : '');
}

let applyRunning = null;
let applyQueued = null;

// clicks arrive faster than a pass takes and only the last state
// matters, so one queued pass behind the running one is all we
// ever need.
export function applyAll() {
  if (!applyRunning) {
    applyRunning = applyPass().finally(() => { applyRunning = null; });
    return applyRunning;
  }
  if (!applyQueued) {
    applyQueued = applyRunning.catch(() => { }).then(() => {
      applyQueued = null;
      return applyAll();
    });
  }
  return applyQueued;
}

async function applyPass() {
  await ensureLoaded();
  const t0 = performance.now();
  sliceStart = t0;
  let bakeMs = 0, bakes = 0;
  const byDrawable = new Map();
  for (const mod of mods) {
    mod.items.forEach((item, i) => {
      if (!isEquipped(mod, i)) return;
      const bypass = !followsHerColors(mod, i);
      for (const e of itemDrawables(mod, item)) {
        if (!byDrawable.has(e.id)) byDrawable.set(e.id, []);
        byDrawable.get(e.id).push({
          ...e, bypassColorScaler: bypass, url: fileUrl(mod, e.tex), mod, itemIndex: i,
        });
      }
    });
  }
  const controllerDrawables = setModdedDrawables(new Set(byDrawable.keys()));
  // mod items land in vanilla drawables as often as in the
  // Moddable* slots, and the rig keeps those at zero opacity while
  // the wardrobe item that owns them is off. parameter-driven
  // garments go back through the rig so it can pick the current
  // pose meshes. simple slots we just hold up here. either way the
  // bake replaces the vanilla art instead of layering over it.
  // switch the vanilla item on and they layer again, which is
  // exactly what you want from a mod that only adds a decal.
  const hiddenByOutfit = hiddenItemDrawables();
  const map = {};
  for (const id of appliedIds) map[id] = null;
  for (const id of [...heldTint.keys()]) {
    if (!byDrawable.has(id)) releaseTint(id);
  }
  const fresh = new Map();
  for (const [id, entries] of byDrawable) {
    const tint = entries.some(e => e.bypassColorScaler) ? hostTintFor(id) : null;
    // ColorIndex points into the owning item's ColorSlots list
    const colorsFor = (e) => ((modState(e.mod.guid).colors || {})[e.itemIndex] || [])[e.colorIndex] || null;
    const replaceVanilla = hiddenByOutfit.has(id);
    const key = bakeKey(id, entries, colorsFor, tint, replaceVanilla);
    let baked = bakeCache.get(key);
    if (!baked) {
      await breathe();
      const tb = performance.now();
      try {
        baked = await bakeDrawable(id, entries, colorsFor, tint, replaceVanilla);
        baked.key = key;
        bakes++;
        bakeMs += performance.now() - tb;
      } catch (e) {
        console.warn('mod bake failed', id, e);
        delete map[id];
        releaseTint(id);
        continue;
      }
    }
    map[id] = baked;
    fresh.set(key, baked);
    if (tint) {
      map[id].baseTint = tint;
      if (!heldTint.has(id)) {
        heldTint.set(id, tint);
        Live2D.setDrawableTint(id, null);
      }
    } else {
      releaseTint(id);
    }
  }
  bakeCache = fresh;
  appliedIds = new Set(byDrawable.keys());
  const hold = new Set();
  for (const id of byDrawable.keys()) {
    if (MOD_SLOT.test(id) || (hiddenByOutfit.has(id) && !controllerDrawables.has(id))) hold.add(id);
  }
  let released = false;
  for (const id of shownSlots) {
    if (hold.has(id)) continue;
    Live2D.setDrawableOpacity(id, null);
    shownSlots.delete(id);
    released = true;
  }
  for (const id of hold) {
    Live2D.setDrawableOpacity(id, 1);
    shownSlots.add(id);
  }
  // glasses live in ModdableFace too. dropping a face mod must not
  // take them down with it, so hand the slot back and let outfit
  // re-claim it.
  if (released) refreshVisibility();
  const tt = performance.now();
  await Live2D.setDrawableTextures(map);
  const total = performance.now() - t0;
  if (total > 200) {
    console.warn(`mods: apply ${total | 0}ms - ${byDrawable.size} drawables, ` +
      `${bakes} baked ${bakeMs | 0}ms, compositor ${performance.now() - tt | 0}ms`);
  }
}

export async function importZip(buf) {
  const files = await unzip(buf);
  const metaRaw = files['mod.json'] || files[Object.keys(files).find(k => k.toLowerCase().endsWith('/mod.json')) || ''];
  let guid = null;
  try {
    const meta = JSON.parse(new TextDecoder().decode(metaRaw));
    // real exports nest it:
    // doNotChangeVariablesBelowThis.guid.serializedGuid
    const nested = meta.doNotChangeVariablesBelowThis;
    guid = (nested && nested.guid && nested.guid.serializedGuid)
      || meta.Guid || meta.guid || meta.GUID;
  } catch (e) { }
  if (typeof guid !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(guid)) {
    throw new Error('mod.json with a valid guid not found - is this a mod zip?');
  }
  const mod = parseMod(guid, files);
  if (!mod.items.length) throw new Error('No items usable in the interaction scene found in this mod.');
  mods = mods.filter(m => m.guid !== guid);
  mods.push(mod);
  await zips.put({ guid, buf });
  // NOTHING is auto-equipped. like the game, items land in the
  // "inventory" and the user equips them, because mods often ship
  // mutually exclusive variants (three alternative skins, say) that
  // must not stack. re-importing resets the equip state, item
  // indices may have moved anyway.
  state[guid] = { items: {}, colors: {} };
  saveState();
  await applyAll();
  return mod;
}

export async function removeMod(guid) {
  mods = mods.filter(m => m.guid !== guid);
  delete state[guid];
  saveState();
  await zips.delete(guid);
  await applyAll();
}

export function setEquipped(guid, index, on) {
  const change = () => applyEquipped(guid, index, on);
  return hooks.curtains ? hooks.curtains(change) : change();
}

function applyEquipped(guid, index, on) {
  const st = modState(guid);
  st.items[index] = !!on;
  const mod = mods.find(m => m.guid === guid);
  if (on && mod) {
    const slot = mod.items[index] && mod.items[index].equip;
    if (slot) {
      mod.items.forEach((it, i) => {
        if (i !== index && it.equip === slot) st.items[i] = false;
      });
    }
  }
  saveState();
  return applyAll();
}

export function setColor(guid, itemIndex, slotIndex, hex) {
  const st = modState(guid);
  st.colors = st.colors || {};
  if (!st.colors[itemIndex]) st.colors[itemIndex] = [];
  st.colors[itemIndex][slotIndex] = hex || null;
  saveState();
  applyAll();
}

// only names leave the browser (via outfit_context), never the
// mod assets. owned names go in too so wearByName can match what
// she asks for. capped at 40 because this list rides the live
// context on Every turn.
const DESCRIBE_MAX = 40;
export function describe() {
  const worn = [], owned = [];
  for (const mod of mods) {
    mod.items.forEach((item, i) => (isEquipped(mod, i) ? worn : owned).push(item.label));
  }
  let s = worn.length ? ` You are also wearing these special items: ${worn.join(', ')}.` : '';
  if (owned.length) {
    s += ` Special items you own but are not wearing, usable by this exact name in`
      + ` an [A:outfit|item=NAME|state=on] tag: ${owned.slice(0, DESCRIBE_MAX).join(', ')}.`;
  }
  return s;
}

// change_outfit needs the owned names to tell a real mod item
// from one she made up. same names-only boundary as describe().
export function itemNames() {
  const out = [];
  for (const mod of mods) for (const item of mod.items) out.push(item.label);
  return out.slice(0, DESCRIBE_MAX);
}

// she only ever sees labels, so this is how a name out of an
// action tag gets back to an index. exact first, then a loose
// contains match, because she paraphrases ("bunny ears" for
// "Bunny Ears Hat"). labels under 4 chars don't get the loose
// pass, "bow" would swallow half a pack.
export function wearByName(name, on) {
  const want = String(name || '').toLowerCase().replace(/[_\s]+/g, ' ').trim();
  if (!want) return false;
  const entries = [];
  for (const mod of mods) {
    mod.items.forEach((item, i) => entries.push({ guid: mod.guid, i, label: item.label.toLowerCase() }));
  }
  const hit = entries.find(e => e.label === want)
    || entries.find(e => e.label.length >= 4 && (e.label.includes(want) || want.includes(e.label)));
  if (!hit) return false;
  setEquipped(hit.guid, hit.i, on);
  return true;
}

const ATTACH_DRAWABLE = /^Attach/i;
// the colour toggle overrides BypassColorScaler (the game flag
// that skips her outfit tint) both ways, on every drawable. on =
// follow the host, off = keep the mod's colours. never touched?
// off if any drawable bypasses, on otherwise. limbs default on
// anyway. the neutral-grey replacements set bypass (all 29 in
// Seamless Components) but they still need her skin colour.
export function followsHerColors(mod, itemIndex) {
  // stored under "limbs", from when this only covered the Attach*
  // drawables. renaming the key would drop everyone's saved choice.
  const stored = (modState(mod.guid).limbs || {})[itemIndex];
  if (typeof stored === 'boolean') return stored;
  const entries = itemDrawables(mod, mod.items[itemIndex]);
  if (entries.some(e => ATTACH_DRAWABLE.test(e.id))) return true;
  return !entries.some(e => e.bypassColorScaler);
}

export function setFollowsHerColors(guid, itemIndex, on) {
  const st = modState(guid);
  st.limbs = st.limbs || {};
  st.limbs[itemIndex] = !!on;
  saveState();
  applyAll();
}

export const owns = (id) => appliedIds.has(id);
export const holds = (id) => shownSlots.has(id);
