import { FACE_HEAD_FRAC, FACE_SCREEN_Y, currentCameraMode, usableStage } from './camera.js?v=75';
import { S } from './state.js?v=11';

// no rig on disk (webapp/assets/ is gitignored game art, a fresh
// clone has none until tools/recover_assets.py runs), so she's a
// flat svg instead. same box fitModel would give her, same 0.92
// margin, same 26% shove to the right on the desktop chat page,
// so the bubbles and the composer sit where they normally do.
const ART = 'placeholder/jun.svg?v=1';
const MARGIN = 0.92;
// jun.svg's viewBox, and where her mouth and face edge sit in it
const VIEW_W = 400, VIEW_H = 900;
const MOUTH_Y = 202, FACE_HALF_W = 66;
const HEAD_TOP = 26, HEAD_BOTTOM = 230, FACE_CENTER_Y = 156;

let art = null;
let preset = 'default';

function place(img) {
  S.cameraMode = currentCameraMode();
  const u = usableStage();
  if (preset === 'face') {
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
  const shift = S.cameraPersistenceEnabled && S.cameraMode !== 'phone' ? u.width * 0.26 : 0;
  Object.assign(img.style, {
    left: `${u.x + shift}px`,
    top: `${u.y + u.height * (1 - MARGIN) / 2}px`,
    width: `${u.width}px`,
    height: `${u.height * MARGIN}px`,
  });
}

export function setPlaceholderPreset(next) {
  preset = next === 'face' ? 'face' : 'default';
  if (art) place(art);
}

export function mountPlaceholder(stageEl) {
  const img = art = document.createElement('img');
  img.className = 'l2d-placeholder';
  img.src = ART;
  img.alt = '';
  img.draggable = false;
  img.style.cssText = 'position:absolute;object-fit:contain;pointer-events:none;user-select:none';
  stageEl.appendChild(img);
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
