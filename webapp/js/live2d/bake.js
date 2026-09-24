import { app, currentValues, forcedDrawableOpacity, markDirty, model, paramIndex, raw, targetParams } from './state.js?v=11';

// how tall the model is rendered for a bake, in pixels. the
// model's bounds run several times taller than anything drawn
// inside them, so one garment lands on maybe a tenth of this.
// 2400 is what keeps a cropped tile above 256px and sharp. the
// extract never reaches the screen, so this has nothing to do
// with the camera, and it's transient: ~23MB of pixels, one shot
// at a time.
const BAKE_HEIGHT = 2400;

// pixi's extract crops to the display object's bounds, and a
// Cubism model's bounds are its whole rect no matter which
// drawables are actually on. so find the ink ourselves: walk the
// alpha channel for the tightest box holding anything visible.
function alphaBounds(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] < 8) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// drawableThumb crops the texture atlas by one drawable's UV
// rect (its box on the atlas), so a skirt tile from it is a
// single wedge of cloth. a garment is a pile of drawables and the
// atlas doesn't assemble them. this renders the actual model with
// everything but the garment forced to zero opacity, and
// alphaBounds crops to what's left over. so the tile is the item,
// layered and deformed the way she really wears it.
export function bakeThumb(keepIds, maxSize = 192) {
  if (!app || !model || !raw) return null;
  const keep = keepIds instanceof Set ? keepIds : new Set(keepIds);
  if (!keep.size) return null;
  const savedOpacity = new Map(forcedDrawableOpacity);
  const savedScale = model.scale.x;
  try {
    // hide the rest and DON'T touch the keepers, in either
    // direction. forcing them to 1 drags in whatever the pattern
    // match over-caught. 'dress' also matches Dress1's meshes, so
    // the alt dress turns up in the plain dress's shot and both
    // tiles come out identical. clearing them instead is just as
    // wrong: half the wardrobe (bikini, stockings, ears, hair) is
    // shown by a forced opacity, so dropping it hides the very
    // thing being photographed.
    for (const id of raw.drawables.ids) {
      if (!keep.has(id)) forcedDrawableOpacity.set(id, 0);
    }
    const unscaled = model.height / (model.scale.y || 1);
    if (unscaled > 0) model.scale.set(BAKE_HEIGHT / unscaled);
    model.updateTransform();
    // every item param eases toward its target over LERP_TAU_MS, and
    // a bake is one frame. so jump the smoothing to the target first,
    // otherwise the garment is still fading up when the shot goes off
    // and most tiles come back empty.
    for (const [id, target] of targetParams) {
      currentValues.set(id, target);
      const idx = paramIndex.get(id);
      if (idx !== undefined) raw.parameters.values[idx] = target;
    }
    // forced opacities land in doDrawModel, but the parameters only
    // reach the drawables when update() gets a nonzero dt
    model.update(16);
    const extract = app.renderer.plugins ? app.renderer.plugins.extract : app.renderer.extract;
    const src = extract.canvas(model);
    if (!src.width || !src.height) return null;
    const box = alphaBounds(src.getContext('2d'), src.width, src.height);
    if (!box) return null;
    const s = Math.min(maxSize / box.w, maxSize / box.h);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(box.w * s));
    c.height = Math.max(1, Math.round(box.h * s));
    c.getContext('2d').drawImage(src, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
    return c.toDataURL();
  } catch (e) {
    console.warn('bakeThumb failed', e);
    return null;
  } finally {
    forcedDrawableOpacity.clear();
    for (const [id, op] of savedOpacity) forcedDrawableOpacity.set(id, op);
    model.scale.set(savedScale);
    model.updateTransform();
    markDirty();
  }
}
