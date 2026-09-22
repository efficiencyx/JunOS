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

// tau, the smoothing time constant: how fast params approach
// targets
export const LERP_TAU_MS = 150;

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
export const loops = new Map();
export const pendingSequences = [];
export const forcedPartOpacity = new Map();
export const forcedDrawableOpacity = new Map();

// tints, drawable opacity and order, rebuilt atlases and the
// camera transform never go through the parameter array. nothing
// else tells the renderer the canvas is stale, so everything that
// touches those has to come through here.
export function markDirty() { S.needsRender = true; }
