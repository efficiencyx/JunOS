// mod archives get read and drawn in the browser. we Never run the Lua.

window.Mods = (function () {
  // stored as { [guid]: { items: {i: bool},
  // colors: [hex|null] } }
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

  // ONLY zip method 0 (stored) and 8 (deflate) work here
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
      // no compression-ratio guard here. a flat-colour png atlas or a big
      // json legitimately does 500:1 and we were rejecting real mods for it.
      // the bomb is already capped by ENTRY_BYTES + TOTAL_BYTES below, and
      // inflateEntry stops the moment output passes the declared usize.
      if (usize > ZIP_MAX_ENTRY_BYTES) throw new Error('Expanded mod file is too large');
      totalSize += usize;
      if (totalSize > ZIP_MAX_TOTAL_BYTES) throw new Error('Expanded mod archive is too large');
      if (lho + 30 > buf.byteLength || dv.getUint32(lho, true) !== 0x04034b50) {
        throw new Error('Corrupt mod archive');
      }
      // the local header repeats the name and extra lengths, data comes after
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

  // prefab info scraped out of the generated script, which we never run. the
  // lua ties each prefab to its texture folders through GetPackedTexture
  // paths, and folder order is NOT prefab order, so we're stuck using that
  // mapping.
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
    // three spellings of "which slot does this go in", all in the wild.
    // PossibleEquipmentSlots is the old one. the exporter writes SlotData now,
    // either inline or as a closure when the item also declares required
    // slots. miss it and same-slot items stop being mutually exclusive, so you
    // end up wearing both variants of a thing at once.
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
    // local X = ModUtilities.GetPackedTexture(guid, '/Folder/file.json') then
    // prefab.AddTexture(X). first bit of the path is the item's folder.
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

  // a RectInt the way the game writes it. field names change with the
  // serializer, so take x/y/width/height AND the xMin/yMin/xMax/yMax form.
  function rect(r) {
    if (!r) return null;
    const g = (...keys) => { for (const k of keys) if (typeof r[k] === 'number') return r[k]; return null; };
    let x = g('x', 'X', 'xMin', 'm_XMin'), y = g('y', 'Y', 'yMin', 'm_YMin');
    let w = g('width', 'Width', 'w'), h = g('height', 'Height', 'h');
    if (w === null && typeof r.xMax === 'number') w = r.xMax - x;
    if (h === null && typeof r.yMax === 'number') h = r.yMax - y;
    return (x === null || y === null || !w || !h) ? null : { x, y, w, h };
  }

  // find the drawable name inside a PackedDrawable. take a field matching a
  // real drawable in the loaded model first, otherwise fall back to whatever
  // looks like a Name.
  function drawableName(pd, validIds) {
    for (const v of Object.values(pd)) {
      if (typeof v === 'string' && validIds.has(v)) return v;
    }
    return pd.Name || pd.name || pd.DrawableName || null;
  }

  // turn one mod's file map into items you can actually see and wear. only
  // the "interaction" scene containers work on this model, the rest of the
  // zip stays in IndexedDB but we skip it when drawing.
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

  // the baked canvases go straight into the compositor's own CPU-side
  // canvas, so keeping them off the GPU saves a readback per drawable.
  // same helper as textures.js, and same rule: only the first getContext
  // on a canvas takes the option.
  const ctx2d = (c) => c.getContext('2d', { willReadFrequently: true });

  // multiply a canvas by an #rrggbb color and keep the alpha. same math the
  // game uses to color its grey item textures.
  function tintCanvas(c, hex) {
    const ctx = ctx2d(c);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.globalCompositeOperation = 'destination-in';
    // draw the alpha back from the pixels we had before the multiply. the
    // multiply filled the WHOLE rect, so cut it back to where the art is.
    ctx.drawImage(c._alphaSrc, 0, 0, c.width, c.height);
    ctx.globalCompositeOperation = 'source-over';
  }

  const ATTACH_DRAWABLE = /^Attach/i;
  // per item, sits in its colour menu. it OVERRIDES BypassColorScaler both
  // ways on every drawable the item has: on = they all take the colour of the
  // part they land on, off = none of them do and the mod's own art colour
  // stands. it used to mean "on = force follow, off = whatever the mod said",
  // which read as broken - most mods leave the flag unset (that's the
  // serialized default and it already means follow her), so unticking the box
  // changed nothing at all.
  // never touched = whatever the mod asked for, collapsed to one answer for
  // the whole item: off if any drawable sets the flag, on otherwise. except
  // on her arms and legs, where she always wins - replacement limbs ship
  // neutral grey and set bypass on every one of them (Seamless Components
  // does it on all 29), so honouring it there left her with grey arms next to
  // a coloured body.
  function followsHerColors(mod, itemIndex) {
    // stored under "limbs", from when this only covered the Attach*
    // drawables. renaming the key would drop everyone's saved choice.
    const stored = (modState(mod.guid).limbs || {})[itemIndex];
    if (typeof stored === 'boolean') return stored;
    const entries = itemDrawables(mod, mod.items[itemIndex]);
    if (entries.some(e => ATTACH_DRAWABLE.test(e.id))) return true;
    return !entries.some(e => e.bypassColorScaler);
  }

  // parsing an item's texture jsons is pure work on immutable data, and a
  // pass does it for every worn item on top of the one you just clicked.
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
            // "don't scale me by the character's colour". an accessory sets
            // it and keeps its own colour, body art leaves it off and follows
            // her skin. defaults off because that's the serialized default.
            // this is the mod's raw answer and it is only the DEFAULT for the
            // item's "follow her colors" box - applyPass overwrites it per
            // entry with what the box actually says.
            bypassColorScaler: !!(pd.BypassColorScaler ?? pd.bypassColorScaler),
          });
        }
      }
    }
    if (valid.size) _drawableCache.set(item, out);
    return out;
  }

  // bake every worn mod entry for one drawable into a single canvas crop.
  // the compositor only takes ONE override per drawable, so the layers get
  // merged here.
  async function bakeDrawable(id, entries, colorsFor, hostTint, replaceVanilla) {
    entries.sort((a, b) => a.layer - b.layer);
    // vanilla art stays underneath unless the container says no vanilla
    // layers. same as Part.AddVanilla in the game.
    // we used to also treat a layer-0 texture as "replaces vanilla". THIS IS
    // A LIE. layer is just the z index inside the part and 0 is the common
    // one: 100 of the 160 vanilla items in variants/game_items.json ship a
    // layer-0 section, TailFluffy_common among them, on the same TailMain
    // rect a modded tail uses. so that rule erased her tail the moment you
    // equipped a mod tail, and ate the panties under a maebari.
    // the OTHER way a mod says "delete this decal": a 1x1 RectInt, pointing
    // at the transparent corner of its own sheet, stretched over a whole
    // drawable. nobody paints with that. Seamless Components does it to
    // barcode and lines on its smooth skins while its Translucent Abs variant
    // ships the real 322x126 lines crop in the same zip, so the mod is
    // telling us which it means. it never sets DontIncludeVanillaLayers.
    // and the wardrobe gets a say too. while the vanilla item that owns this
    // drawable is OFF, the mod is the only thing meant to be in it - we're
    // the ones holding the drawable visible at all (see applyPass), so the
    // art the rig was hiding has to go. without this a modded skirt came up
    // with the vanilla one poking out from under the hem.
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
      // RectInt starts from the BOTTOM left, that's unity texture space.
      // checked against both the tutorial cat-ears mod and Seamless
      // Components by holding the crops next to the vanilla atlas art.
      // canvas crops from the top. so flip it.
      const sy = img.naturalHeight - e.r.y - e.r.h;
      const tints = [];
      if (e.colorIndex >= 0) {
        const hex = colorsFor(e);
        if (hex) tints.push(hex);
      }
      // hostTint is the outfit colour this drawable normally gets from the
      // shader. we took that uniform away (see applyAll), so the layers that
      // DO want it have to get it here.
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
    // this canvas stays STRAIGHT alpha (colour and transparency kept apart),
    // same as the mod PNGs went in. the atlas it lands in is premultiplied,
    // but the compositor converts the whole patch once it has blended us over
    // her vanilla art - see straightAlpha in textures.js. we used to
    // premultiply here instead, which is right only when the art lands on
    // nothing. over vanilla art canvas blends us as straight anyway, so the
    // colour got faded by its alpha TWICE and every soft edge came out dark.
    // that's the black rim that showed up around her lips.
    // a replacement has to clear the WHOLE drawable. the compositor clips to
    // the mesh so the neighbours are safe, and mods delete decals by setting
    // DontIncludeVanillaLayers and shipping a 1x1 transparent texture, like
    // Seamless Components' barcode. an erase that only covers the art the mod
    // ships would leave that one sitting there.
    // the canvas goes to the compositor AS a canvas. this used to be a
    // toDataURL() and the compositor turned it straight back into an Image,
    // so every equip paid a full PNG encode plus decode per drawable. on a
    // mod that touches all 29 Attach* limbs that alone was seconds.
    // a mod slot has NO vanilla art. what's sitting in its atlas box is the
    // rig's placeholder - the hair slot's box holds a whole grey bob plus the
    // shine diamonds - and it only looked fine while the slot part sat at
    // opacity 0. we turn the slot on now, so the placeholder comes up UNDER
    // the mod: a bunny ears hat gave her a second head of hair over her face.
    // so erase the box, padded, same as outfit.js does for glasses in
    // ModdableFace.
    return { img: c, overlay: !replacesVanilla, straightAlpha: true, fullClear: MOD_SLOT.test(id) };
  }

  let mods = [];
  let state = {};
  let readyPromise = null;
  let appliedIds = new Set();

  // the game's ten mod slots. they all hang off one part the rig parks at
  // opacity 0, and nothing in the model ever turns it back on - the GAME does
  // that when an item goes in the slot. so a face crack mod bakes a perfect
  // patch into ModdableFace's atlas box and you see absolutely nothing.
  // outfit.js already does this for its glasses and logos with its show
  // lists. this is the same thing for mods.
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

  // the outfit colour of every drawable we took the shader tint away from, so
  // we can hand it back when the item comes off. the uniform itself is null
  // while we hold it, so it can't be read back.
  const heldTint = new Map();

  const rgbToHex = (rgb) => '#' + rgb
    .map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0'))
    .join('');

  // her skin, hair and tail colours are ONE multiply uniform per drawable, so
  // anything we bake into that drawable's atlas patch gets multiplied too - a
  // white latex bowtie on SkinBodyFront came out skin coloured, bunny ears on
  // ModdableHairFront came out hair coloured. can't exclude pixels from a
  // uniform, so we take it off the drawable and re-apply it ourselves, to the
  // vanilla art (see baseTint in textures.js) and to the mod layers that
  // asked for it. the ones with BypassColorScaler keep their own colour.
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

  // outfit just re-tinted the model, so every colour we remembered is stale.
  function refreshTints() {
    heldTint.clear();
    return applyAll();
  }

  // baking a drawable is a pile of synchronous canvas work and the atlas
  // recomposite after it is worse. it all runs on the thread that draws her,
  // so a whole equip done in one go stops the model dead. handing the frame
  // back keeps her blinking while the item lands.
  //
  // but do it per bake and the yields ARE the wait: a bake is ~1ms and a
  // frame is 16, so 59 of them turned a 54ms job into 1.4 seconds of waiting
  // for rAF. so yield on time spent, not on count. 8ms is half a frame at
  // 60Hz, which leaves her ticker room to draw.
  const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));
  let sliceStart = 0;
  async function breathe() {
    if (performance.now() - sliceStart < 8) return;
    await nextFrame();
    sliceStart = performance.now();
  }

  // every pass rebuilds the whole worn set from scratch, so taking one item
  // off used to re-bake every drawable of everything still on. baked canvases
  // are kept by what went into them and only the changed ones get redrawn.
  // the map is replaced each pass with just the hits, that's the eviction.
  let bakeCache = new Map();

  function bakeKey(id, entries, colorsFor, tint, replaceVanilla) {
    return id + '|' + entries.map(e => [e.url, e.r.x, e.r.y, e.r.w, e.r.h, e.layer, e.colorIndex,
      e.dontIncludeVanilla ? 1 : 0, e.bypassColorScaler ? 1 : 0, colorsFor(e) || ''].join()).join(';')
      + '|' + (tint || '') + (replaceVanilla ? '|R' : '');
  }

  let applyRunning = null;
  let applyQueued = null;

  // clicks arrive faster than a pass takes and only the LAST state matters,
  // so one queued pass behind the running one is all we ever need.
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
    // mod items land in vanilla drawables as often as in the Moddable* slots,
    // and the rig keeps those at zero opacity while the wardrobe item that
    // owns them is off. so a modded skirt showed NOTHING until you switched
    // the vanilla skirt back on, and then the vanilla skirt was under it.
    // both halves are wrong: we hold the drawable up ourselves, and the bake
    // replaces the vanilla art rather than layering over it. switch the
    // vanilla item on and they layer again, which is what you'd want from a
    // mod that only adds a decal.
    const hiddenByOutfit = window.Outfit?.hiddenItemDrawables?.() || new Set();
    const map = {};
    // null clears overrides that vanished from this pass
    for (const id of appliedIds) map[id] = null;
    for (const id of [...heldTint.keys()]) {
      if (!byDrawable.has(id)) releaseTint(id);
    }
    const fresh = new Map();
    for (const [id, entries] of byDrawable) {
      // only worth taking the uniform over when something actually opts out
      // of it AND there's a colour on the drawable to take over
      const tint = entries.some(e => e.bypassColorScaler) ? hostTintFor(id) : null;
      // ColorIndex points into the owning ITEM's ColorSlots list
      const colorsFor = (e) => ((modState(e.mod.guid).colors || {})[e.itemIndex] || [])[e.colorIndex] || null;
      const replaceVanilla = hiddenByOutfit.has(id);
      const key = bakeKey(id, entries, colorsFor, tint, replaceVanilla);
      let baked = bakeCache.get(key);
      if (!baked) {
        // only the drawables we actually redraw cost anything, so this is
        // where the frame goes back to the renderer
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
        if (MOD_SLOT.test(id) || hiddenByOutfit.has(id)) hold.add(id);
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
      // glasses live in ModdableFace too. dropping a face mod must not take
      // them down with it, so hand the slot back and let outfit re-claim it.
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
      // real exports nest it: doNotChangeVariablesBelowThis.guid.serializedGuid
      const nested = meta.doNotChangeVariablesBelowThis;
      guid = (nested && nested.guid && nested.guid.serializedGuid)
        || meta.Guid || meta.guid || meta.GUID;
    } catch (e) { }
    if (typeof guid !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(guid)) {
      throw new Error('mod.json with a valid guid not found - is this a mod zip?');
    }
    const mod = parseMod(guid, files);
    if (!mod.items.length) throw new Error('No items usable in the interaction scene found in this mod.');
    // like the game, importing the same guid replaces its old copy
    mods = mods.filter(m => m.guid !== guid);
    mods.push(mod);
    await idbPut({ guid, buf });
    // NOTHING is auto-equipped. like the game, items land in the "inventory"
    // and the user equips them, because mods often ship mutually exclusive
    // variants (three alternative skins, say) that must not stack.
    // re-importing resets the equip state, item indices may have moved anyway.
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
    // items sharing an equipment slot are mutually exclusive. game behavior,
    // equipping a Skin item replaces whatever Skin item is already on.
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

  // names of currently worn modded items. the ONLY mod data that ever leaves
  // the browser, inside the outfit_context system-prompt string.
  function describe() {
    const worn = [];
    for (const mod of mods) {
      mod.items.forEach((item, i) => { if (isEquipped(mod, i)) worn.push(item.label); });
    }
    return worn.length ? ` You are also wearing these special items: ${worn.join(', ')}.` : '';
  }

  let uiBody = null;

  // the grid is ONE horizontally scrolling row and wardrobe.html hides its
  // scrollbar, so past the four tiles that fit there is nothing on screen
  // saying the rest exist. a tester spent an evening hunting for the left
  // stocking of a pair that was sitting two tiles off the right edge. the
  // vanilla sections have had the chevron since forever, this is the same
  // one. outfit.js runs updateExpand on resize and on every wardrobe open,
  // because a grid measures 0 wide while the panel is still closed.
  const expandables = [];
  function updateExpand() {
    for (const [grid, expand] of expandables) {
      expand.hidden = !(grid.classList.contains('expanded') || grid.scrollWidth > grid.clientWidth + 1);
    }
  }

  // cut a canvas down to the pixels that aren't transparent. null when there
  // are none.
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

  // the crop is the whole DRAWABLE, not the item, so a bowtie came out as a
  // 598x1070 torso-shaped hole with a 40px bow in the corner. and the biggest
  // rect is often the emptiest one (the right cuff's is AttachArmRHandUp2,
  // which that layer doesn't paint at all), which is how two tiles ended up
  // fully blank. so trim to the art and skip whatever trims to nothing.
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

  return { applyAll, refreshTints, describe, buildWardrobeSection, importZip, removeMod,
    updateExpand, owns: (id) => appliedIds.has(id), holds: (id) => shownSlots.has(id) };
})();
