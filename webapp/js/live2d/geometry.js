import { app, forcedDrawableOpacity, model, paramMax, paramMin, publicTint, raw } from '../live2d.js?v=1';
import { S } from './state.js?v=1';
import { _baseAtlas, _uvRect } from './textures.js?v=1';

export function clamp(id, v) {
  const lo = paramMin.get(id), hi = paramMax.get(id);
  if (lo === undefined) return v;
  return Math.max(lo, Math.min(hi, v));
}

const MOUTH_DRAWABLES = ['HitAreaOpenMouth', 'HitAreaCloseMouth', 'InnerMouth', 'SkinLipUpper'];
const FACE_DRAWABLES = ['HitAreaFaceStroke', 'SkinFace', 'ModdableFace'];

// Inverse of toModelPoint: Cubism units (y up) -> client px.
function fromModelPoint(x, y) {
  const ci = raw.canvasinfo;
  const p = new PIXI.Point(x * ci.PixelsPerUnit + ci.CanvasOriginX, ci.CanvasOriginY - y * ci.PixelsPerUnit);
  model.internalModel.localTransform.apply(p, p);
  model.transform.worldTransform.apply(p, p);
  const r = app.view.getBoundingClientRect();
  return { x: r.left + p.x, y: r.top + p.y };
}

function drawableBox(candidates) {
  const D = raw.drawables;
  if (!S.drawableIndexById) {
    S.drawableIndexById = new Map();
    for (let k = 0; k < D.count; k++) S.drawableIndexById.set(D.ids[k], k);
  }
  for (const id of candidates) {
    const i = S.drawableIndexById.get(id);
    if (i === undefined) continue;
    const vp = D.vertexPositions[i];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < vp.length; k += 2) {
      if (vp[k] < minX) minX = vp[k];
      if (vp[k] > maxX) maxX = vp[k];
      if (vp[k + 1] < minY) minY = vp[k + 1];
      if (vp[k + 1] > maxY) maxY = vp[k + 1];
    }
    if (minX === Infinity) continue;
    const tl = fromModelPoint(minX, maxY);
    const br = fromModelPoint(maxX, minY);
    return { left: tl.x, top: tl.y, right: br.x, bottom: br.y };
  }
  return null;
}

export function faceAnchor() {
  if (!model || !app) return null;
  const r = app.view.getBoundingClientRect();
  const b = model.getBounds();
  const anchor = {
    x: r.left + b.x + b.width / 2,
    y: r.top + b.y + b.height * 0.09,
    headW: Math.max(b.width * 0.30, b.height * 0.12),
    modelW: b.width,
    modelH: b.height,
    mouth: null,
  };
  const mouth = raw && drawableBox(MOUTH_DRAWABLES);
  if (mouth) {
    const x = (mouth.left + mouth.right) / 2;
    const face = drawableBox(FACE_DRAWABLES) || mouth;
    anchor.mouth = {
      x,
      y: (mouth.top + mouth.bottom) / 2,
      gap: Math.max(x - face.left, face.right - x, 24),
    };
  }
  return anchor;
}

export function isOverModel(clientX, clientY) {
  if (!model || !app) return false;
  const r = app.view.getBoundingClientRect();
  const x = clientX - r.left, y = clientY - r.top;
  const b = model.getBounds();
  const hw = b.width * 0.5;
  const hx = b.x + (b.width - hw) / 2;
  return x >= hx && x <= hx + hw && y >= b.y && y <= b.y + b.height;
}

export function isInteractiveTarget(t) {
  return !!(t && t.closest && t.closest(
    'button, a, input, textarea, select, .composer, .conv-sidebar, .settings-drawer, .app-header, .prompt-chips, .wardrobe-overlay, .face-bubble, .sidebar-backdrop'
  ));
}

export function findDrawables(includes, excludes) {
  if (!publicTint) return [];
  const inc = (includes || []).map(s => s.toLowerCase());
  const exc = (excludes || []).map(s => s.toLowerCase());
  const out = [];
  for (const id of publicTint.listDrawables()) {
    const lo = id.toLowerCase();
    if (!inc.some(p => lo.includes(p))) continue;
    if (exc.some(p => lo.includes(p))) continue;
    out.push(id);
  }
  return out;
}

function toModelPoint(clientX, clientY) {
  const rect = app.view.getBoundingClientRect();
  const p = model.toModelPosition(new PIXI.Point(clientX - rect.left, clientY - rect.top));
  // Convert model-canvas pixels (y down) to Cubism coordinates (y up).
  const ci = raw.canvasinfo;
  p.x = (p.x - ci.CanvasOriginX) / ci.PixelsPerUnit;
  p.y = (ci.CanvasOriginY - p.y) / ci.PixelsPerUnit;
  return p;
}

function pointInMesh(D, i, p) {
  const vp = D.vertexPositions[i], ix = D.indices[i];
  for (let k = 0; k < ix.length; k += 3) {
    const a = ix[k] * 2, b = ix[k + 1] * 2, c = ix[k + 2] * 2;
    const s1 = (vp[b] - vp[a]) * (p.y - vp[a + 1]) - (vp[b + 1] - vp[a + 1]) * (p.x - vp[a]);
    const s2 = (vp[c] - vp[b]) * (p.y - vp[b + 1]) - (vp[c + 1] - vp[b + 1]) * (p.x - vp[b]);
    const s3 = (vp[a] - vp[c]) * (p.y - vp[c + 1]) - (vp[a + 1] - vp[c + 1]) * (p.x - vp[c]);
    if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return true;
  }
  return false;
}

// Checks a point against certain drawables even when they are hidden, for the
// model's invisible HitArea* meshes.
export function hitTest(clientX, clientY, ids) {
  if (!model || !raw || !app) return null;
  const p = toModelPoint(clientX, clientY);
  const D = raw.drawables;
  for (let i = 0; i < D.count; i++) {
    if (ids.has(D.ids[i]) && pointInMesh(D, i, p)) return D.ids[i];
  }
  return null;
}

export function drawableAt(clientX, clientY, onlyIds, tolerancePx) {
  if (!model || !raw || !app) return null;
  const rect = app.view.getBoundingClientRect();
  const p = toModelPoint(clientX, clientY);
  const ci = raw.canvasinfo;
  const D = raw.drawables;
  const only = onlyIds ? (onlyIds instanceof Set ? onlyIds : new Set(onlyIds)) : null;
  const candidates = [];
  let best = null, bestOrder = -Infinity;
  for (let i = 0; i < D.count; i++) {
    if (only && !only.has(D.ids[i])) continue;
    const forcedOpacity = forcedDrawableOpacity.get(D.ids[i]);
    const opacity = forcedOpacity == null ? D.opacities[i] : forcedOpacity;
    // Take in layers the renderer is holding visible.
    const visible = (D.dynamicFlags[i] & 0x01) || (forcedOpacity != null && forcedOpacity > 0.0001);
    if (!visible || opacity < 0.01) continue;
    candidates.push(i);
    if (D.renderOrders[i] <= bestOrder) continue;
    if (pointInMesh(D, i, p)) { best = D.ids[i]; bestOrder = D.renderOrders[i]; }
  }
  if (best || !tolerancePx) return best;
  // Nothing exactly under the cursor, so fall back to padded boxes. the
  // smallest box wins, or a big garment would swallow a thin accessory.
  const q = model.toModelPosition(new PIXI.Point(clientX - rect.left + tolerancePx, clientY - rect.top));
  const tol = Math.abs((q.x - ci.CanvasOriginX) / ci.PixelsPerUnit - p.x);
  let bestArea = Infinity;
  for (const i of candidates) {
    const vp = D.vertexPositions[i];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < vp.length; k += 2) {
      if (vp[k] < minX) minX = vp[k];
      if (vp[k] > maxX) maxX = vp[k];
      if (vp[k + 1] < minY) minY = vp[k + 1];
      if (vp[k + 1] > maxY) maxY = vp[k + 1];
    }
    if (p.x < minX - tol || p.x > maxX + tol || p.y < minY - tol || p.y > maxY + tol) continue;
    const area = (maxX - minX) * (maxY - minY);
    if (area < bestArea) { bestArea = area; best = D.ids[i]; }
  }
  return best;
}

export function drawableThumb(drawableId, size = 72) {
  const r = _uvRect.get(drawableId);
  if (!r || !model) return null;
  const base = _baseAtlas(r.tex), W = base.width, H = base.height;
  const w = Math.max(1, r.w * W), h = Math.max(1, r.h * H);
  const s = Math.min(size / w, size / h, 1);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  c.getContext('2d').drawImage(base, r.u0 * W, (1 - (r.v0 + r.h)) * H, w, h, 0, 0, c.width, c.height);
  return c.toDataURL();
}
