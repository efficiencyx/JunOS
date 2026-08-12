// Mod archives are read and drawn in the browser. we Never run the Lua.

window.Mods = (function () {
  const STATE_KEY = 'omega.mods.state.v1';   // { [guid]: { items: {i: bool}, colors: [hex|null] } }
  const DB_NAME = 'omega-mods', DB_STORE = 'zips';

  // Handles stored and deflated ZIP entries.
  async function unzip(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65558); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a zip file');
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const entries = {};
    const td = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const csize = dv.getUint32(off + 20, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const cmtLen = dv.getUint16(off + 32, true);
      const lho = dv.getUint32(off + 42, true);
      const name = td.decode(u8.subarray(off + 46, off + 46 + nameLen));
      // The local header repeats the name and extra lengths, data comes after.
      const lnl = dv.getUint16(lho + 26, true), lel = dv.getUint16(lho + 28, true);
      const data = u8.subarray(lho + 30 + lnl + lel, lho + 30 + lnl + lel + csize);
      if (!name.endsWith('/')) entries[name] = { method, data };
      off += 46 + nameLen + extraLen + cmtLen;
    }
    const out = {};
    for (const [name, e] of Object.entries(entries)) {
      if (e.method === 0) out[name] = e.data;
      else if (e.method === 8) {
        const ds = new DecompressionStream('deflate-raw');
        const blob = new Blob([e.data]);
        out[name] = new Uint8Array(await new Response(blob.stream().pipeThrough(ds)).arrayBuffer());
      }
    }
    return out;
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

  // Prefab info read out of the generated script, which we never run. the
  // lua ties each prefab to its texture folders through GetPackedTexture
  // paths, and folder order is NOT prefab order, so we have to use that
  // mapping.
  function parseLua(src) {
    const prefabs = new Map();   // prefabVar -> { name, slots[], equip, folders:Set }
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
    for (const m of src.matchAll(/(\w+)\s*\.\s*PossibleEquipmentSlots\s*=\s*\{\s*'([^']*)'/g)) {
      pf(m[1]).equip = m[2];
    }
    // local X = ModUtilities.GetPackedTexture(guid, '/Folder/file.json') then
    // prefab.AddTexture(X). the first bit of the path is the item's folder.
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

  // A RectInt the way the game writes it. field names change with the
  // serializer, so take x/y/width/height and the xMin/yMin/xMax/yMax form.
  function rect(r) {
    if (!r) return null;
    const g = (...keys) => { for (const k of keys) if (typeof r[k] === 'number') return r[k]; return null; };
    let x = g('x', 'X', 'xMin', 'm_XMin'), y = g('y', 'Y', 'yMin', 'm_YMin');
    let w = g('width', 'Width', 'w'), h = g('height', 'Height', 'h');
    if (w === null && typeof r.xMax === 'number') w = r.xMax - x;
    if (h === null && typeof r.yMax === 'number') h = r.yMax - y;
    return (x === null || y === null || !w || !h) ? null : { x, y, w, h };
  }

  // Find the drawable name inside a PackedDrawable. take a field that
  // matches a real drawable in the loaded model first, otherwise fall back
  // to whatever looks like a Name.
  function drawableName(pd, validIds) {
    for (const v of Object.values(pd)) {
      if (typeof v === 'string' && validIds.has(v)) return v;
    }
    return pd.Name || pd.name || pd.DrawableName || null;
  }

  // Turn one mod's file map into items you can see and wear. only the
  // "interaction" scene containers work on this model, the rest of the zip
  // stays in IndexedDB but we skip it when drawing.
  function parseMod(guid, files) {
    let meta = {};
    let lua = [];
    const folders = new Map();   // folder -> { jsons: [], pngs: Map(lowerBasename -> path) }
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
          label: prefab.name || folder,
          slots: prefab.slots || [],
          equip: prefab.equip || null,
        };
      });
    return {
      guid,
      name: meta.Name || meta.name || guid,
      items,
      files,
    };
  }

  const _blobUrls = new Map();   // guid + '/' + path -> object URL
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

  // Multiply a canvas by an #rrggbb color and keep the alpha. same math the
  // game uses to color its grey item textures.
  function tintCanvas(c, hex) {
    const ctx = c.getContext('2d');
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.globalCompositeOperation = 'destination-in';
    // Draw the alpha back from the pixels we had before the multiply. the
    // multiply filled the whole rect, so cut it back to where the art is.
    ctx.drawImage(c._alphaSrc, 0, 0, c.width, c.height);
    ctx.globalCompositeOperation = 'source-over';
  }

  function itemDrawables(mod, item) {
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
            // hand edited mods can put it on the drawable.
            layer: pd.Layer ?? pd.layer ?? pt.Layer ?? pt.layer ?? 0,
            colorIndex: pd.ColorIndex ?? pd.colorIndex ?? -1,
            // Game rule, PackedTextureJson.DontIncludeVanillaLayers. when
            // it is set the default "vanilla" art is NOT drawn under the mod
            // layers, even if the mod has no layer-0 texture at all.
            dontIncludeVanilla: !!(pt.DontIncludeVanillaLayers ?? pt.dontIncludeVanillaLayers),
          });
        }
      }
    }
    return out;
  }

  // Bake every worn mod entry for one drawable into a single canvas crop.
  // the compositor only takes one override per drawable, so the layers get
  // merged here.
  async function bakeDrawable(entries, colorsFor) {
    entries.sort((a, b) => a.layer - b.layer);
    // Vanilla art stays underneath unless a layer-0 texture takes its place,
    // or the container says no vanilla layers. same as Part.AddVanilla in
    // the game.
    const hasBase = entries.some(e => e.layer === 0) || entries.some(e => e.dontIncludeVanilla);
    let W = 0, H = 0;
    const imgs = [];
    for (const e of entries) {
      const img = await loadImg(e.url);
      imgs.push(img);
      W = Math.max(W, e.r.w); H = Math.max(H, e.r.h);
    }
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    entries.forEach((e, i) => {
      const img = imgs[i];
      // RectInt starts from the bottom left, that is Unity texture space.
      // checked against both the tutorial cat-ears mod and Seamless
      // Components by holding the crops next to the vanilla atlas art.
      // canvas crops from the top, so flip it.
      const sy = img.naturalHeight - e.r.y - e.r.h;
      const hex = e.colorIndex >= 0 ? colorsFor(e) : null;
      if (!hex) {
        ctx.drawImage(img, e.r.x, sy, e.r.w, e.r.h, 0, 0, W, H);
        return;
      }
      const t = document.createElement('canvas');
      t.width = W; t.height = H;
      t.getContext('2d').drawImage(img, e.r.x, sy, e.r.w, e.r.h, 0, 0, W, H);
      const a = document.createElement('canvas');
      a.width = W; a.height = H;
      a.getContext('2d').drawImage(t, 0, 0);
      t._alphaSrc = a;
      tintCanvas(t, hex);
      ctx.drawImage(t, 0, 0);
    });
    // The atlas goes up as PREMULTIPLIED alpha, colour already faded by its own
    // transparency, because the vanilla art we extracted is baked that way. mod
    // PNGs are straight alpha, colour and transparency kept apart. without this
    // every soft edge in the mod art comes out too bright, you get glowing
    // rims around the lips and the nose shading.
    const px = ctx.getImageData(0, 0, W, H);
    const d = px.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a === 255 || a === 0) continue;
      d[i] = (d[i] * a + 127) / 255 | 0;
      d[i + 1] = (d[i + 1] * a + 127) / 255 | 0;
      d[i + 2] = (d[i + 2] * a + 127) / 255 | 0;
    }
    ctx.putImageData(px, 0, 0);
    // A replacement has to clear the whole drawable. the compositor clips to
    // the mesh so the neighbours are safe, and mods delete decals by shipping
    // a 1x1 transparent layer-0 texture, like Seamless Components' barcode.
    // an erase that only covers the art would leave that one alone.
    return { url: c.toDataURL(), overlay: !hasBase };
  }

  let mods = [];                 // parsed mods
  let state = {};                // guid -> { items: {index: bool}, colors: [hex|null] }
  let readyPromise = null;
  let appliedIds = new Set();    // drawables currently overridden by mods

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

  async function applyAll() {
    if (!window.Live2D || !Live2D.setDrawableTextures) return;
    await ensureLoaded();
    const byDrawable = new Map();   // id -> [{...entry, url, mod, itemIndex}]
    for (const mod of mods) {
      mod.items.forEach((item, i) => {
        if (!isEquipped(mod, i)) return;
        for (const e of itemDrawables(mod, item)) {
          if (!byDrawable.has(e.id)) byDrawable.set(e.id, []);
          byDrawable.get(e.id).push({ ...e, url: fileUrl(mod, e.tex), mod, itemIndex: i });
        }
      });
    }
    const map = {};
    for (const id of appliedIds) map[id] = null;   // clear stale overrides
    for (const [id, entries] of byDrawable) {
      // ColorIndex points into the owning ITEM's ColorSlots list.
      try {
        map[id] = await bakeDrawable(entries,
          (e) => ((modState(e.mod.guid).colors || {})[e.itemIndex] || [])[e.colorIndex] || null);
      } catch (e) {
        console.warn('mod bake failed', id, e);
        delete map[id];
      }
    }
    appliedIds = new Set(byDrawable.keys());
    await Live2D.setDrawableTextures(map);
  }

  async function importZip(buf) {
    const files = await unzip(buf);
    const metaRaw = files['mod.json'] || files[Object.keys(files).find(k => k.toLowerCase().endsWith('/mod.json')) || ''];
    let guid = null;
    try {
      const meta = JSON.parse(new TextDecoder().decode(metaRaw));
      // Real exports nest it: doNotChangeVariablesBelowThis.guid.serializedGuid
      const nested = meta.doNotChangeVariablesBelowThis;
      guid = (nested && nested.guid && nested.guid.serializedGuid)
        || meta.Guid || meta.guid || meta.GUID;
    } catch (e) { }
    if (!guid) throw new Error('mod.json with a guid not found - is this a mod zip?');
    const mod = parseMod(guid, files);
    if (!mod.items.length) throw new Error('No items usable in the interaction scene found in this mod.');
    mods = mods.filter(m => m.guid !== guid);   // same guid replaces (game behavior)
    mods.push(mod);
    await idbPut({ guid, buf });
    // Nothing is auto-equipped: like the game, items land in the "inventory"
    // and the user equips them - mods often ship mutually exclusive variants
    // (e.g. three alternative skins) that must not stack. Re-importing resets
    // the equip state (item indices may have changed anyway).
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
    // Items sharing an equipment slot are mutually exclusive (game behavior:
    // equipping a Skin item replaces the currently equipped Skin item).
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

  // Names of currently worn modded items - the ONLY mod data that ever leaves
  // the browser (inside the outfit_context system-prompt string).
  function describe() {
    const worn = [];
    for (const mod of mods) {
      mod.items.forEach((item, i) => { if (isEquipped(mod, i)) worn.push(item.label); });
    }
    return worn.length ? ` You are also wearing these special items: ${worn.join(', ')}.` : '';
  }

  let uiBody = null;

  async function itemThumbUrl(mod, item) {
    const entries = itemDrawables(mod, item).map(e => ({ ...e, url: fileUrl(mod, e.tex) }));
    if (!entries.length) return null;
    entries.sort((a, b) => b.r.w * b.r.h - a.r.w * a.r.h);
    const baked = await bakeDrawable([entries[0]], () => null);
    return baked.url;
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
    for (const mod of mods) {
      const head = document.createElement('div');
      head.style.cssText = 'display:flex;gap:8px;align-items:center;margin:6px 0 4px;font-size:13px';
      head.innerHTML = `<b>${mod.name}</b><button class="ghost" title="Remove mod">×</button>`;
      head.querySelector('button').addEventListener('click', async () => {
        await removeMod(mod.guid);
        renderMods();
      });
      const grid = document.createElement('div');
      grid.className = 'wd-grid';
      mod.items.forEach((item, i) => {
        const tile = document.createElement('div');
        tile.className = 'wd-tile';
        tile.classList.toggle('on', isEquipped(mod, i));
        tile.innerHTML = `<div class="wd-noimg">…</div><span>${item.label}</span>`;
        itemThumbUrl(mod, item).then(url => {
          if (url) tile.firstChild.outerHTML = `<img draggable="false" src="${url}">`;
        });
        if (item.slots.length && window.Outfit && Outfit.makeItemColorButton) {
          const values = ((modState(mod.guid).colors || {})[i] || []);
          tile.appendChild(Outfit.makeItemColorButton(
            item.label, item.slots, values,
            (slotIndex, hex) => setColor(mod.guid, i, slotIndex, hex),
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
  }

  return { applyAll, describe, buildWardrobeSection, importZip, removeMod,
    owns: (id) => appliedIds.has(id) };
})();
