import * as Live2D from '../live2d/live2d.js?v=92';
import { idbStore } from '../core/idb.js?v=1';
import { hexToRgb01, normalizeHex } from '../outfit/colors.js?v=1';
import { applyDrawOrder, applyFootCover, applyVariants, hiddenItemDrawables, refreshVisibility, setModdedDrawables } from '../outfit/apply.js?v=46';
import { styleBase } from '../outfit/composite.js?v=46';
import { VARIANTS } from '../outfit/catalog.js?v=7';
import { unzip } from './zip.js?v=1';
import { deleteRemote, fetchRemote, listRemote, saveRemoteState, uploadRemote } from './server.js?v=2';
import { itemDrawables, parseMod } from './parse.js?v=23';
import { MOD_SLOT, bakeDrawable, fileUrl } from './layers.js?v=25';
import { hooks } from '../outfit/hooks.js?v=1';

const STATE_KEY = 'omega.mods.state.v1';
const REMOVED_KEY = 'omega.mods.removed.v1';
const GAME_KEY = 'omega.mods.game.v1';
const SYNC_KEY = 'omega.mods.sync.v1';
const zips = idbStore('omega-mods', 'zips', 'guid');

export let mods = [];
let state = {};
let removed = [];
let sync = { epoch: null, version: 0, dirty: false };
let edits = 0;
let readyPromise = null;
let appliedIds = new Set();

// the game turns its ten mod slots on by raising their parent
// part from opacity 0. the rig never does that. so we match the
// outfit/catalog.js show lists, or ModdableFace patches stay
// invisible.
const shownSlots = new Set();

function loadState() {
  try { state = JSON.parse(localStorage.getItem(STATE_KEY)) || {}; } catch (e) { state = {}; }
  try { removed = JSON.parse(localStorage.getItem(REMOVED_KEY)) || []; } catch (e) { removed = []; }
  try { sync = { ...sync, ...JSON.parse(localStorage.getItem(SYNC_KEY)) }; } catch (e) { }
}

function writeLocal() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    localStorage.setItem(REMOVED_KEY, JSON.stringify(removed));
    localStorage.setItem(SYNC_KEY, JSON.stringify(sync));
  } catch (e) { }
}

let pushTimer = null;
async function pushState(keepalive = false) {
  clearTimeout(pushTimer);
  pushTimer = null;
  const mark = edits;
  const version = await saveRemoteState({ state, game: gameWorn(), removed }, keepalive);
  if (version === null) return;
  sync.version = version;
  if (mark === edits) sync.dirty = false;
  writeLocal();
}

function saveState() {
  edits++;
  sync.dirty = true;
  writeLocal();
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushState, 1000);
}

// a closing tab would drop the debounced push and the next load would
// take the server's older copy over this change
addEventListener('pagehide', () => { if (pushTimer) pushState(true); });
export const modState = (guid) => (state[guid] = state[guid] || { items: {}, colors: [] });
export const isEquipped = (mod, i) => !!modState(mod.guid).items[i];

export async function ensureLoaded() {
  if (!readyPromise) {
    readyPromise = (async () => {
      loadState();
      const local = await zips.all();
      for (const rec of local) {
        try { mods.push(parseMod(rec.guid, await unzip(rec.buf))); }
        catch (e) { console.warn('Mod load failed', rec.guid, e); }
      }
      await syncRemote(local).catch(e => console.warn('mods: server sync failed', e));
    })();
  }
  return readyPromise;
}

const plainObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// a guid on the removed list got deleted in another browser,
// uploading it again would bring it back from the dead
async function syncRemote(local) {
  const remote = await listRemote();
  if (!remote || !Array.isArray(remote.mods)) return;
  // another account, or a factory reset, since this browser last synced
  if (sync.epoch && sync.epoch !== remote.epoch) {
    for (const rec of local) await zips.delete(rec.guid);
    local = [];
    mods = [];
    state = {};
    removed = [];
    setGameWorn([]);
    sync = { epoch: null, version: 0, dirty: false };
  }
  sync.epoch = remote.epoch;
  const doc = remote.state;
  if (doc && !(sync.dirty && doc.version === sync.version)) {
    state = plainObject(doc.state);
    removed = Array.isArray(doc.removed) ? doc.removed.filter(g => typeof g === 'string') : [];
    setGameWorn(Array.isArray(doc.game) ? doc.game : []);
    sync.version = doc.version || 0;
    sync.dirty = false;
  }
  const onServer = new Set(remote.mods.map(m => m.guid));
  for (const rec of local) {
    if (onServer.has(rec.guid)) continue;
    if (removed.includes(rec.guid)) {
      mods = mods.filter(m => m.guid !== rec.guid);
      await zips.delete(rec.guid);
    } else {
      uploadRemote(rec.guid, rec.buf).catch(e => console.warn('mod upload failed', rec.guid, e));
    }
  }
  const have = new Set(local.map(rec => rec.guid));
  for (const guid of onServer) {
    if (have.has(guid)) continue;
    if (removed.includes(guid)) {
      deleteRemote(guid);
      continue;
    }
    try {
      const buf = await fetchRemote(guid);
      if (!buf) continue;
      mods.push(parseMod(guid, await unzip(buf)));
      await zips.put({ guid, buf });
    } catch (e) { console.warn('mod download failed', guid, e); }
  }
  if (!doc || sync.dirty) saveState();
  else writeLocal();
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

const LIMB_SLOT = /^(Arm|Leg)[LR]$/;

// outfit/decals.js. one override per drawable, so makeup on a drawable
// a mod owns has to go through this bake or one of them gets erased
let decalHooks = null;
export const setDecalHooks = (hooks) => { decalHooks = hooks; };

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
  for (const [id, layers] of decalHooks?.layers(byDrawable) || []) byDrawable.get(id).push(...layers);
  // garments losing their mod go down before the vanilla art comes back,
  // new ones come up after the bake lands, or the vanilla hoodie flashes
  setModdedDrawables(new Set([...byDrawable.keys()].filter(id => appliedIds.has(id))));
  for (const [id, entries] of byDrawable) {
    if (entries.some(e => e.mod && LIMB_SLOT.test(e.mod.items[e.itemIndex].equip || ''))) continue;
    const base = await styleBase(id).catch(e => (console.warn('style under mod failed', id, e), null));
    if (base) entries.push({ ...base, layer: -1, colorIndex: -1, colorOf: () => null, styleBase: true });
  }
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
    const base = entries.find(e => e.styleBase);
    const tint = base?.tint || (entries.some(e => e.bypassColorScaler && !e.styleBase) ? hostTintFor(id) : null);
    // ColorIndex points into the owning item's ColorSlots list
    const colorsFor = (e) => (e.colorOf ? e.colorOf(e) : ((modState(e.mod.guid).colors || {})[e.itemIndex] || [])[e.colorIndex] || null);
    // a limb slot item IS the limb. layered over the dark mech art,
    // its soft edges go grey
    const replaceVanilla = hiddenByOutfit.has(id)
      || entries.some(e => e.mod && LIMB_SLOT.test(e.mod.items[e.itemIndex].equip || ''))
      || entries.some(e => e.styleBase && !e.keepVanilla);
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
  const before = appliedIds;
  appliedIds = new Set(byDrawable.keys());
  const tt = performance.now();
  await Live2D.setDrawableTextures(map);
  // a released drawable is back on the default art, not her style
  const freed = [...before].filter(id => !appliedIds.has(id));
  const styles = VARIANTS.filter(v => v.drawables.some(d => freed.includes(d))).map(v => v.key);
  if (styles.length) applyVariants(styles);
  const controllerDrawables = setModdedDrawables(appliedIds);
  applyDrawOrder();
  applyFootCover();
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
  decalHooks?.settled();
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
  removed = removed.filter(g => g !== guid);
  try { await uploadRemote(guid, buf); } catch (e) {
    console.warn('mod upload failed', guid, e);
    mod.localOnly = true;
  }
  // NOTHING is auto-equipped. like the game, items land in the
  // "inventory" and the user equips them, because mods often ship
  // mutually exclusive variants (three alternative skins, say) that
  // must not stack. re-importing resets the equip state, item
  // indices may have moved anyway. the one exception is what the
  // game had on her while this zip was missing.
  state[guid] = { items: {}, colors: {} };
  gameWorn().filter(w => w.guid === guid).forEach(wearGameItem);
  saveState();
  await applyAll();
  return mod;
}

export async function removeMod(guid) {
  mods = mods.filter(m => m.guid !== guid);
  delete state[guid];
  removed = [...removed.filter(g => g !== guid), guid].slice(-200);
  saveState();
  deleteRemote(guid);
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

function setGameWorn(list) {
  try { localStorage.setItem(GAME_KEY, JSON.stringify(list)); } catch (e) { }
}

function gameWorn() {
  try {
    const list = JSON.parse(localStorage.getItem(GAME_KEY));
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}

function gameItem(worn) {
  const mod = mods.find(m => m.guid === worn.guid);
  if (!mod) return null;
  let index = mod.items.findIndex(it => it.gameId === worn.id);
  if (index < 0) {
    const unnumbered = mod.items.flatMap((it, i) => (it.gameId === null && it.equip === worn.slot ? [i] : []));
    if (unnumbered.length === 1) index = unnumbered[0];
  }
  return index < 0 ? null : { mod, index };
}

function wearGameItem(worn) {
  const hit = gameItem(worn);
  if (!hit) return [];
  for (const mod of mods) {
    mod.items.forEach((it, i) => { if (it.equip === worn.slot) modState(mod.guid).items[i] = false; });
  }
  const st = modState(hit.mod.guid);
  st.items[hit.index] = true;
  // _colors read in ColorSlots order. counts match on real saves, the order is assumed
  const colors = (Array.isArray(worn.colors) ? worn.colors : [])
    .slice(0, hit.mod.items[hit.index].slots.length).map(normalizeHex);
  if (colors.length) {
    st.colors = st.colors || {};
    st.colors[hit.index] = colors;
  }
  return Array.isArray(worn.keys) ? worn.keys : [];
}

// only moves state, the caller applies the rig. returns the built-in stand-ins
export async function applyGameMods(list) {
  await ensureLoaded();
  for (const mod of mods) modState(mod.guid).items = {};
  const next = (Array.isArray(list) ? list : []).filter(w => w && typeof w.guid === 'string');
  setGameWorn(next);
  const standIns = next.flatMap(wearGameItem);
  saveState();
  return standIns;
}

export const gameStandIns = (guid) => gameWorn()
  .filter(w => w.guid === guid && gameItem(w))
  .flatMap(w => (Array.isArray(w.keys) ? w.keys : []));

export const missingGameItems = () => gameWorn().filter(w => !gameItem(w)).length;

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
export function inventory() {
  const worn = [], owned = [];
  for (const mod of mods) {
    mod.items.forEach((item, i) => (isEquipped(mod, i) ? worn : owned).push(item.label));
  }
  return { worn, owned: owned.slice(0, DESCRIBE_MAX) };
}

// change_outfit needs the owned names to tell a real mod item
// from one she made up. same names-only boundary as inventory().
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
