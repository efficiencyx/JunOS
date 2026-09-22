import { itemDrawables } from './parse.js?v=3';

export const MOD_SLOT = /^Moddable/;

const _blobUrls = new Map();
export function fileUrl(mod, path) {
  const key = mod.guid + '/' + path;
  if (!_blobUrls.has(key)) {
    _blobUrls.set(key, URL.createObjectURL(new Blob([mod.files[path]], { type: 'image/png' })));
  }
  return _blobUrls.get(key);
}
const _imgCache = new Map();
export function loadImg(url) {
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

// the compositor accepts one override per drawable, so merge
// layers here.
export async function bakeDrawable(id, entries, colorsFor, hostTint, replaceVanilla) {
  entries.sort((a, b) => a.layer - b.layer);
  // vanilla layers stay, same as Part.AddVanilla does it, unless
  // DontIncludeVanillaLayers is set. layer 0 is only a z index,
  // not a replacement. 100 of 160 items in variants/game_items.json
  // use it, TailFluffy_common on TailMain included. treat it as
  // replacement and tails get erased, so do panties under maebari.
  // a transparent 1x1 RectInt deletes a decal too. Seamless
  // Components does that for barcode/lines without setting
  // DontIncludeVanillaLayers, while Translucent Abs keeps a
  // 322x126 lines crop.
  // hidden vanilla items have to stay gone under mods, even when
  // applyPass wakes their drawables up.
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
    // RectInt is Unity coordinates, origin bottom-left. canvas
    // wants top-left, hence the flip
    const sy = img.naturalHeight - e.r.y - e.r.h;
    const tints = [];
    if (e.colorIndex >= 0) {
      const hex = colorsFor(e);
      if (hex) tints.push(hex);
    }
    // hostTint is the outfit colour this drawable normally gets from
    // the shader. we took that uniform away (see applyAll), so the
    // layers that do want it have to get it here.
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
  // keep straight alpha, colour seperate from transparency.
  // with straightAlpha set, textures.js blends over vanilla first
  // and premultiplies (bakes alpha into the colours) after. do it
  // the other way round and soft edges get darkened twice.
  // a replacement clears the whole drawable, mesh-clipped so the
  // neighbours survive. DontIncludeVanillaLayers + a transparent
  // 1x1 texture has to erase decals like Seamless Components'
  // barcode.
  // the canvas goes in as is, no PNG encode/decode on all 29
  // Attach* limbs.
  // mod slots hold placeholder art, not vanilla. pad the erase box
  // or the grey hair bob and shine diamonds show underneath.
  // outfit/composite.js does the same for glasses in ModdableFace.
  return { img: c, overlay: !replacesVanilla, straightAlpha: true, fullClear: MOD_SLOT.test(id) };
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
export async function itemThumbUrl(mod, item) {
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
