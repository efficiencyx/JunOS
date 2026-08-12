// Same version rule as app.js. this file's <script type="module"> tags in
// wardrobe.html and karaoke.html, app.js's await import(), and every ?v=
// inside js/live2d/ all have to match, or the browser builds a second copy
// of the graph.

import { renderIfDirty, resetIdle, setFidgetsEnabled, setMood, setMouthOverride, startIdle, stopIdle, tick } from './live2d/anim.js?v=72';
import { cameraPreset, cameraStates, captureCameraState, currentCameraMode, fitModel, loadPos, measureStage, rendererResolution, savePos, setCameraPreset, watchStageSize, writeCameraStates } from './live2d/camera.js?v=72';
import { clamp, drawableAt, drawableThumb, faceAnchor, findDrawables, hitTest, isInteractiveTarget, isOverModel } from './live2d/geometry.js?v=72';
import { S } from './live2d/state.js?v=72';
import { installVariantCompositor, listDrawables, opacityByPattern, screenByPattern, setDrawableOpacity, setDrawableOrderBelow, setDrawableScreen, setDrawableTexture, setDrawableTextures, setDrawableTint, tintByPattern } from './live2d/textures.js?v=72';

const { Live2DModel, Cubism4ModelSettings } = PIXI.live2d;

export const LERP_TAU_MS = 150; // exponential smoothing time constant

// Motion, physics, breath and pose are all off on the internal model, so
// between a blink and a fidget the frame is the same as the one before. rAF
// with no cap draws it again at the screen's refresh rate anyway, these put
// a stop to that.
export let app = null;
export let model = null;
export let raw = null;            // raw Cubism core model (parts, parameters, drawables)
export let paramIndex = null;     // Map<paramId, idx>
export let paramMin = null;
export let paramMax = null;
export let paramDefault = null;

export const targetParams = new Map();   // paramId -> target value
export const currentValues = new Map();  // paramId -> current (lerped) value
export const loops = new Map();          // paramId -> { amplitude, period_ms, phase_start_ms, base }
export const pendingSequences = [];      // [{ param, value, fire_at_ms }]
export const forcedPartOpacity = new Map(); // partId -> opacity (re-stamped each tick)
export const forcedDrawableOpacity = new Map(); // drawableId -> opacity override
const drawableHighlights = new Map();    // drawableId -> screen RGB

export function markDirty() { S.needsRender = true; }
let onMissingParam = null;        // callback(name)
const reportedMissing = new Set();
export let publicTint = null;            // tinting API object, built in init()

function getRaw(m) {
  const cm = m.internalModel.coreModel;
  if (cm.parts && cm.parts.ids) return cm;
  if (cm._model && cm._model.parts) return cm._model;
  for (const k of Object.keys(cm)) {
    if (cm[k] && cm[k].parts && cm[k].parts.ids) return cm[k];
  }
  throw new Error('Cannot locate raw Cubism model');
}

function looksLikeCubismFrag(src) {
  return typeof src === 'string'
    && src.indexOf('s_texture0') >= 0
    && src.indexOf('u_baseColor') >= 0
    && /void\s+main\s*\(/.test(src);
}

function patchCubismFrag(src) {
  if (src.indexOf('u_multiplyColor') >= 0) return src;
  src = src.replace(
    /(uniform\s+vec4\s+u_baseColor\s*;)/,
    '$1\nuniform vec4 u_multiplyColor;\nuniform vec4 u_screenColor;'
  );
  // Scale screen colors by alpha or we end up coloring see through texels.
  const helper = '\nvec4 omegaTint(vec4 c) {\n'
    + '  c.rgb = min(c.rgb, vec3(c.a));\n'
    + '  c.rgb = c.rgb * u_multiplyColor.rgb;\n'
    + '  c.rgb = c.rgb + u_screenColor.rgb * c.a - c.rgb * u_screenColor.rgb;\n'
    + '  return c;\n'
    + '}\n';
  src = src.replace(
    /texture2D\s*\(\s*s_texture0\s*,\s*([^)]+)\)/g,
    'omegaTint(texture2D(s_texture0, $1))'
  );
  src = src.replace(/(void\s+main\s*\()/, helper + '$1');
  return src;
}

function installColorShaderPatch(gl) {
  if (!gl || gl.__omegaShaderPatched) return;
  gl.__omegaShaderPatched = true;
  const orig = gl.shaderSource;
  gl.shaderSource = function (shader, source) {
    if (looksLikeCubismFrag(source)) {
      try { source = patchCubismFrag(source); } catch (e) { console.warn('[Live2D] shader patch failed', e); }
    }
    return orig.call(this, shader, source);
  };
}

async function fetchAsDataURL(url, mime) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch ${url} failed: ${resp.status}`);
  const buf = await resp.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

async function init({ stageEl, onStatus, ignoreSavedPos }) {
  onStatus = onStatus || (() => { });
  onStatus('Initializing PIXI...');

  S.stageElement = stageEl;
  S.cameraMode = currentCameraMode();
  S.cameraPersistenceEnabled = !ignoreSavedPos;
  const initialSize = measureStage();

  // Drawing above 1x is already supersampling, which is what the soft edged
  // art wants. MSAA on top of it buys a multisampled backbuffer for nothing.
  const resolution = rendererResolution();

  app = new PIXI.Application({
    width: initialSize.width,
    height: initialSize.height,
    backgroundAlpha: 0,          // transparent canvas: model floats on the page background
    antialias: resolution < 2,
    autoDensity: true,
    resolution,
  });
  stageEl.appendChild(app.view);

  // pixi-live2d-display 0.4 ignores drawable colors, so we push in uniforms.
  installColorShaderPatch(app.renderer.gl);

  onStatus('Loading Live2D assets...');
  const [mocUrl, t0, t1, t2] = await Promise.all([
    fetchAsDataURL('assets/interaction_model.moc3', 'application/octet-stream'),
    fetchAsDataURL('assets/texture_00.png', 'image/png'),
    fetchAsDataURL('assets/texture_01.png', 'image/png'),
    fetchAsDataURL('assets/texture_02.png', 'image/png'),
  ]);
  const TRANSPARENT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';
  const textures = [t0, t1, t2];
  while (textures.length < 8) textures.push(TRANSPARENT);

  // The atlas we pulled out mixes two ways of storing transparency. in
  // premultiplied alpha the colour is already faded by it, in straight alpha it
  // is not, and this art has both along its edges. send it up as PMA, then fix up each sampled pixel in the
  // shader so neither kind can leave a bright or a dark fringe.
  for (const url of textures) {
    PIXI.BaseTexture.from(url, {
      alphaMode: PIXI.ALPHA_MODES.PMA,
      mipmap: PIXI.MIPMAP_MODES.OFF,
      wrapMode: PIXI.WRAP_MODES.CLAMP,
      scaleMode: PIXI.SCALE_MODES.LINEAR,
    });
  }

  const settings = new Cubism4ModelSettings({
    url: 'inline.model3.json',
    Version: 3,
    FileReferences: { Moc: mocUrl, Textures: textures },
  });

  onStatus('Building model...');
  // autoUpdate would hang the model's delta accumulator off
  // PIXI.Ticker.shared, a second rAF loop we can't set the pace for, so
  // tick() feeds it instead.
  model = await Live2DModel.from(settings, { autoInteract: false, autoUpdate: false });
  for (const texture of model.textures) {
    const baseTexture = texture.baseTexture;
    baseTexture.alphaMode = PIXI.ALPHA_MODES.PMA;
    baseTexture.update();
  }
  app.stage.addChild(model);

  const im = model.internalModel;
  try { im.motionManager.stopAllMotions(); } catch (e) { }
  try { im.motionManager.update = () => false; } catch (e) { }
  try { if (im.motionManager.expressionManager) im.motionManager.expressionManager.update = () => false; } catch (e) { }
  im.breath = null;
  im.eyeBlink = null;
  im.physics = null;
  im.pose = null;
  im.focusController = { update: () => { }, focus: () => { }, x: 0, y: 0 };

  raw = getRaw(model);
  S.drawableIndexById = null;
  paramIndex = new Map();
  paramMin = new Map(); paramMax = new Map(); paramDefault = new Map();
  for (let i = 0; i < raw.parameters.count; i++) {
    const id = raw.parameters.ids[i];
    paramIndex.set(id, i);
    paramMin.set(id, raw.parameters.minimumValues[i]);
    paramMax.set(id, raw.parameters.maximumValues[i]);
    paramDefault.set(id, raw.parameters.defaultValues[i]);
    currentValues.set(id, raw.parameters.defaultValues[i]);
  }

  installVariantCompositor();

  const importedLegacy = loadPos();
  if (ignoreSavedPos) { S.userOffsetX = 0; S.userOffsetY = 0; S.userZoom = 1; S.hasUserPos = true; }
  fitModel();
  if (importedLegacy) {
    cameraStates.desktop = captureCameraState();
    S.legacyDesktopCamera = null;
    writeCameraStates();
  }
  watchStageSize();

  window.addEventListener('wheel', (e) => {
    if (cameraPreset === 'face') return;
    if (document.body.classList.contains('sidebar-open')) return;
    if (isInteractiveTarget(e.target)) return;
    if (!isOverModel(e.clientX, e.clientY)) return;
    e.preventDefault();
    if (e.shiftKey) {
      const desired = Math.max(0.2, Math.min(5, S.userZoom * Math.exp(-e.deltaY * 0.00025)));
      const factor = desired / S.userZoom;
      S.userZoom = desired;
      S.userOffsetX *= factor;
      S.userOffsetY *= factor;
    } else {
      S.userOffsetY -= e.deltaY * 0.25;
    }
    S.hasUserPos = true;
    fitModel();
    savePos();
  }, { passive: false });

  let dragging = false, dragMoved = false, dragPointerId = -1;
  let dragPX = 0, dragPY = 0, dragOX = 0, dragOY = 0;
  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (dragging) return;
    if (cameraPreset === 'face') return;
    if (document.body.classList.contains('wardrobe-open')) return;
    if (document.body.classList.contains('sidebar-open')) return;
    if (isInteractiveTarget(e.target)) return;
    if (!isOverModel(e.clientX, e.clientY)) return;
    if (e.pointerType === 'touch') e.preventDefault();
    dragging = true;
    dragMoved = false;
    dragPointerId = e.pointerId;
    dragPX = e.clientX; dragPY = e.clientY;
    dragOX = S.userOffsetX; dragOY = S.userOffsetY;
    try { e.target.setPointerCapture(e.pointerId); } catch (err) { }
  });
  window.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== dragPointerId) return;
    if (document.body.classList.contains('l2d-touch-pending') || document.body.classList.contains('l2d-touching')) return;
    const dx = e.clientX - dragPX;
    const dy = e.clientY - dragPY;
    if (!dragMoved) {
      if (Math.hypot(dx, dy) < 4) return;
      dragMoved = true;
      S.hasUserPos = true;
      document.body.classList.add('l2d-dragging');
    }
    S.userOffsetX = dragOX + dx;
    S.userOffsetY = dragOY + dy;
    fitModel();
  });
  const endDrag = (e) => {
    if (!dragging || e.pointerId !== dragPointerId) return;
    const moved = dragMoved;
    dragging = false;
    dragMoved = false;
    dragPointerId = -1;
    document.body.classList.remove('l2d-dragging');
    if (moved) savePos();
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  // Application puts its own render in at UPDATE_PRIORITY.LOW, so swap it for
  // one that works out whether the frame is worth drawing at all. same
  // priority, so the camera tween still lands before the draw and not a frame
  // after it.
  app.ticker.remove(app.render, app);
  app.ticker.add(tick);
  app.ticker.add(renderIfDirty, null, PIXI.UPDATE_PRIORITY.LOW);

  let forcedOrderBelow = [];               // [belowId, aboveId] pairs, re-applied each frame
  const forcedMultiplyColor = new Map();   // drawableId -> [r,g,b,a]
  const forcedScreenColor = new Map();     // drawableId -> [r,g,b,a]
  const r = model.internalModel.renderer;
  const gl = app.renderer.gl;
  const ONE = [1, 1, 1, 1];
  const ZERO = [0, 0, 0, 1];
  const uniformLocCache = new WeakMap(); // glProgram -> { mloc, sloc }

  if (r && r.doDrawModel && r.drawMesh && !r.__omegaPatched) {
    r.__omegaPatched = true;

    const visibleOrder = [];
    let drawCursor = 0;
    let currentDrawableId = null;   // set in drawMesh, read in drawElements hook

    const origDoDrawModel = r.doDrawModel.bind(r);
    r.doDrawModel = function () {
      const d = raw.drawables;
      if (d && d.opacities && forcedDrawableOpacity.size) {
        for (const [id, op] of forcedDrawableOpacity) {
          const i = d.ids.indexOf(id);
          if (i < 0) continue;
          d.opacities[i] = op;
          // Put back the visibility Cubism clears on zero opacity outfits.
          if (op > 0.0001) d.dynamicFlags[i] |= 0x01;
        }
      }
      // Do the overrides before our sort and Cubism's sort both run.
      if (d && forcedOrderBelow.length) {
        const ro = d.renderOrders;
        for (const [below, above] of forcedOrderBelow) {
          const bi = d.ids.indexOf(below), ai = d.ids.indexOf(above);
          if (bi >= 0 && ai >= 0 && ro[bi] > ro[ai]) {
            const t = ro[bi]; ro[bi] = ro[ai]; ro[ai] = t;
          }
        }
      }
      visibleOrder.length = 0;
      if (d) {
        const tmp = [];
        for (let i = 0; i < d.count; i++) {
          // Cubism goes by visibility, not opacity. match it or tints slip.
          const visible = (d.dynamicFlags[i] & 0x01) !== 0;
          if (visible) tmp.push(i);
        }
        tmp.sort((a, b) => d.renderOrders[a] - d.renderOrders[b]);
        for (let k = 0; k < tmp.length; k++) visibleOrder.push(tmp[k]);
      }
      drawCursor = 0;
      return origDoDrawModel();
    };

    const origDrawMesh = r.drawMesh.bind(r);
    r.drawMesh = function () {
      const isMaskPass = !!r._clippingContextBufferForMask;
      if (!isMaskPass) {
        const drawableIdx = visibleOrder[drawCursor++];
        currentDrawableId = drawableIdx !== undefined ? raw.drawables.ids[drawableIdx] : null;
      } else {
        currentDrawableId = null;
      }
      try {
        return origDrawMesh.apply(this, arguments);
      } finally {
        currentDrawableId = null;
      }
    };

    // Cubism binds its shader inside drawMesh, so set the uniforms then.
    const origDrawElements = gl.drawElements;
    gl.drawElements = function (mode, count, type, offset) {
      const prog = gl.getParameter(gl.CURRENT_PROGRAM);
      if (prog) {
        let cache = uniformLocCache.get(prog);
        if (!cache) {
          cache = {
            mloc: gl.getUniformLocation(prog, 'u_multiplyColor'),
            sloc: gl.getUniformLocation(prog, 'u_screenColor'),
          };
          uniformLocCache.set(prog, cache);
        }
        if (cache.mloc || cache.sloc) {
          const mc = (currentDrawableId && forcedMultiplyColor.get(currentDrawableId)) || ONE;
          const baseScreen = (currentDrawableId && forcedScreenColor.get(currentDrawableId)) || ZERO;
          const highlight = currentDrawableId && drawableHighlights.get(currentDrawableId);
          const sc = highlight
            ? [
              1 - (1 - baseScreen[0]) * (1 - highlight[0]),
              1 - (1 - baseScreen[1]) * (1 - highlight[1]),
              1 - (1 - baseScreen[2]) * (1 - highlight[2]),
              1,
            ]
            : baseScreen;
          if (cache.mloc) gl.uniform4f(cache.mloc, mc[0], mc[1], mc[2], mc[3]);
          if (cache.sloc) gl.uniform4f(cache.sloc, sc[0], sc[1], sc[2], sc[3]);
        }
      }
      return origDrawElements.call(this, mode, count, type, offset);
    };
  }

  publicTint = {
    setMultiply(drawableId, rgb) {
      if (rgb) forcedMultiplyColor.set(drawableId, [rgb[0], rgb[1], rgb[2], 1]);
      else forcedMultiplyColor.delete(drawableId);
      markDirty();
    },
    setScreen(drawableId, rgb) {
      if (rgb) forcedScreenColor.set(drawableId, [rgb[0], rgb[1], rgb[2], 1]);
      else forcedScreenColor.delete(drawableId);
      markDirty();
    },
    setHighlight(drawableId, rgb) {
      if (rgb) drawableHighlights.set(drawableId, [rgb[0], rgb[1], rgb[2]]);
      else drawableHighlights.delete(drawableId);
      markDirty();
    },
    setOpacity(drawableId, op) {
      if (op == null) forcedDrawableOpacity.delete(drawableId);
      else forcedDrawableOpacity.set(drawableId, op);
      markDirty();
    },
    listDrawables() { return Array.from(raw.drawables.ids); },
    setOrderBelow(pairs) { forcedOrderBelow = pairs || []; markDirty(); },
  };

  window.__l2d = {
    model, raw,
    hide(name) { forcedDrawableOpacity.set(name, 0); markDirty(); },
    show(name) { forcedDrawableOpacity.delete(name); markDirty(); },
    hideAll() { for (const id of raw.drawables.ids) forcedDrawableOpacity.set(id, 0); markDirty(); },
    showAll() { forcedDrawableOpacity.clear(); markDirty(); },
    listDrawables() { return Array.from(raw.drawables.ids); },
    hideRange(from, to) {
      const ids = raw.drawables.ids;
      for (let i = from; i < to && i < ids.length; i++) forcedDrawableOpacity.set(ids[i], 0);
      markDirty();
    },
    visibleDrawables() {
      const out = [];
      const ops = raw.drawables.opacities, ids = raw.drawables.ids;
      for (let i = 0; i < raw.drawables.count; i++) if (ops[i] > 0.01) out.push([ids[i], ops[i]]);
      return out;
    },
    tint(name, rgb) { forcedMultiplyColor.set(name, [rgb[0], rgb[1], rgb[2], 1]); markDirty(); },
    untint(name) { forcedMultiplyColor.delete(name); markDirty(); },
    screenTint(name, rgb) { forcedScreenColor.set(name, [rgb[0], rgb[1], rgb[2], 1]); markDirty(); },
    unscreen(name) { forcedScreenColor.delete(name); markDirty(); },
  };

  onStatus(`OK - ${raw.parameters.count} params, ${raw.parts.count} parts`);
  return { paramIds: Array.from(paramIndex.keys()) };
}

function setOnMissingParam(cb) { onMissingParam = cb; }

function knows(param) { return paramIndex.has(param); }

function reportMissing(param) {
  if (reportedMissing.has(param)) return;
  reportedMissing.add(param);
  if (onMissingParam) onMissingParam(param);
}

function setTarget(param, value) {
  if (!paramIndex.has(param)) { reportMissing(param); return false; }
  targetParams.set(param, clamp(param, value));
  markDirty();
  return true;
}

function setNow(param, value) {
  if (!setTarget(param, value)) return false;
  currentValues.set(param, clamp(param, value));
  return true;
}

function cancelPending(paramPrefix) {
  for (let i = pendingSequences.length - 1; i >= 0; i--) {
    if (pendingSequences[i].param.startsWith(paramPrefix)) pendingSequences.splice(i, 1);
  }
}

export function startLoop(param, amplitude, period_ms, base) {
  if (!paramIndex.has(param)) { reportMissing(param); return false; }
  if (base === undefined) base = paramDefault.get(param) || 0;
  loops.set(param, {
    amplitude,
    period_ms: Math.max(50, period_ms),
    phase_start_ms: performance.now(),
    base,
  });
  return true;
}

export function stopLoop(param) {
  loops.delete(param);
  markDirty();
}

function stopAllLoops() {
  loops.clear();
  markDirty();
}

export function scheduleSequence(steps) {
  let t = performance.now();
  for (const step of steps) {
    const dt = step.dt_ms || 0;
    t += dt;
    for (const [param, value] of Object.entries(step.params || {})) {
      if (!paramIndex.has(param)) { reportMissing(param); continue; }
      pendingSequences.push({ param, value: clamp(param, value), fire_at_ms: t });
    }
  }
}

function debugParam(param) {
  if (!paramIndex.has(param)) return { error: 'unknown param' };
  const idx = paramIndex.get(param);
  return {
    target: targetParams.get(param),
    current: currentValues.get(param),
    live: raw ? raw.parameters.values[idx] : undefined,
    min: paramMin.get(param), max: paramMax.get(param), def: paramDefault.get(param),
  };
}

// The classic scripts loader.js pulls in get to the renderer through this.
window.Live2D = {
  init,
  setTarget,
  setNow,
  cancelPending,
  startLoop,
  stopLoop,
  stopAllLoops,
  scheduleSequence,
  resetIdle,
  startIdle,
  stopIdle,
  setFidgetsEnabled,
  setMood,
  knows,
  setOnMissingParam,
  fitModel,
  setCameraPreset,
  debugParam,
  tintByPattern,
  screenByPattern,
  findDrawables,
  listDrawables,
  setDrawableTint,
  setDrawableScreen,
  setDrawableHighlight(drawableId, rgb) {
    if (publicTint) publicTint.setHighlight(drawableId, rgb);
  },
  setDrawableOpacity,
  setDrawableOrderBelow,
  opacityByPattern,
  setDrawableTexture,
  setDrawableTextures,
  setMouthOverride,
  isOverModel,
  faceAnchor,
  drawableAt,
  hitTest,
  drawableThumb,
};
