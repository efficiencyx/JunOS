import { app, markDirty, model } from '../live2d.js?v=61';
import { S } from './state.js?v=61';

const CAMERA_STORAGE_KEY = 'l2d.camera';
const CAMERA_STORAGE_VERSION = 2;
export let cameraStates = { phone: null, desktop: null };
let stageResizeObserver = null;
let stageResizeFrame = 0;
let visualRefitPending = false;
let removeViewportSubscription = null;
let lastUsableStage = null;
let lastFittedScreen = null;

function boundNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function currentCameraMode() {
  try {
    return window.MobileViewport && window.MobileViewport.isPhone() ? 'phone' : 'desktop';
  } catch (e) {
    return 'desktop';
  }
}

// Fill rate scales with the square of this, and every clipping mask is
// rasterized at it too. Phone already capped here; desktop had no ceiling.
const MAX_RESOLUTION = 2;

export function rendererResolution() {
  return Math.min(MAX_RESOLUTION, window.devicePixelRatio || 1);
}

export function measureStage() {
  const rect = S.stageElement && S.stageElement.getBoundingClientRect();
  const width = rect && rect.width ? rect.width : (S.stageElement && S.stageElement.clientWidth) || window.innerWidth;
  const height = rect && rect.height ? rect.height : (S.stageElement && S.stageElement.clientHeight) || window.innerHeight;
  return {
    width: Math.max(1, Math.round(width || 1)),
    height: Math.max(1, Math.round(height || 1)),
  };
}

function stageScreen() {
  const screen = app && (app.screen || (app.renderer && app.renderer.screen));
  if (screen && screen.width > 0 && screen.height > 0) {
    return { width: screen.width, height: screen.height };
  }
  return measureStage();
}

function textEntryFocused() {
  const activeElement = document.activeElement;
  return !!(activeElement && (
    activeElement.matches('input, textarea, select') || activeElement.isContentEditable
  ));
}

function usableStage(mode = S.cameraMode) {
  const screen = stageScreen();
  const full = { x: 0, y: 0, width: screen.width, height: screen.height };
  if (mode !== 'phone' || !window.MobileViewport || !app || !app.view) return full;

  let visual;
  try { visual = window.MobileViewport.getVisualRect(); } catch (e) { return full; }
  const canvas = app.view.getBoundingClientRect();
  if (!visual || !canvas.width || !canvas.height) return full;

  const visualRight = Number.isFinite(visual.right) ? visual.right : visual.left + visual.width;
  const visualBottom = Number.isFinite(visual.bottom) ? visual.bottom : visual.top + visual.height;
  const left = Math.max(canvas.left, visual.left);
  const top = Math.max(canvas.top, visual.top);
  const right = Math.min(canvas.right, visualRight);
  const bottom = Math.min(canvas.bottom, visualBottom);
  if (right - left < 1 || bottom - top < 1) return full;

  const scaleX = screen.width / canvas.width;
  const scaleY = screen.height / canvas.height;
  const candidate = {
    x: (left - canvas.left) * scaleX,
    y: (top - canvas.top) * scaleY,
    width: (right - left) * scaleX,
    height: (bottom - top) * scaleY,
  };
  if (textEntryFocused() && lastUsableStage && lastFittedScreen
    && Math.abs(screen.width - lastFittedScreen.width) < 1
    && candidate.height < lastUsableStage.height - 40) {
    return { ...lastUsableStage };
  }
  return candidate;
}

export function fitModel() {
  if (!model || !app) return;
  const usable = usableStage();
  const margin = 0.92;
  const sx = (usable.width * margin) / model.internalModel.width;
  const sy = (usable.height * margin) / model.internalModel.height;
  S.userZoom = boundNumber(Number.isFinite(S.userZoom) ? S.userZoom : 1, 0.2, 5);
  const s = Math.min(sx, sy) * S.userZoom;
  const modelW = model.internalModel.width * s;
  const modelH = model.internalModel.height * s;
  const baseX = usable.x + usable.width / 2 - modelW / 2;
  const baseY = usable.y + usable.height / 2 - modelH / 2;
  if (!S.hasUserPos) {
    S.userOffsetX = S.cameraMode === 'phone' ? 0 : usable.width * 0.26;
    S.userOffsetY = 0;
  }
  const keepX = Math.min(120, modelW, usable.width);
  const keepY = Math.min(120, modelH, usable.height);
  const mx = boundNumber(baseX + S.userOffsetX, usable.x - modelW + keepX, usable.x + usable.width - keepX);
  const my = boundNumber(baseY + S.userOffsetY, usable.y - modelH + keepY, usable.y + usable.height - keepY);
  S.userOffsetX = mx - baseX;
  S.userOffsetY = my - baseY;
  model.scale.set(s);
  model.x = mx;
  model.y = my;
  lastUsableStage = { ...usable };
  lastFittedScreen = stageScreen();
  markDirty();
}

export function captureCameraState(usable = lastUsableStage || usableStage()) {
  if (!model || !usable || usable.width < 1 || usable.height < 1) return null;
  const centerX = model.x + model.internalModel.width * model.scale.x / 2;
  const centerY = model.y + model.internalModel.height * model.scale.y / 2;
  return {
    centerX: (centerX - usable.x) / usable.width,
    centerY: (centerY - usable.y) / usable.height,
    zoom: S.userZoom,
  };
}

function sanitizeCameraState(state) {
  if (!state || !Number.isFinite(state.centerX) || !Number.isFinite(state.centerY) || !Number.isFinite(state.zoom)) {
    return null;
  }
  return {
    centerX: boundNumber(state.centerX, -4, 5),
    centerY: boundNumber(state.centerY, -4, 5),
    zoom: boundNumber(state.zoom, 0.2, 5),
  };
}

function applyCameraState(state) {
  state = sanitizeCameraState(state);
  if (!state) return false;
  const usable = usableStage();
  S.userZoom = state.zoom;
  S.userOffsetX = (state.centerX - 0.5) * usable.width;
  S.userOffsetY = (state.centerY - 0.5) * usable.height;
  S.hasUserPos = true;
  return true;
}

function resetCameraForMode(mode = S.cameraMode) {
  S.userZoom = 1;
  S.userOffsetX = mode === 'phone' ? 0 : usableStage(mode).width * 0.26;
  S.userOffsetY = 0;
  S.hasUserPos = false;
}

function cameraSnapshotForMode(mode) {
  const state = sanitizeCameraState(cameraStates[mode]);
  return { mode, state, hasUserPos: !!state };
}

function currentCameraSnapshot() {
  return {
    mode: S.cameraMode,
    state: S.hasUserPos ? captureCameraState() : null,
    hasUserPos: S.hasUserPos,
  };
}

function cameraTarget(snapshot) {
  if (snapshot && snapshot.hasUserPos && sanitizeCameraState(snapshot.state)) {
    const usable = usableStage();
    const state = sanitizeCameraState(snapshot.state);
    return {
      zoom: state.zoom,
      offsetX: (state.centerX - 0.5) * usable.width,
      offsetY: (state.centerY - 0.5) * usable.height,
    };
  }
  const usable = usableStage();
  return {
    zoom: 1,
    offsetX: S.cameraMode === 'phone' ? 0 : usable.width * 0.26,
    offsetY: 0,
  };
}

function restoreCameraForMode(mode) {
  const state = S.cameraPersistenceEnabled && sanitizeCameraState(cameraStates[mode]);
  if (state) {
    applyCameraState(state);
  } else if (mode === 'desktop' && S.legacyDesktopCamera) {
    S.userOffsetX = S.legacyDesktopCamera.x;
    S.userOffsetY = S.legacyDesktopCamera.y;
    S.userZoom = S.legacyDesktopCamera.zoom;
    S.hasUserPos = true;
    fitModel();
    cameraStates.desktop = captureCameraState();
    S.legacyDesktopCamera = null;
    writeCameraStates();
    return;
  } else {
    resetCameraForMode(mode);
  }
  fitModel();
}

function queueStageResize() {
  if (stageResizeFrame) return;
  stageResizeFrame = requestAnimationFrame(() => {
    stageResizeFrame = 0;
    resizeStage();
  });
}

function resizeStage() {
  if (!app || !app.renderer) return;
  const nextMode = currentCameraMode();
  const previousMode = S.cameraMode;
  const screen = stageScreen();
  const nextSize = measureStage();
  const nextResolution = rendererResolution();
  const visualChanged = visualRefitPending;
  visualRefitPending = false;
  const modeChanged = nextMode !== previousMode;
  const sizeChanged = Math.abs(screen.width - nextSize.width) >= 1 || Math.abs(screen.height - nextSize.height) >= 1;
  const resolutionChanged = !Number.isFinite(app.renderer.resolution)
    || Math.abs(app.renderer.resolution - nextResolution) >= 0.01;
  if (!modeChanged && !sizeChanged && !resolutionChanged && !visualChanged) return;
  if (!modeChanged && !resolutionChanged && nextMode === 'phone'
    && textEntryFocused() && Math.abs(screen.width - nextSize.width) < 1) return;

  const wasTweening = !!cameraTween;
  const currentState = cameraPreset === 'default' && S.hasUserPos && !wasTweening
    ? captureCameraState()
    : null;
  if (modeChanged && S.cameraPersistenceEnabled && currentState) cameraStates[previousMode] = currentState;
  if (wasTweening) cancelCameraTween();
  if (resolutionChanged) app.renderer.resolution = nextResolution;
  if (sizeChanged || resolutionChanged) app.renderer.resize(nextSize.width, nextSize.height);
  S.cameraMode = nextMode;
  if (modeChanged && S.cameraPersistenceEnabled && cameraPreset === 'default' && wasTweening) {
    savedCamera = cameraSnapshotForMode(nextMode);
  }

  if (cameraPreset === 'face') {
    if (modeChanged && S.cameraPersistenceEnabled) savedCamera = cameraSnapshotForMode(nextMode);
    const target = computeFaceCamera();
    S.userZoom = target.zoom;
    S.userOffsetX = target.offsetX;
    S.userOffsetY = target.offsetY;
    S.hasUserPos = true;
    fitModel();
    return;
  }

  if (wasTweening && savedCamera) {
    const target = cameraTarget(savedCamera);
    S.userZoom = target.zoom;
    S.userOffsetX = target.offsetX;
    S.userOffsetY = target.offsetY;
    S.hasUserPos = savedCamera.hasUserPos;
    savedCamera = null;
    fitModel();
  } else if (modeChanged && S.cameraPersistenceEnabled) {
    savedCamera = null;
    restoreCameraForMode(nextMode);
  } else if (currentState) {
    applyCameraState(currentState);
    fitModel();
  } else {
    fitModel();
  }
}

export function watchStageSize() {
  if (stageResizeObserver) stageResizeObserver.disconnect();
  if (removeViewportSubscription) removeViewportSubscription();

  if (window.ResizeObserver) {
    stageResizeObserver = new ResizeObserver(queueStageResize);
    stageResizeObserver.observe(S.stageElement);
  } else {
    window.addEventListener('resize', queueStageResize);
  }

  if (window.MobileViewport && window.MobileViewport.subscribe) {
    removeViewportSubscription = window.MobileViewport.subscribe((event) => {
      if (event.visualChanged && event.isPhone) visualRefitPending = true;
      if (event.phoneChanged || visualRefitPending || currentCameraMode() !== S.cameraMode) queueStageResize();
    });
  }
  queueStageResize();
}

export let cameraPreset = 'default';
let savedCamera = null;   // snapshot of user camera while 'face' is active
export let cameraTween = null;   // active ticker fn

const FACE_CENTER_FRAC = 0.12;
const FACE_SCREEN_Y = 0.42;
const FACE_HEAD_FRAC = 0.30;

function computeFaceCamera() {
  const usable = usableStage();
  const margin = 0.92;
  const sBase = Math.min(
    (usable.width * margin) / model.internalModel.width,
    (usable.height * margin) / model.internalModel.height
  );
  const zoom = Math.min(5, (usable.height * FACE_HEAD_FRAC) / (sBase * model.internalModel.height * 0.22));
  const modelH = model.internalModel.height * sBase * zoom;
  const baseY = usable.y + usable.height / 2 - modelH / 2;
  return {
    zoom,
    offsetX: 0,
    offsetY: (usable.y + usable.height * FACE_SCREEN_Y - FACE_CENTER_FRAC * modelH) - baseY,
  };
}

function cancelCameraTween() {
  if (cameraTween) { app.ticker.remove(cameraTween); cameraTween = null; }
}

function tweenCameraTo(target, ms, onDone) {
  cancelCameraTween();
  const from = { zoom: S.userZoom, offsetX: S.userOffsetX, offsetY: S.userOffsetY };
  const t0 = performance.now();
  cameraTween = () => {
    const t = Math.min(1, (performance.now() - t0) / ms);
    const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
    S.userZoom = from.zoom + (target.zoom - from.zoom) * e;
    S.userOffsetX = from.offsetX + (target.offsetX - from.offsetX) * e;
    S.userOffsetY = from.offsetY + (target.offsetY - from.offsetY) * e;
    fitModel();
    if (t >= 1) { cancelCameraTween(); if (onDone) onDone(); }
  };
  app.ticker.add(cameraTween);
}

export function setCameraPreset(preset) {
  if (!model || !app || preset === cameraPreset) return;
  if (preset === 'face') {
    savedCamera = currentCameraSnapshot();
    cameraPreset = 'face';
    S.hasUserPos = true; // suppress the default rest offset in fitModel
    tweenCameraTo(computeFaceCamera(), 450);
  } else {
    cameraPreset = 'default';
    const back = savedCamera || cameraSnapshotForMode(S.cameraMode);
    S.hasUserPos = true;
    tweenCameraTo(cameraTarget(back), 450, () => {
      S.hasUserPos = back.hasUserPos;
      savedCamera = null;
      fitModel();
    });
  }
}

export function savePos() {
  if (document.body.classList.contains('wardrobe-open')) return;
  if (cameraPreset === 'face') return;
  if (!S.cameraPersistenceEnabled) return;
  const state = captureCameraState();
  if (!state) return;
  cameraStates[S.cameraMode] = state;
  writeCameraStates();
}

export function loadPos() {
  cameraStates = { phone: null, desktop: null };
  S.legacyDesktopCamera = null;
  if (!S.cameraPersistenceEnabled) return false;
  try {
    const saved = JSON.parse(localStorage.getItem(CAMERA_STORAGE_KEY) || 'null');
    if (saved && saved.version === CAMERA_STORAGE_VERSION) {
      cameraStates.phone = sanitizeCameraState(saved.phone);
      cameraStates.desktop = sanitizeCameraState(saved.desktop);
    }
  } catch (e) { }

  if (!cameraStates.desktop) {
    try {
      const legacy = JSON.parse(localStorage.getItem('l2d.pos') || 'null');
      if (legacy && Number.isFinite(legacy.x)) {
        S.legacyDesktopCamera = {
          x: legacy.x,
          y: Number.isFinite(legacy.y) ? legacy.y : 0,
          zoom: Number.isFinite(legacy.z) ? boundNumber(legacy.z, 0.2, 5) : 1,
        };
      }
    } catch (e) { }
  }

  if (cameraStates[S.cameraMode]) {
    applyCameraState(cameraStates[S.cameraMode]);
    return false;
  }
  if (S.cameraMode !== 'desktop') {
    resetCameraForMode(S.cameraMode);
    return false;
  }
  if (S.legacyDesktopCamera) {
    S.userOffsetX = S.legacyDesktopCamera.x;
    S.userOffsetY = S.legacyDesktopCamera.y;
    S.userZoom = S.legacyDesktopCamera.zoom;
    S.hasUserPos = true;
    return true;
  }
  resetCameraForMode(S.cameraMode);
  return false;
}

export function writeCameraStates() {
  if (!S.cameraPersistenceEnabled) return;
  try {
    localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify({
      version: CAMERA_STORAGE_VERSION,
      phone: sanitizeCameraState(cameraStates.phone),
      desktop: sanitizeCameraState(cameraStates.desktop),
    }));
  } catch (e) { }
}
