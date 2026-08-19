import { markDirty, model, publicTint, raw } from '../live2d.js?v=6';
import { findDrawables } from './geometry.js?v=6';

export function tintByPattern(includes, excludes, rgb) {
  if (!publicTint) return [];
  const ids = findDrawables(includes, excludes);
  for (const id of ids) publicTint.setMultiply(id, rgb);
  return ids;
}

export function screenByPattern(includes, excludes, rgb) {
  if (!publicTint) return [];
  const ids = findDrawables(includes, excludes);
  for (const id of ids) publicTint.setScreen(id, rgb);
  return ids;
}

export function listDrawables() {
  return publicTint ? publicTint.listDrawables() : [];
}

// a variant only replaces its own UV region, the patch of the shared atlas
// this drawable reads from
const _texOverride = new Map();
export const _uvRect = new Map();
const _baseCanvas = [];
const _imgCache = new Map();
const _originalSource = [];

export function installVariantCompositor() {
  _uvRect.clear();
  const D = raw.drawables, uvs = D.vertexUvs, ti = D.textureIndices;
  for (let d = 0; d < D.count; d++) {
    const uv = uvs[d];
    let u0 = 1, u1 = 0, v0 = 1, v1 = 0;
    for (let k = 0; k < uv.length; k += 2) {
      const u = uv[k], v = uv[k + 1];
      if (u < u0) u0 = u; if (u > u1) u1 = u;
      if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    _uvRect.set(D.ids[d], { tex: ti[d], u0, v0, w: u1 - u0, h: v1 - v0, d });
  }
}

// clip to the cached mesh triangles, the atlas UV boxes overlap
const _meshPath = new Map();
function meshPath(id, W, H) {
  if (_meshPath.has(id)) return _meshPath.get(id);
  const r = _uvRect.get(id);
  const D = raw.drawables;
  const uv = D.vertexUvs[r.d], ix = D.indices[r.d];
  const p = new Path2D();
  for (let k = 0; k < ix.length; k += 3) {
    const a = ix[k] * 2, b = ix[k + 1] * 2, c = ix[k + 2] * 2;
    p.moveTo(uv[a] * W, (1 - uv[a + 1]) * H);
    p.lineTo(uv[b] * W, (1 - uv[b + 1]) * H);
    p.lineTo(uv[c] * W, (1 - uv[c + 1]) * H);
    p.closePath();
  }
  _meshPath.set(id, p);
  return p;
}

function _loadImg(url) {
  if (_imgCache.has(url)) return _imgCache.get(url);
  const p = new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = url;
  });
  // NEVER cache a failure. a bad load at startup has to stay retryable.
  p.catch(() => _imgCache.delete(url));
  _imgCache.set(url, p);
  return p;
}

// alphaClip variants want a hard on/off erase mask
function _alphaMask(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height);
  const px = d.data;
  for (let i = 3; i < px.length; i += 4) if (px[i]) px[i] = 255;
  x.putImageData(d, 0, 0);
  return c;
}

export function _baseAtlas(texIndex) {
  if (_baseCanvas[texIndex]) return _baseCanvas[texIndex];
  const bt = model.textures[texIndex].baseTexture;
  const src = bt.resource.source;
  _originalSource[texIndex] = src;
  const c = document.createElement('canvas');
  c.width = src.naturalWidth || src.width;
  c.height = src.naturalHeight || src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  _baseCanvas[texIndex] = c;
  return c;
}

// one drawing canvas per texture, reused, so we're not spawning new ones
const _liveCanvas = [];

function _uploadTexture(texIndex, canvas) {
  // tell pixi its cached GL texture is stale once we swap the source canvas
  const bt = model.textures[texIndex].baseTexture;
  bt.alphaMode = PIXI.ALPHA_MODES.PMA;
  const res = bt.resource;
  // we only swap the source. resource width and height are read only, setting
  // them throws in a module, and the canvas we draw into is already made at
  // the atlas's own size anyway.
  res.source = canvas;
  const uid = model.glContextID;
  if (uid >= 0 && bt._glTextures[uid]) {
    delete bt._glTextures[uid];
  }
  return true;
}

function _restoreOriginalTexture(texIndex, origSource) {
  const bt = model.textures[texIndex].baseTexture;
  bt.alphaMode = PIXI.ALPHA_MODES.PMA;
  const res = bt.resource;
  res.source = origSource;

  const uid = model.glContextID;
  if (uid >= 0 && bt._glTextures[uid]) {
    delete bt._glTextures[uid];
  }
}

function recompositeTexture(texIndex) {
  let hasOverride = false;
  for (const [id, entry] of _texOverride) {
    const r = _uvRect.get(id);
    if (r && r.tex === texIndex && entry) {
      hasOverride = true;
      break;
    }
  }

  if (!hasOverride) {
    const orig = _originalSource[texIndex];
    if (orig) {
      _restoreOriginalTexture(texIndex, orig);
      return;
    }
  }

  const base = _baseAtlas(texIndex), W = base.width, H = base.height;
  if (!_liveCanvas[texIndex]) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    _liveCanvas[texIndex] = c;
  }
  const c = _liveCanvas[texIndex];
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(base, 0, 0);
  const active = [];
  for (const [id, entry] of _texOverride) {
    const r = _uvRect.get(id);
    if (!r || r.tex !== texIndex || !entry) continue;
    // Cubism counts v from the BOTTOM, so the canvas origin has to flip
    active.push({ id, entry, x: r.u0 * W, yTop: (1 - (r.v0 + r.h)) * H, w: r.w * W, h: r.h * H });
  }
  // erase before painting or overlapping atlas regions wipe each other out
  for (const a of active) {
    if (a.entry.fullClear) {
      // placeholder art and bilinear bleed need the whole rect erased, padded
      const p = 8;
      ctx.clearRect(a.x - p, a.yTop - p, a.w + 2 * p, a.h + 2 * p);
      continue;
    }
    // decorations paint after the base
    if (a.entry.overlay) continue;
    ctx.save();
    ctx.clip(meshPath(a.id, W, H));
    if (a.entry.alphaClip) {
      // shared texels want a hard alpha erase or you get holes and dark edges
      if (!a.entry.mask) a.entry.mask = _alphaMask(a.entry.img);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(a.entry.mask, a.x, a.yTop, a.w, a.h);
      ctx.globalCompositeOperation = 'source-over';
    } else {
      ctx.clearRect(a.x, a.yTop, a.w, a.h);
    }
    ctx.restore();
  }
  // a mod that keeps its own colour on a drawable her skin or hair colour
  // normally tints has to have that uniform taken off it, because one
  // multiply covers the whole drawable and you can't spare the mod's pixels
  // from it. so the caller cleared the uniform and handed us the colour, and
  // the art underneath gets it here instead. mods.js does the same to its own
  // layers that wanted it.
  for (const a of active) {
    if (!a.entry.baseTint || a.entry.fullClear || !a.entry.overlay) continue;
    const x = Math.floor(a.x), y = Math.floor(a.yTop);
    const w = Math.ceil(a.x + a.w) - x, h = Math.ceil(a.yTop + a.h) - y;
    const t = document.createElement('canvas');
    t.width = w; t.height = h;
    const tc = t.getContext('2d');
    tc.drawImage(c, x, y, w, h, 0, 0, w, h);
    tc.globalCompositeOperation = 'multiply';
    tc.fillStyle = a.entry.baseTint;
    tc.fillRect(0, 0, w, h);
    // multiply floods the transparent texels too, cut it back to the art
    tc.globalCompositeOperation = 'destination-in';
    tc.drawImage(c, x, y, w, h, 0, 0, w, h);
    ctx.save();
    ctx.clip(meshPath(a.id, W, H));
    ctx.clearRect(x, y, w, h);
    ctx.drawImage(t, x, y);
    ctx.restore();
  }
  for (const a of active) {
    ctx.save();
    ctx.clip(meshPath(a.id, W, H));
    // the tiny decals are pixel art (the fruit panty logos) so keep them sharp
    if (a.entry.img.width < 64) ctx.imageSmoothingEnabled = false;
    ctx.drawImage(a.entry.img, a.x, a.yTop, a.w, a.h);
    ctx.restore();
  }
  _uploadTexture(texIndex, c);
  markDirty();
}

// atlas recomposites are async and every caller fires them without awaiting,
// which is fine on screen - the frame after the load just looks right. it is
// NOT fine for anything that reads pixels back, so keep a tail of the in-flight
// work for those callers to wait on. see Live2D.bakeThumb.
let _texWork = Promise.resolve();
const _track = (p) => { _texWork = _texWork.catch(() => {}).then(() => p); return p; };
export function texturesSettled() { return _texWork.catch(() => {}); }

export function setDrawableTexture(drawableId, url, overlay) {
  return _track(_setDrawableTexture(drawableId, url, overlay));
}
export function setDrawableTextures(map) {
  return _track(_setDrawableTextures(map));
}

async function _setDrawableTexture(drawableId, url, overlay) {
  const r = _uvRect.get(drawableId);
  if (!r) return;
  if (url) _texOverride.set(drawableId, { url, img: await _loadImg(url), overlay: !!overlay, alphaClip: false, fullClear: false });
  else _texOverride.delete(drawableId);
  recompositeTexture(r.tex);
}

async function _setDrawableTextures(map) {
  const texes = new Set();
  await Promise.all(Object.entries(map).map(async ([id, val]) => {
    const r = _uvRect.get(id);
    if (!r) return;
    const url = val && typeof val === 'object' ? val.url : val;
    const overlay = val && typeof val === 'object' ? !!val.overlay : false;
    const alphaClip = val && typeof val === 'object' ? !!val.alphaClip : false;
    const fullClear = val && typeof val === 'object' ? !!val.fullClear : false;
    const baseTint = val && typeof val === 'object' ? (val.baseTint || null) : null;
    // don't ship a 4k atlas up again when the outfit update changed nothing
    const prev = _texOverride.get(id);
    if (url) {
      if (prev && prev.url === url && prev.overlay === overlay &&
          prev.alphaClip === alphaClip && prev.fullClear === fullClear &&
          prev.baseTint === baseTint) return;
      // one bad image must NOT kill the whole batch, the other overrides
      // still have to land and get drawn
      let img;
      try { img = await _loadImg(url); }
      catch (e) { console.warn('texture load failed', id, url, e); return; }
      _texOverride.set(id, { url, img, overlay, alphaClip, fullClear, baseTint });
    } else {
      if (!prev) return;
      _texOverride.delete(id);
    }
    texes.add(r.tex);
  }));
  for (const t of texes) recompositeTexture(t);
}

export function setDrawableTint(id, rgb) {
  if (publicTint) publicTint.setMultiply(id, rgb);
}

export function getDrawableTint(id) {
  return publicTint ? publicTint.getMultiply(id) : null;
}

export function setDrawableScreen(id, rgb) {
  if (publicTint) publicTint.setScreen(id, rgb);
}

export function setDrawableOpacity(id, op) {
  if (publicTint) publicTint.setOpacity(id, op);
}

export function setDrawableOrderBelow(pairs) {
  if (publicTint) publicTint.setOrderBelow(pairs);
}
export function opacityByPattern(includes, excludes, op) {
  const ids = findDrawables(includes, excludes);
  for (const id of ids) setDrawableOpacity(id, op);
  return ids;
}
