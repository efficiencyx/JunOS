export const S = {
  cameraMode: 'desktop',
  cameraPersistenceEnabled: true,
  drawableIndexById: null,
  // a loaded position counts too, or fitModel piles its rest offset
  // on top
  hasUserPos: false,
  legacyDesktopCamera: null,
  needsRender: true,
  stageElement: null,
  userOffsetX: 0,
  userOffsetY: 0,
  userZoom: 1,
};

// the loaded model and everything read off it. init() in
// live2d.js fills these in through the setters below, once,
// every other module only reads them.
export let app = null;
export let model = null;
// the Cubism core model, its parts, parameters and drawables
// (a drawable is one textured mesh of the rig)
export let raw = null;
export let paramIndex = null;
export let paramMin = null;
export let paramMax = null;
export let paramDefault = null;
export let publicTint = null;

export function setApp(value) { app = value; }
export function setModel(value) { model = value; }
export function setRaw(value) { raw = value; }
export function setParamRanges(index, min, max, def) {
  paramIndex = index;
  paramMin = min;
  paramMax = max;
  paramDefault = def;
}
export function setPublicTint(value) { publicTint = value; }

export const targetParams = new Map();
export const currentValues = new Map();
// per param, units per second. the smoothing is a spring, so it
// needs to remember how fast each param was already going
export const velocities = new Map();
// param -> performance.now() deadline. a tag or a fidget owns the
// param until then, after that idle takes it back
export const holds = new Map();
export const loops = new Map();
export const pendingSequences = [];
export const forcedPartOpacity = new Map();
export const forcedDrawableOpacity = new Map();

// tints, drawable opacity and order, rebuilt atlases and the
// camera transform never go through the parameter array. nothing
// else tells the renderer the canvas is stale, so everything that
// touches those has to come through here.
export function markDirty() { S.needsRender = true; }
