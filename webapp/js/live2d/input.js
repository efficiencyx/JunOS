import { cameraPreset, fitModel, savePos } from './camera.js?v=78';
import { isInteractiveTarget, isOverModel } from './geometry.js?v=80';
import { S } from './state.js?v=75';

const ZOOM_MIN = 0.2, ZOOM_MAX = 5;

// scroll moves her up and down, shift+scroll or a pinch zooms,
// dragging moves her around. saved per camera mode by camera.js.
export function installStageInput() {
  window.addEventListener('wheel', (e) => {
    if (cameraPreset === 'face') return;
    if (document.body.classList.contains('sidebar-open')) return;
    if (isInteractiveTarget(e.target)) return;
    if (!isOverModel(e.clientX, e.clientY)) return;
    e.preventDefault();
    if (e.shiftKey) {
      const desired = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, S.userZoom * Math.exp(-e.deltaY * 0.00025)));
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
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch) { movePinch(); return; }
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
  // touch screens have no shift+wheel, so two fingers zoom her.
  // phone-ui puts touch-action: none on #stage, that's what stops
  // the webview zooming the whole page underneath at the same time
  const touches = new Map();
  let pinch = null;
  const pinchSpan = () => {
    const [a, b] = [...touches.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  };
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    if (cameraPreset === 'face') return;
    if (document.body.classList.contains('wardrobe-open')) return;
    if (document.body.classList.contains('sidebar-open')) return;
    if (isInteractiveTarget(e.target)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size !== 2 || pinch) return;
    const span = pinchSpan();
    if (!document.documentElement.classList.contains('phone-ui') && !isOverModel(span.mx, span.my)) return;
    if (span.dist < 10) return;
    dragging = false;
    dragMoved = false;
    dragPointerId = -1;
    document.body.classList.remove('l2d-dragging');
    pinch = { ...span, zoom: S.userZoom, ox: S.userOffsetX, oy: S.userOffsetY };
  });
  function movePinch() {
    if (touches.size < 2) return;
    const span = pinchSpan();
    const desired = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pinch.zoom * span.dist / pinch.dist));
    const factor = desired / pinch.zoom;
    S.userZoom = desired;
    S.userOffsetX = pinch.ox * factor + span.mx - pinch.mx;
    S.userOffsetY = pinch.oy * factor + span.my - pinch.my;
    S.hasUserPos = true;
    fitModel();
  }
  const endTouch = (e) => {
    if (!touches.delete(e.pointerId) || !pinch) return;
    pinch = null;
    savePos();
  };
  window.addEventListener('pointerup', endTouch);
  window.addEventListener('pointercancel', endTouch);

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
}
