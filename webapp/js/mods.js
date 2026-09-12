// mod archives get read and drawn in the browser. we Never run
// the Lua.

window.Mods = (function () {
  const STATE_KEY = 'omega.mods.state.v1';
  const DB_NAME = 'omega-mods', DB_STORE = 'zips';
  const ZIP_MAX_BYTES = 256 * 1024 * 1024;
  const ZIP_MAX_ENTRIES = 2048;
  const ZIP_MAX_ENTRY_BYTES = 128 * 1024 * 1024;
  const ZIP_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

  function zipPath(name) {
    if (!name || name.length > 512 || name.includes('\\') || name.includes('\0') || name.startsWith('/')) {
      throw new Error('Unsafe path in mod archive');
    }
    const parts = name.split('/');
    if (parts.some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe path in mod archive');
    return parts.join('/');
  }

  async function inflateEntry(data, expectedSize) {
    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ZIP_MAX_ENTRY_BYTES || size > expectedSize) {
        await reader.cancel();
        throw new Error('Expanded mod file is too large');
      }
      chunks.push(value);
    }
    if (size !== expectedSize) throw new Error('Corrupt mod archive');
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }

  async function unzip(buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < 22 || buf.byteLength > ZIP_MAX_BYTES) {
      throw new Error('Mod archive is empty or too large');
    }
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65558); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a zip file');
    const count = dv.getUint16(eocd + 10, true);
    const centralSize = dv.getUint32(eocd + 12, true);
    const centralOffset = dv.getUint32(eocd + 16, true);
    if (dv.getUint16(eocd + 4, true) !== 0 || dv.getUint16(eocd + 6, true) !== 0 ||
        count > ZIP_MAX_ENTRIES || centralOffset + centralSize > eocd) {
      throw new Error('Unsupported or malformed mod archive');
    }
    let off = centralOffset;
    const entries = [];
    const names = new Set();
    let totalSize = 0;
    const td = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (off + 46 > buf.byteLength || dv.getUint32(off, true) !== 0x02014b50) {
        throw new Error('Corrupt mod archive');
      }
      const flags = dv.getUint16(off + 8, true);
      const method = dv.getUint16(off + 10, true);
      const csize = dv.getUint32(off + 20, true);
      const usize = dv.getUint32(off + 24, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const cmtLen = dv.getUint16(off + 32, true);
      const lho = dv.getUint32(off + 42, true);
      const next = off + 46 + nameLen + extraLen + cmtLen;
      if (next > buf.byteLength || flags & 1) throw new Error('Encrypted or corrupt mod archive');
      const rawName = td.decode(u8.subarray(off + 46, off + 46 + nameLen));
      if (rawName.endsWith('/')) { off = next; continue; }
      const name = zipPath(rawName);
      if (names.has(name)) throw new Error('Duplicate path in mod archive');
      names.add(name);
      if (method !== 0 && method !== 8) throw new Error('Unsupported compression in mod archive');
      // flat-colour PNGs and JSON can compress 500:1. use ENTRY_BYTES +
      // TOTAL_BYTES for the bomb limits, not a ratio. inflateEntry
      // stops at declared usize.
      if (usize > ZIP_MAX_ENTRY_BYTES) throw new Error('Expanded mod file is too large');
      totalSize += usize;
      if (totalSize > ZIP_MAX_TOTAL_BYTES) throw new Error('Expanded mod archive is too large');
      if (lho + 30 > buf.byteLength || dv.getUint32(lho, true) !== 0x04034b50) {
        throw new Error('Corrupt mod archive');
      }
      // the local header repeats the name and extra lengths, data comes
      // after
      const lnl = dv.getUint16(lho + 26, true), lel = dv.getUint16(lho + 28, true);
      const dataOffset = lho + 30 + lnl + lel;
      if (dataOffset > buf.byteLength || csize > buf.byteLength - dataOffset) throw new Error('Corrupt mod archive');
      if (method === 0 && csize !== usize) throw new Error('Corrupt mod archive');
      entries.push({ name, method, usize, data: u8.subarray(dataOffset, dataOffset + csize) });
      off = next;
    }
    if (off !== centralOffset + centralSize) throw new Error('Corrupt mod archive');
    const out = Object.create(null);
    for (const entry of entries) {
      out[entry.name] = entry.method === 0 ? entry.data.slice() : await inflateEntry(entry.data, entry.usize);
    }
    return out;
  }

  function displayText(value, fallback, max = 120) {
    const source = typeof value === 'string' ? value : fallback;
    const clean = source.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return (clean || fallback).slice(0, max);
  }

  function idb() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(DB_STORE, { keyPath: 'guid' });
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }
  async function idbAll() {
    const db = await idb();
    return new Promise((res, rej) => {
      const rq = db.transaction(DB_STORE).objectStore(DB_STORE).getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => rej(rq.error);
    });
  }
  async function idbPut(rec) {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(rec);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  }
  async function idbDelete(guid) {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(guid);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  }

  const luaStr = `'((?:\\\\'|[^'])*)'|"((?:\\\\"|[^"])*)"`;
  const unesc = (s) => (s || '').replace(/\\(['"\\n])/g, (m, c) => c === 'n' ? '\n' : c);

  // GetPackedTexture paths tie prefabs to texture folders. folder
  // order is NOT prefab order. parse the Lua, never run it.
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
    // accept legacy PossibleEquipmentSlots and SlotData, inline or in
    // a closure with required slots. missing either lets mutually
    // exclusive items stack.
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
  // the serializer, so take x/y/width/height AND the
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

  // only interaction containers fit this model. keep other scenes
  // in IndexedDB, but skip drawing them.
  function parseMod(guid, files) {
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

  const _blobUrls = new Map();
  function fileUrl(mod, path) {
    const key = mod.guid + '/' + path;
    if (!_blobUrls.has(key)) {
      _blobUrls.set(key, URL.createObjectURL(new Blob([mod.files[path]], { type: 'image/png' })));
    }
    return _blobUrls.get(key);
  }
  const _imgCache = new Map();
  function loadImg(url) {
    if (!_imgCache.has(url)) {
      const p = new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im); im.onerror = rej; im.src = url;
      });
      p.catch(() => _imgCache.delete(url));
      _imgCache.set(url, p);
    }
    return _imgCache.get(url);
  }

  function resolveTexture(mod, item, textureName) {
    const base = (textureName || '').split(/[\\/]/).pop().toLowerCase();
    if (item.pngs.has(base)) return item.pngs.get(base);
    const clean = textureName.replace(/\\/g, '/');
    if (mod.files[clean]) return clean;
    if (mod.files[item.folder + '/' + clean]) return item.folder + '/' + clean;
    return null;
  }

  // the baked canvases go straight into the compositor's own
  // CPU-side canvas, so keeping them off the GPU saves a readback
  // per drawable. same helper as textures.js, and same rule: only
  // the first getContext on a canvas takes the option.
  const ctx2d = (c) => c.getContext('2d', { willReadFrequently: true });

  function tintCanvas(c, hex) {
    const ctx = ctx2d(c);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.globalCompositeOperation = 'destination-in';
    // multiply fills transparent pixels too. restore the original
    // alpha.
    ctx.drawImage(c._alphaSrc, 0, 0, c.width, c.height);
    ctx.globalCompositeOperation = 'source-over';
  }

  const ATTACH_DRAWABLE = /^Attach/i;
  // the colour toggle overrides BypassColorScaler both ways on
  // every drawable: on follows the host, off keeps mod colours.
  // untouched defaults to off if any drawable bypasses, on
  // otherwise. limbs default on: neutral-grey replacements set
  // bypass (all 29 in Seamless Components), but need her skin
  // colour.
  function followsHerColors(mod, itemIndex) {
    // stored under "limbs", from when this only covered the Attach*
    // drawables. renaming the key would drop everyone's saved choice.
    const stored = (modState(mod.guid).limbs || {})[itemIndex];
    if (typeof stored === 'boolean') return stored;
    const entries = itemDrawables(mod, mod.items[itemIndex]);
    if (entries.some(e => ATTACH_DRAWABLE.test(e.id))) return true;
    return !entries.some(e => e.bypassColorScaler);
  }

  const _drawableCache = new WeakMap();

  function itemDrawables(mod, item) {
    const cached = _drawableCache.get(item);
    if (cached) return cached;
    // empty before the model is up, and that must NOT get cached
    const valid = new Set(Live2D.findDrawables ? Live2D.findDrawables([''], []) : []);
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
            // it's set the default "vanilla" art is NOT drawn under the mod
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

  // the compositor accepts one override per drawable, so merge
  // layers here.
  async function bakeDrawable(id, entries, colorsFor, hostTint, replaceVanilla) {
    entries.sort((a, b) => a.layer - b.layer);
    // keep vanilla layers as Part.AddVanilla does, unless
    // DontIncludeVanillaLayers is set. layer 0 is only a z index: 100
    // of 160 items in variants/game_items.json use it, including
    // TailFluffy_common on TailMain. treating it as replacement
    // erases tails and panties under maebari. a transparent 1x1
    // RectInt also deletes a decal: Seamless Components uses it for
    // barcode/lines without DontIncludeVanillaLayers, while
    // Translucent Abs keeps a 322x126 lines crop. hidden vanilla
    // items must stay absent under mods, even when applyPass wakes
    // their drawables.
    const isBlank = (e) => e.r.w <= 1 && e.r.h <= 1;
    const replacesVanilla = replaceVanilla
      || entries.some(e => e.dontIncludeVanilla || isBlank(e));
    entries = entries.filter(e => !isBlank(e));
    let W = 1, H = 1;
    const imgs = [];
    for (const e of entries) {
      const img = await loadImg(e.url);
      imgs.push(img);
      W = Math.max(W, e.r.w); H = Math.max(H, e.r.h);
    }
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = ctx2d(c);
    entries.forEach((e, i) => {
      const img = imgs[i];
      // RectInt uses bottom-left Unity coordinates, canvas uses
      // top-left.
      const sy = img.naturalHeight - e.r.y - e.r.h;
      const tints = [];
      if (e.colorIndex >= 0) {
        const hex = colorsFor(e);
        if (hex) tints.push(hex);
      }
      // hostTint is the outfit colour this drawable normally gets from
      // the shader. we took that uniform away (see applyAll), so the
      // layers that DO want it have to get it here.
      if (hostTint && !e.bypassColorScaler) tints.push(hostTint);
      if (!tints.length) {
        ctx.drawImage(img, e.r.x, sy, e.r.w, e.r.h, 0, 0, W, H);
        return;
      }
      const t = document.createElement('canvas');
      t.width = W; t.height = H;
      ctx2d(t).drawImage(img, e.r.x, sy, e.r.w, e.r.h, 0, 0, W, H);
      const a = document.createElement('canvas');
      a.width = W; a.height = H;
      ctx2d(a).drawImage(t, 0, 0);
      t._alphaSrc = a;
      for (const hex of tints) tintCanvas(t, hex);
      ctx.drawImage(t, 0, 0);
    });
    // keep STRAIGHT alpha (colour separate from transparency).
    // textures.js blends over vanilla before premultiplying via
    // straightAlpha, or soft edges get darkened twice. clear the
    // whole replacement drawable, mesh-clipped to protect neighbours:
    // DontIncludeVanillaLayers + a transparent 1x1 texture must erase
    // decals such as Seamless Components' barcode. pass the canvas
    // directly to avoid PNG encode/decode on all 29 Attach* limbs.
    // mod slots contain placeholder art, not vanilla: pad the erase
    // box or the grey hair bob and shine diamonds show underneath.
    // outfit.js does the same for glasses in ModdableFace.
    return { img: c, overlay: !replacesVanilla, straightAlpha: true, fullClear: MOD_SLOT.test(id) };
  }

  let mods = [];
  let state = {};
  let readyPromise = null;
  let appliedIds = new Set();

  // the game enables its ten mod slots by raising their parent part
  // from opacity 0. the rig never does it. match outfit.js show
  // lists or ModdableFace patches stay invisible.
  const MOD_SLOT = /^Moddable/;
  const shownSlots = new Set();

  function loadState() {
    try { state = JSON.parse(localStorage.getItem(STATE_KEY)) || {}; } catch (e) { state = {}; }
  }
  function saveState() {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) { }
    if (window.Prefs) Prefs.pushToServer();
  }
  const modState = (guid) => (state[guid] = state[guid] || { items: {}, colors: [] });
  const isEquipped = (mod, i) => !!modState(mod.guid).items[i];

  async function ensureLoaded() {
    if (!readyPromise) {
      readyPromise = (async () => {
        loadState();
        for (const rec of await idbAll()) {
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

  // one multiply uniform tints the whole drawable, including mod
  // pixels. remove it and apply baseTint in textures.js to vanilla
  // and opted-in layers only. BypassColorScaler layers keep their
  // colour, including SkinBodyFront and ModdableHairFront
  // accessories.
  function hostTintFor(id) {
    if (heldTint.has(id)) return heldTint.get(id);
    const rgb = Live2D.getDrawableTint ? Live2D.getDrawableTint(id) : null;
    return rgb ? rgbToHex(rgb) : null;
  }

  function releaseTint(id) {
    if (!heldTint.has(id)) return;
    const hex = heldTint.get(id);
    heldTint.delete(id);
    if (Live2D.setDrawableTint) Live2D.setDrawableTint(id, hexToRgb01(hex));
  }

  function hexToRgb01(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : null;
  }

  // outfit just re-tinted the model, so every colour we remembered
  // is stale.
  function refreshTints() {
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

  // clicks arrive faster than a pass takes and only the LAST state
  // matters, so one queued pass behind the running one is all we
  // ever need.
  function applyAll() {
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
    if (!window.Live2D || !Live2D.setDrawableTextures) return;
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
    const controllerDrawables = window.Outfit?.setModdedDrawables?.(new Set(byDrawable.keys())) || new Set();
    // mod items land in vanilla drawables as often as in the
    // Moddable* slots, and the rig keeps those at zero opacity while
    // the wardrobe item that owns them is off. parameter-driven
    // garments go back through the rig so it can choose the current
    // pose meshes; simple slots are held up here. either way the bake
    // replaces the vanilla art rather than layering over it. switch
    // the vanilla item on and they layer again, which is what you'd
    // want from a mod that only adds a decal.
    const hiddenByOutfit = window.Outfit?.hiddenItemDrawables?.() || new Set();
    const map = {};
    for (const id of appliedIds) map[id] = null;
    for (const id of [...heldTint.keys()]) {
      if (!byDrawable.has(id)) releaseTint(id);
    }
    const fresh = new Map();
    for (const [id, entries] of byDrawable) {
      const tint = entries.some(e => e.bypassColorScaler) ? hostTintFor(id) : null;
      // ColorIndex points into the owning ITEM's ColorSlots list
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
          if (Live2D.setDrawableTint) Live2D.setDrawableTint(id, null);
        }
      } else {
        releaseTint(id);
      }
    }
    bakeCache = fresh;
    appliedIds = new Set(byDrawable.keys());
    if (Live2D.setDrawableOpacity) {
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
      if (released && window.Outfit?.refreshVisibility) Outfit.refreshVisibility();
    }
    const tt = performance.now();
    await Live2D.setDrawableTextures(map);
    const total = performance.now() - t0;
    if (total > 200) {
      console.warn(`mods: apply ${total | 0}ms - ${byDrawable.size} drawables, ` +
        `${bakes} baked ${bakeMs | 0}ms, compositor ${performance.now() - tt | 0}ms`);
    }
  }

  async function importZip(buf) {
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
    await idbPut({ guid, buf });
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

  async function removeMod(guid) {
    mods = mods.filter(m => m.guid !== guid);
    delete state[guid];
    saveState();
    await idbDelete(guid);
    await applyAll();
  }

  function setEquipped(guid, index, on) {
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
    applyAll();
  }

  function setColor(guid, itemIndex, slotIndex, hex) {
    const st = modState(guid);
    st.colors = st.colors || {};
    if (!st.colors[itemIndex]) st.colors[itemIndex] = [];
    st.colors[itemIndex][slotIndex] = hex || null;
    saveState();
    applyAll();
  }

  // only names leave the browser via outfit_context, never mod
  // assets. include owned names so wearByName can match her
  // requests. cap at 40 because every turn carries this
  // live-context list.
  const DESCRIBE_MAX = 40;
  function describe() {
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

  // change_outfit needs all owned names to distinguish mods from
  // invented items. same names-only boundary as describe().
  function itemNames() {
    const out = [];
    for (const mod of mods) for (const item of mod.items) out.push(item.label);
    return out.slice(0, DESCRIBE_MAX);
  }

  // she only ever sees LABELS, so this is how a name out of an
  // action tag gets back to an index. exact first, then a loose
  // contains match, because she paraphrases - "bunny ears" for
  // "Bunny Ears Hat". short labels do not get the loose pass, "bow"
  // would swallow half a pack.
  function wearByName(name, on) {
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

  let uiBody = null;

  // wardrobe.html hides the horizontal scrollbar, so the chevron
  // has to show that more items exist past the four visible tiles.
  // outfit.js runs updateExpand on resize and every wardrobe open,
  // because the grid measures 0 wide while the panel is closed.
  const expandables = [];
  function updateExpand() {
    for (const [grid, expand] of expandables) {
      expand.hidden = !(grid.classList.contains('expanded') || grid.scrollWidth > grid.clientWidth + 1);
    }
  }

  function trimTransparent(c) {
    const ctx = ctx2d(c);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (d[(y * c.width + x) * 4 + 3] < 8) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return null;
    const t = document.createElement('canvas');
    t.width = x1 - x0 + 1; t.height = y1 - y0 + 1;
    ctx2d(t).drawImage(c, x0, y0, t.width, t.height, 0, 0, t.width, t.height);
    return t;
  }

  // trim to painted pixels, not drawable size. a 598x1070 torso can
  // hold a 40px bow, and AttachArmRHandUp2 can be entirely empty
  // for a cuff. skip empty crops.
  async function itemThumbUrl(mod, item) {
    const entries = itemDrawables(mod, item).slice();
    entries.sort((a, b) => b.r.w * b.r.h - a.r.w * a.r.h);
    for (const e of entries) {
      const img = await loadImg(fileUrl(mod, e.tex));
      const c = document.createElement('canvas');
      c.width = e.r.w; c.height = e.r.h;
      ctx2d(c).drawImage(img, e.r.x, img.naturalHeight - e.r.y - e.r.h, e.r.w, e.r.h,
        0, 0, e.r.w, e.r.h);
      const t = trimTransparent(c);
      if (t) return t.toDataURL();
    }
    return null;
  }

  function buildWardrobeSection(body) {
    uiBody = body;
    const t = document.createElement('div');
    t.className = 'wd-section';
    t.textContent = 'Mods';
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;align-items:center;margin:4px 0 8px';
    bar.innerHTML = `<button class="ghost" data-mod-load>Load mod (.zip)</button>
      <span data-mod-msg style="font-size:12px;opacity:.7">Mods stay in your browser - nothing is uploaded</span>
      <input type="file" accept=".zip" hidden>`;
    const input = bar.querySelector('input');
    const msg = bar.querySelector('[data-mod-msg]');
    bar.querySelector('[data-mod-load]').addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const f = input.files[0];
      input.value = '';
      if (!f) return;
      msg.textContent = 'Loading…';
      try {
        const mod = await importZip(await f.arrayBuffer());
        msg.textContent = `Loaded "${mod.name}" - click an item to equip it`;
        renderMods();
      } catch (e) {
        console.error(e);
        msg.textContent = 'Failed: ' + e.message;
      }
    });
    const list = document.createElement('div');
    list.dataset.modList = '1';
    body.append(t, bar, list);
    ensureLoaded().then(renderMods);
  }

  function renderMods() {
    const list = uiBody && uiBody.querySelector('[data-mod-list]');
    if (!list) return;
    list.innerHTML = '';
    expandables.length = 0;
    for (const mod of mods) {
      const head = document.createElement('div');
      head.style.cssText = 'display:flex;gap:8px;align-items:center;margin:6px 0 4px;font-size:13px';
      const title = document.createElement('b');
      title.textContent = mod.name;
      const remove = document.createElement('button');
      remove.className = 'ghost';
      remove.title = 'Remove mod';
      remove.textContent = '×';
      head.append(title, remove);
      remove.addEventListener('click', async () => {
        await removeMod(mod.guid);
        renderMods();
      });
      const grid = document.createElement('div');
      grid.className = 'wd-grid';
      const expand = document.createElement('button');
      expand.type = 'button';
      expand.className = 'wd-expand';
      expand.title = 'Show all';
      expand.hidden = true;
      expand.setAttribute('aria-expanded', 'false');
      expand.textContent = '⌄';
      expand.addEventListener('click', () => {
        const on = grid.classList.toggle('expanded');
        expand.classList.toggle('on', on);
        expand.setAttribute('aria-expanded', String(on));
        expand.title = on ? 'Collapse' : 'Show all';
      });
      head.insertBefore(expand, remove);
      expandables.push([grid, expand]);
      mod.items.forEach((item, i) => {
        const tile = document.createElement('div');
        tile.className = 'wd-tile';
        tile.classList.toggle('on', isEquipped(mod, i));
        const placeholder = document.createElement('div');
        placeholder.className = 'wd-noimg';
        placeholder.textContent = '…';
        const label = document.createElement('span');
        label.textContent = item.label;
        tile.append(placeholder, label);
        itemThumbUrl(mod, item).then(url => {
          if (!url) return;
          const image = document.createElement('img');
          image.draggable = false;
          image.src = url;
          tile.firstChild.replaceWith(image);
        });
        if (item.slots.length && window.Outfit && Outfit.makeItemColorButton) {
          const values = ((modState(mod.guid).colors || {})[i] || []);
          tile.appendChild(Outfit.makeItemColorButton(
            item.label, item.slots, values,
            (slotIndex, hex) => setColor(mod.guid, i, slotIndex, hex),
            'wd-swatch',
            {
              label: 'Follow her colors',
              get: () => followsHerColors(mod, i),
              set: (on) => setFollowsHerColors(mod.guid, i, on),
            },
          ));
        }
        tile.addEventListener('click', () => {
          setEquipped(mod.guid, i, !isEquipped(mod, i));
          grid.querySelectorAll('.wd-tile').forEach((t, j) => t.classList.toggle('on', isEquipped(mod, j)));
        });
        grid.appendChild(tile);
      });
      list.append(head, grid);
    }
    requestAnimationFrame(updateExpand);
  }

  function setFollowsHerColors(guid, itemIndex, on) {
    const st = modState(guid);
    st.limbs = st.limbs || {};
    st.limbs[itemIndex] = !!on;
    saveState();
    applyAll();
  }

  return { applyAll, refreshTints, describe, wearByName, itemNames, buildWardrobeSection, importZip,
    removeMod, updateExpand, owns: (id) => appliedIds.has(id), holds: (id) => shownSlots.has(id) };
})();
