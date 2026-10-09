// same version rule as app.js. every import of this file and
// every ?v= inside js/live2d/ ALL have to match, or the browser
// builds a second copy of the module graph, and the two copies
// don't share state.

import { resetIdle, renderIfDirty, setFidgetsEnabled, setMood, setMouthOverride, startIdle, stopIdle, tick } from './anim.js?v=76';
import { bakeThumb } from './bake.js?v=1';
import { cameraStates, captureCameraState, currentCameraMode, fitModel, loadPos, measureStage, rendererResolution, setCameraPreset as setRigCameraPreset, watchStageSize, writeCameraStates } from './camera.js?v=75';
import { drawableAt, faceAnchor, findDrawables, hitTest, isOverModel } from './geometry.js?v=75';
import { installStageInput } from './input.js?v=3';
import { mountPlaceholder, setPlaceholderPreset } from './placeholder.js?v=2';
import { cancelPending, debugParam, knows, scheduleSequence, setNow, setOnMissingParam, setTarget, startLoop, stopAllLoops, stopLoop } from './params.js?v=2';
import { installColorShaderPatch, patchRenderer } from './renderer.js?v=1';
import { S, app, currentValues, model, paramDefault, paramIndex, paramMax, paramMin, publicTint, raw, setApp, setModel, setParamRanges, setRaw } from './state.js?v=11';
import { drawableThumb, getDrawableTint, installVariantCompositor, listDrawables, opacityByPattern, screenByPattern, setDrawableOpacity, setDrawableOrderBelow, setDrawableScreen, setDrawableTexture, setDrawableTextures, setDrawableTint, texturesSettled, tintByPattern } from './textures.js?v=75';

export {
  bakeThumb, cancelPending, debugParam, drawableAt, drawableThumb, faceAnchor, findDrawables, fitModel,
  getDrawableTint, hitTest, isOverModel, knows, listDrawables, opacityByPattern, resetIdle, scheduleSequence,
  screenByPattern, setDrawableOpacity, setDrawableOrderBelow, setDrawableScreen,
  setDrawableTexture, setDrawableTextures, setDrawableTint, setFidgetsEnabled, setMood, setMouthOverride,
  setNow, setOnMissingParam, setTarget, startIdle, startLoop, stopAllLoops, stopIdle, stopLoop,
  texturesSettled, tintByPattern,
};

function getRaw(m) {
  const cm = m.internalModel.coreModel;
  if (cm.parts && cm.parts.ids) return cm;
  if (cm._model && cm._model.parts) return cm._model;
  for (const k of Object.keys(cm)) {
    if (cm[k] && cm[k].parts && cm[k].parts.ids) return cm[k];
  }
  throw new Error('Cannot locate raw Cubism model');
}


export function hasModel() { return !!model; }

export function setCameraPreset(preset) {
  if (model) setRigCameraPreset(preset);
  else setPlaceholderPreset(preset);
}

// anything but a clear "no" means try the real rig, so a probe
// that 500s still lands on the loud error path and doesn't hide
// behind the placeholder
async function rigInstalled() {
  try {
    const r = await fetch('api/assets.php?probe', { credentials: 'same-origin' });
    if (!r.ok) return true;
    return (await r.json()).model !== false;
  } catch (e) {
    return true;
  }
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
export async function init({ stageEl, onStatus, ignoreSavedPos }) {
  const { Live2DModel, Cubism4ModelSettings } = PIXI.live2d;
  onStatus = onStatus || (() => { });

  S.stageElement = stageEl;
  S.cameraMode = currentCameraMode();
  S.cameraPersistenceEnabled = !ignoreSavedPos;

  if (!await rigInstalled()) {
    // empty maps, not null. every setTarget/startLoop then just
    // says no and the rest of the page never has to know
    setParamRanges(new Map(), new Map(), new Map(), new Map());
    mountPlaceholder(stageEl);
    onStatus('Live2D assets not installed, placeholder art');
    return { paramIds: [], placeholder: true };
  }

  onStatus('Initializing PIXI...');
  const initialSize = measureStage();

  // drawing at 2x is already supersampling, which is what the
  // soft edged art wants. MSAA (the GPU's own edge smoothing) on
  // top of that buys a multisampled backbuffer for nothing, so it
  // only goes on below 2x.
  const resolution = rendererResolution();

  setApp(new PIXI.Application({
    width: initialSize.width,
    height: initialSize.height,
    backgroundAlpha: 0,
    antialias: resolution < 2,
    autoDensity: true,
    resolution,
  }));
  stageEl.appendChild(app.view);

  // pixi-live2d-display 0.4 just ignores drawable colors, so we
  // push uniforms
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

  // the atlas (the texture sheets every part is cut from) mixes
  // premultiplied alpha, transparency already baked into the
  // colours, with straight alpha where it isn't. send it as PMA
  // and fix each sample in the shader, otherwise one kind gets a
  // bright fringe and the other gets a dark one.
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
  // autoUpdate hangs the model's delta accumulator off
  // PIXI.Ticker.shared, a second rAF loop we can't set the pace
  // for. no thanks. tick() feeds it instead.
  setModel(await Live2DModel.from(settings, { autoInteract: false, autoUpdate: false }));
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

  setRaw(getRaw(model));
  S.drawableIndexById = null;
  setParamRanges(new Map(), new Map(), new Map(), new Map());
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

  installStageInput();

  // motion, physics, breath and pose are off. between animations
  // the frame doesn't change, but rAF redraws it at screen refresh
  // rate anyway. renderIfDirty skips those identical frames.
  // Application shoves its own render in at UPDATE_PRIORITY.LOW, so
  // swap it for one that works out whether the frame is worth
  // drawing at all. same priority, so the camera tween still lands
  // before the draw and not a frame after it.
  app.ticker.remove(app.render, app);
  app.ticker.add(tick);
  app.ticker.add(renderIfDirty, null, PIXI.UPDATE_PRIORITY.LOW);

  patchRenderer();

  onStatus(`OK - ${raw.parameters.count} params, ${raw.parts.count} parts`);
  return { paramIds: Array.from(paramIndex.keys()) };
}

export function setDrawableHighlight(drawableId, rgb) {
  if (publicTint) publicTint.setHighlight(drawableId, rgb);
}
