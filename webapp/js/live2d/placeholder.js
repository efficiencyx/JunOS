import { FACE_HEAD_FRAC, FACE_SCREEN_Y, cameraPreset, currentCameraMode, setStandIn, standInModeChanged, usableStage } from './camera.js?v=78';
import { S } from './state.js?v=75';

// no rig on disk (webapp/assets/ is gitignored game art, a fresh
// clone has none until tools/recover_assets.py runs), so she's a
// flat svg instead. same box fitModel would give her, same 0.92
// margin, same 26% shove to the right on the desktop chat page,
// and the same drag/zoom offsets input.js moves the rig with.
const ART = 'placeholder/jun.svg?v=3';
const MARGIN = 0.92;
// jun.svg's viewBox, and where her mouth and face edge sit in it
const VIEW_W = 400, VIEW_H = 900;
const MOUTH_Y = 202, FACE_HALF_W = 66;
const HEAD_TOP = 26, HEAD_BOTTOM = 230, FACE_CENTER_Y = 156;

let art = null;

function place(img) {
  const mode = currentCameraMode();
  if (mode !== S.cameraMode) standInModeChanged(mode);
  const u = usableStage();
  if (cameraPreset === 'face') {
    // same framing computeFaceCamera gives the rig: head is 30% of
    // the stage height, face centre at 42% down
    const h = u.height * FACE_HEAD_FRAC / ((HEAD_BOTTOM - HEAD_TOP) / VIEW_H);
    const w = h * VIEW_W / VIEW_H;
    Object.assign(img.style, {
      left: `${u.x + (u.width - w) / 2}px`,
      top: `${u.y + u.height * FACE_SCREEN_Y - h * FACE_CENTER_Y / VIEW_H}px`,
      width: `${w}px`,
      height: `${h}px`,
    });
    return;
  }
  if (!S.hasUserPos) {
    S.userZoom = 1;
    S.userOffsetX = S.cameraPersistenceEnabled && S.cameraMode !== 'phone' ? u.width * 0.26 : 0;
    S.userOffsetY = 0;
  }
  const zoom = Math.max(0.2, Math.min(5, Number.isFinite(S.userZoom) ? S.userZoom : 1));
  const s = Math.min(u.width * MARGIN / VIEW_W, u.height * MARGIN / VIEW_H) * zoom;
  const w = VIEW_W * s, h = VIEW_H * s;
  const baseX = u.x + (u.width - w) / 2, baseY = u.y + (u.height - h) / 2;
  const keepX = Math.min(120, w, u.width), keepY = Math.min(120, h, u.height);
  const x = Math.max(u.x - w + keepX, Math.min(u.x + u.width - keepX, baseX + S.userOffsetX));
  const y = Math.max(u.y - h + keepY, Math.min(u.y + u.height - keepY, baseY + S.userOffsetY));
  S.userOffsetX = x - baseX;
  S.userOffsetY = y - baseY;
  Object.assign(img.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
}

function capture(u) {
  if (!art || cameraPreset === 'face' || u.width < 1 || u.height < 1) return null;
  const r = art.getBoundingClientRect();
  const stage = art.parentElement.getBoundingClientRect();
  return {
    centerX: (r.left - stage.left + r.width / 2 - u.x) / u.width,
    centerY: (r.top - stage.top + r.height / 2 - u.y) / u.height,
    zoom: S.userZoom,
  };
}

export function mountPlaceholder(stageEl) {
  const img = art = document.createElement('img');
  img.className = 'l2d-placeholder';
  img.src = ART;
  img.alt = 'Placeholder - 404 Assets not extracted. Extract from your copy of the game, then reload. Chat still works.';
  img.draggable = false;
  img.style.cssText = 'position:absolute;object-fit:contain;pointer-events:none;user-select:none';
  stageEl.appendChild(img);
  setStandIn({ fit: () => place(img), capture });
  place(img);
  // the composer docks after the first message and gets shorter,
  // so watch it too, not just the window
  const ro = new ResizeObserver(() => place(img));
  ro.observe(stageEl);
  const composer = document.querySelector('.composer-area .composer');
  if (composer) ro.observe(composer);
}

// same shape as faceAnchor() off the real rig, measured off the
// svg as it's drawn. object-fit:contain letterboxes it inside the
// img box, so the img rect alone would put her head in the margin
export function placeholderAnchor() {
  if (!art) return null;
  const r = art.getBoundingClientRect();
  const s = Math.min(r.width / VIEW_W, r.height / VIEW_H);
  if (!s) return null;
  const w = VIEW_W * s, h = VIEW_H * s;
  const left = r.left + (r.width - w) / 2, top = r.top + (r.height - h) / 2;
  return {
    x: left + w / 2,
    y: top + h * 0.09,
    headW: Math.max(w * 0.30, h * 0.12),
    modelW: w,
    modelH: h,
    mouth: { x: left + w / 2, y: top + MOUTH_Y * s, gap: Math.max(FACE_HALF_W * s, 24) },
  };
}
