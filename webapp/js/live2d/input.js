import { cameraPreset, fitModel, savePos } from './camera.js?v=12';
import { isInteractiveTarget, isOverModel } from './geometry.js?v=12';
import { S } from './state.js?v=11';

// scroll moves her up and down, shift+scroll zooms, dragging
// moves her around. saved per camera mode by camera.js.
export function installStageInput() {
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
}
