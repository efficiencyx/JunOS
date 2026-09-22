import * as Live2D from '../live2d/live2d.js?v=4';

function displayText(value, fallback, max = 120) {
  const source = typeof value === 'string' ? value : fallback;
  const clean = source.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (clean || fallback).slice(0, max);
}

const luaStr = `'((?:\\\\'|[^'])*)'|"((?:\\\\"|[^"])*)"`;
const unesc = (s) => (s || '').replace(/\\(['"\\n])/g, (m, c) => c === 'n' ? '\n' : c);

// GetPackedTexture paths tie prefabs to texture folders. folder
// order is not prefab order. parse the Lua, never run it.
function parseLua(src) {
  const prefabs = new Map();
  const pf = (v) => {
    if (!prefabs.has(v)) prefabs.set(v, { name: null, slots: [], equip: null, folders: new Set() });
    return prefabs.get(v);
  };
  for (const m of src.matchAll(new RegExp(`(\\w+)\\s*\\.\\s*Name\\s*=\\s*(?:${luaStr})`, 'g'))) {
    pf(m[1]).name = unesc(m[2] !== undefined ? m[2] : m[3]);
  }
for (const m of src.matchAll(/(\w+)\s*\.\s*ColorSlots\s*=\s*\{([^}]*)\}/g)) {
    const slots = [];
    for (const s of m[2].matchAll(new RegExp(`ColorSlot\\.CreateInstance\\(\\s*(?:${luaStr})`, 'g'))) {
      slots.push(unesc(s[1] !== undefined ? s[1] : s[2]));
    }
    pf(m[1]).slots = slots;
  }
  // take legacy PossibleEquipmentSlots and SlotData both, inline
  // or in a closure with required slots. miss either one and
  // mutually exclusive items Stack.
  for (const m of src.matchAll(/(\w+)\s*\.\s*PossibleEquipmentSlots\s*=\s*\{\s*'([^']*)'/g)) {
    pf(m[1]).equip = m[2];
  }
  for (const m of src.matchAll(/(\w+)\s*\.\s*SlotData\s*=\s*SlotEquipData\.CreateInstance\(\s*'([^']*)'/g)) {
    pf(m[1]).equip = m[2];
  }
  for (const m of src.matchAll(/(\w+)\s*\.\s*SlotData\s*=\s*\(function\(\)([\s\S]*?)end\)\(\)/g)) {
    const slot = m[2].match(/TargetSlotString\s*=\s*'([^']*)'/);
    if (slot) pf(m[1]).equip = slot[1];
  }
  // local X = ModUtilities.GetPackedTexture(guid,
  // '/Folder/file.json') then prefab.AddTexture(X). first bit of
  // the path is the item's folder.
  const texVarFolder = new Map();
  for (const m of src.matchAll(/(\w+)\s*=\s*ModUtilities\.GetPackedTexture\([^,]+,\s*'\/?([^/']+)\//g)) {
    texVarFolder.set(m[1], m[2]);
  }
  for (const m of src.matchAll(/(\w+)\s*\.\s*AddTexture\s*\(\s*(\w+)\s*\)/g)) {
    const folder = texVarFolder.get(m[2]);
    if (folder && prefabs.has(m[1])) pf(m[1]).folders.add(folder);
  }
  return [...prefabs.values()].filter(p => p.name);
}

// a RectInt the way the game writes it. field names change with
// the serializer, so take x/y/width/height and the
// xMin/yMin/xMax/yMax form.
function rect(r) {
  if (!r) return null;
  const g = (...keys) => { for (const k of keys) if (typeof r[k] === 'number') return r[k]; return null; };
  let x = g('x', 'X', 'xMin', 'm_XMin'), y = g('y', 'Y', 'yMin', 'm_YMin');
  let w = g('width', 'Width', 'w'), h = g('height', 'Height', 'h');
  if (w === null && typeof r.xMax === 'number') w = r.xMax - x;
  if (h === null && typeof r.yMax === 'number') h = r.yMax - y;
  return (x === null || y === null || !w || !h) ? null : { x, y, w, h };
}

function drawableName(pd, validIds) {
  for (const v of Object.values(pd)) {
    if (typeof v === 'string' && validIds.has(v)) return v;
  }
  return pd.Name || pd.name || pd.DrawableName || null;
}

// only interaction containers fit this model. other scenes still
// sit in IndexedDB, we just skip drawing them.
export function parseMod(guid, files) {
  let meta = {};
  let lua = [];
  const folders = new Map();
  for (const [path, data] of Object.entries(files)) {
    const low = path.toLowerCase();
    if (low === 'mod.json' || low.endsWith('/mod.json')) {
      try { meta = JSON.parse(new TextDecoder().decode(data)); } catch (e) { }
      continue;
    }
    if (low.endsWith('.lua')) {
      try { lua = parseLua(new TextDecoder().decode(data)); } catch (e) { }
      continue;
    }
    const slash = path.indexOf('/');
    if (slash < 0) continue;
    const folder = path.slice(0, slash);
    if (!folders.has(folder)) folders.set(folder, { jsons: [], pngs: new Map() });
    const f = folders.get(folder);
    if (low.endsWith('.json') && low.includes('interaction')) f.jsons.push(path);
    if (low.endsWith('.png')) f.pngs.set(path.slice(slash + 1).toLowerCase(), path);
  }
  const items = [...folders.entries()]
    .filter(([, f]) => f.jsons.length)
    .map(([folder, f], i) => {
      const prefab = lua.find(p => p.folders.has(folder)) || lua[i] || {};
      return {
        folder, jsons: f.jsons, pngs: f.pngs,
        label: displayText(prefab.name, folder),
        slots: (prefab.slots || []).slice(0, 32).map(slot => displayText(slot, 'Color', 80)),
        equip: typeof prefab.equip === 'string' ? prefab.equip.slice(0, 120) : null,
      };
    });
  return {
    guid,
    name: displayText(meta.Name || meta.name, guid),
    items,
    files,
  };
}

function resolveTexture(mod, item, textureName) {
  const base = (textureName || '').split(/[\\/]/).pop().toLowerCase();
  if (item.pngs.has(base)) return item.pngs.get(base);
  const clean = textureName.replace(/\\/g, '/');
  if (mod.files[clean]) return clean;
  if (mod.files[item.folder + '/' + clean]) return item.folder + '/' + clean;
  return null;
}

const _drawableCache = new WeakMap();

export function itemDrawables(mod, item) {
  const cached = _drawableCache.get(item);
  if (cached) return cached;
  // empty before the model is up, and that must NOT get cached
  const valid = new Set(Live2D.findDrawables([''], []));
  const out = [];
  for (const jsonPath of item.jsons) {
    let doc;
    try { doc = JSON.parse(new TextDecoder().decode(mod.files[jsonPath])); } catch (e) { continue; }
    const packed = doc.PackedTextures || doc.packedTextures || [doc];
    for (const pt of packed) {
      const texPath = resolveTexture(mod, item, pt.TextureName || pt.textureName || '');
      if (!texPath) continue;
      for (const pd of (pt.PackedDrawables || pt.packedDrawables || [])) {
        const id = drawableName(pd, valid);
        const r = rect(pd.RectInt || pd.rectInt || pd.Rect || pd.rect);
        if (!id || !r || !valid.has(id)) continue;
        out.push({
          id, tex: texPath, r,
          // Layer sits on the PackedTexture in real exports. older or
          // hand edited mods sometimes put it on the drawable instead.
          layer: pd.Layer ?? pd.layer ?? pt.Layer ?? pt.layer ?? 0,
          colorIndex: pd.ColorIndex ?? pd.colorIndex ?? -1,
          // game rule, PackedTextureJson.DontIncludeVanillaLayers. when
          // it's set the default "vanilla" art is not drawn under the mod
          // layers, even if the mod has no layer-0 texture at all.
          dontIncludeVanilla: !!(pt.DontIncludeVanillaLayers ?? pt.dontIncludeVanillaLayers),
          // BypassColorScaler defaults off in exports. applyPass replaces
          // this raw default with the item's colour-toggle choice.
          bypassColorScaler: !!(pd.BypassColorScaler ?? pd.bypassColorScaler),
        });
      }
    }
  }
  if (valid.size) _drawableCache.set(item, out);
  return out;
}
