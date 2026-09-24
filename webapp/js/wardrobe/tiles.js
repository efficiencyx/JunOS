import * as Live2D from '../live2d/live2d.js?v=4';
import { closeColorPicker, colorPickerEl, makeColorButton, phonePopupMode, pickerEmbedded, schedulePopupPosition, showColorPicker, visualViewportRect, watchPopupViewport } from './color-picker.js?v=4';
import { colorGroup } from '../outfit/catalog.js?v=1';
import { colors, state, variantState } from '../outfit/current.js?v=1';
import { setItem, setVariant } from '../outfit/apply.js?v=3';
import { variantThumb } from './tile-bake.js?v=3';
import { wdGhost } from './panel.js?v=4';

export function wdMoveGhost(x, y) {
  wdGhost.style.left = (x + 10) + 'px';
  wdGhost.style.top = (y + 10) + 'px';
}

export function wdShowGhost(src, x, y) {
  wdGhost.src = src || '';
  wdGhost.style.display = src ? 'block' : 'none';
  if (src) wdMoveGhost(x, y);
}

export function makeSwatch(groupKeys, label) {
  return makeColorButton(groupKeys, label, 'wd-swatch');
}

export let optPopEl = null, optPopAnchor = null, optPopItemKey = null;

export function closeOptionsPopup(focusAnchor) {
  if (!optPopEl || optPopEl.hidden) return;
  closeColorPicker(false, true);
  optPopEl.hidden = true;
  if (focusAnchor && optPopAnchor) optPopAnchor.focus();
  optPopAnchor = null;
  optPopItemKey = null;
}

export function positionOptionsPopup() {
  if (!optPopAnchor || !optPopEl || optPopEl.hidden) return;
  const viewport = visualViewportRect();
  const sheet = phonePopupMode();
  optPopEl.classList.toggle('wd-sheet', sheet);
  optPopEl.style.width = sheet ? `${viewport.width}px` : '';
  optPopEl.style.maxHeight = sheet ? `${Math.max(0, viewport.height - 8)}px` : '';
  if (sheet) {
    optPopEl.style.left = `${viewport.left}px`;
    optPopEl.style.top = `${Math.max(viewport.top, viewport.bottom - optPopEl.offsetHeight)}px`;
    return;
  }
  const anchor = optPopAnchor.getBoundingClientRect();
  const width = optPopEl.offsetWidth, height = optPopEl.offsetHeight;
  let left = anchor.right - width, top = anchor.bottom + 8;
  if (top + height > viewport.bottom - 8) top = anchor.top - height - 8;
  optPopEl.style.left = `${Math.max(viewport.left + 8, Math.min(left, viewport.right - width - 8))}px`;
  optPopEl.style.top = `${Math.max(viewport.top + 8, Math.min(top, viewport.bottom - height - 8))}px`;
}

function buildOptionsPopup() {
  if (optPopEl) return;
  watchPopupViewport();
  optPopEl = document.createElement('div');
  optPopEl.className = 'wd-optpop';
  optPopEl.hidden = true;
  optPopEl.innerHTML = '<div class="wd-optpop-head"><div class="wd-optpop-title"></div><button type="button" class="wd-optpop-close" aria-label="Close options" title="Close">×</button></div><div class="wd-optpop-row"></div><div class="wd-optpop-grid"></div><div class="wd-optpop-color"></div>';
  document.body.appendChild(optPopEl);
  optPopEl.querySelector('.wd-optpop-close').addEventListener('click', () => closeOptionsPopup(true));
  document.addEventListener('pointerdown', (e) => {
    if (optPopEl.hidden || optPopEl.contains(e.target)) return;
    if (optPopAnchor && optPopAnchor.contains(e.target)) return;
    if (colorPickerEl && !colorPickerEl.hidden && colorPickerEl.contains(e.target)) return;
    closeOptionsPopup(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !optPopEl.hidden && (!colorPickerEl || colorPickerEl.hidden || pickerEmbedded())) {
      e.stopPropagation();
      closeOptionsPopup(true);
    }
  }, true);
  window.addEventListener('scroll', (e) => {
    if (optPopEl.hidden || (e.target instanceof Node && optPopEl.contains(e.target))) return;
    if (phonePopupMode() || optPopEl.contains(document.activeElement)) schedulePopupPosition();
    else closeOptionsPopup(false);
  }, true);
}

export function openTilePopup(anchor, cfg) {
  buildOptionsPopup();
  if (optPopAnchor === anchor && !optPopEl.hidden) { closeOptionsPopup(false); return; }
  closeColorPicker(false, true);
  optPopAnchor = anchor;
  optPopItemKey = cfg.itemKey || null;
  optPopEl.querySelector('.wd-optpop-title').textContent = cfg.title;

  const row = optPopEl.querySelector('.wd-optpop-row');
  row.innerHTML = '';
  if (cfg.itemKey) {
    const eq = document.createElement('button');
    eq.type = 'button';
    eq.className = 'wd-opt-equip';
    eq.addEventListener('click', () => setItem(cfg.itemKey, !state[cfg.itemKey]));
    row.appendChild(eq);
  }
  row.hidden = !row.childNodes.length;

  const colorWrap = optPopEl.querySelector('.wd-optpop-color');
  const validKeys = (cfg.colorKeys || []).filter(key => key in colors);
  colorWrap.hidden = !validKeys.length;
  if (validKeys.length) {
    showColorPicker(null, cfg.title, {
      keys: validKeys,
      labels: validKeys.map(key => (colorGroup(key) || {}).label || key),
    }, colorWrap);
  }

  const grid = optPopEl.querySelector('.wd-optpop-grid');
  grid.innerHTML = '';
  const variants = cfg.variants || [];
  grid.hidden = !variants.length;
  for (const v of variants) {
    if (variants.length > 1) {
      const title = document.createElement('div');
      title.className = 'wd-optpop-subtitle';
      title.textContent = v.label;
      grid.appendChild(title);
    }
    v.options.forEach((opt, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wd-opt';
      b.dataset.opt = String(i);
      b.dataset.variantKey = v.key;
      const thumb = variantThumb(v, opt);
      fillTile(b, thumb, opt.name);
      b.addEventListener('click', () => setVariant(v.key, i));
      grid.appendChild(b);
    });
  }
  optPopEl.hidden = false;
  syncOptionsPopup();
  positionOptionsPopup();
}

export function syncOptionsPopup() {
  if (!optPopEl || optPopEl.hidden) return;
  optPopEl.querySelectorAll('.wd-opt').forEach(b => {
    const current = variantState[b.dataset.variantKey] || 0;
    b.classList.toggle('on', Number(b.dataset.opt) === current);
  });
  const eq = optPopEl.querySelector('.wd-opt-equip');
  if (eq && optPopItemKey) {
    const worn = !!state[optPopItemKey];
    eq.textContent = worn ? 'Remove' : 'Wear';
    eq.classList.toggle('worn', worn);
  }
}

export function makeOptOrb(cfg) {
  const orb = document.createElement('button');
  orb.type = 'button';
  orb.className = 'wd-optorb';
  if (cfg.variants && cfg.variants.length) orb.dataset.optOrb = cfg.variants[0].key;
  orb.textContent = '▾';
  orb.title = `${cfg.title} options`;
  orb.setAttribute('aria-label', `${cfg.title} options`);
  orb.addEventListener('pointerdown', (e) => e.stopPropagation());
  orb.addEventListener('click', (e) => { e.stopPropagation(); openTilePopup(orb, cfg); });
  return orb;
}

function isNestedTileControl(tile, target) {
  if (!(target instanceof Element)) return false;
  const control = target.closest('button, a, input, textarea, select');
  return !!(control && tile.contains(control));
}

function bindTileDrag(tile, thumbSrc, onEquip, popupCfg) {
  tile.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || e.button !== 0 || isNestedTileControl(tile, e.target)) return;
    e.preventDefault();
    try { tile.setPointerCapture(e.pointerId); } catch (err) { }
    const sx = e.clientX, sy = e.clientY;
    let dragging = false;
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6) {
        dragging = true;
        wdShowGhost(thumbSrc, ev.clientX, ev.clientY);
      }
      if (dragging) wdMoveGhost(ev.clientX, ev.clientY);
    };
    const finish = (ev, cancelled) => {
      if (ev.pointerId !== e.pointerId) return;
      tile.removeEventListener('pointermove', move);
      tile.removeEventListener('pointerup', up);
      tile.removeEventListener('pointercancel', cancel);
      wdShowGhost(null);
      if (cancelled) return;
      if (!dragging) openTilePopup(tile, popupCfg);
      else if (Live2D.isOverModel(ev.clientX, ev.clientY)) onEquip();
    };
    const up = (ev) => finish(ev, false);
    const cancel = (ev) => finish(ev, true);
    tile.addEventListener('pointermove', move);
    tile.addEventListener('pointerup', up);
    tile.addEventListener('pointercancel', cancel);
  });

  let touchSession = null;
  const clearTouchSession = () => {
    if (!touchSession) return;
    clearTimeout(touchSession.timer);
    window.removeEventListener('touchstart', cancelMultitouch, true);
    window.removeEventListener('touchmove', moveTouch, true);
    window.removeEventListener('touchend', endTouch, true);
    window.removeEventListener('touchcancel', cancelTouch, true);
    tile.classList.remove('wd-dragging');
    wdShowGhost(null);
    touchSession = null;
  };
  const cancelMultitouch = (e) => {
    if (touchSession && e.touches.length > 1) clearTouchSession();
  };
  const moveTouch = (e) => {
    if (!touchSession) return;
    const touch = Array.from(e.touches).find(t => t.identifier === touchSession.id);
    if (!touch || e.touches.length > 1) { clearTouchSession(); return; }
    touchSession.x = touch.clientX;
    touchSession.y = touch.clientY;
    if (!touchSession.dragging) {
      if (Math.hypot(touch.clientX - touchSession.sx, touch.clientY - touchSession.sy) > 8) {
        clearTouchSession();
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    wdMoveGhost(touch.clientX, touch.clientY);
  };
  const endTouch = (e) => {
    if (!touchSession) return;
    const touch = Array.from(e.changedTouches).find(t => t.identifier === touchSession.id);
    if (!touch) return;
    const dragging = touchSession.dragging;
    if (dragging) {
      e.preventDefault();
      e.stopPropagation();
    }
    clearTouchSession();
    if (dragging) {
      if (Live2D.isOverModel(touch.clientX, touch.clientY)) onEquip();
    } else openTilePopup(tile, popupCfg);
  };
  const cancelTouch = () => clearTouchSession();
  tile.addEventListener('touchstart', (e) => {
    if (touchSession || e.touches.length !== 1 || isNestedTileControl(tile, e.target)) return;
    const touch = e.changedTouches[0];
    touchSession = {
      id: touch.identifier,
      sx: touch.clientX,
      sy: touch.clientY,
      x: touch.clientX,
      y: touch.clientY,
      dragging: false,
      timer: 0,
    };
    touchSession.timer = setTimeout(() => {
      if (!touchSession) return;
      touchSession.dragging = true;
      tile.classList.add('wd-dragging');
      wdShowGhost(thumbSrc, touchSession.x, touchSession.y);
    }, 400);
    window.addEventListener('touchstart', cancelMultitouch, { capture: true, passive: true });
    window.addEventListener('touchmove', moveTouch, { capture: true, passive: false });
    window.addEventListener('touchend', endTouch, { capture: true, passive: false });
    window.addEventListener('touchcancel', cancelTouch, { capture: true, passive: true });
  }, { passive: true });
}

export function fillTile(el, thumb, label) {
  const pic = document.createElement(thumb ? 'img' : 'div');
  if (thumb) {
    pic.draggable = false;
    pic.src = thumb;
  } else {
    pic.className = 'wd-noimg';
    pic.textContent = '?';
  }
  const name = document.createElement('span');
  name.textContent = label;
  el.replaceChildren(pic, name);
}

export function makeTile(label, thumbSrc, onEquip, colorKeys, popupCfg) {
  const tile = document.createElement('div');
  tile.className = 'wd-tile';
  tile.tabIndex = 0;
  tile.setAttribute('role', 'button');
  tile.setAttribute('aria-label', `${label} options`);
  fillTile(tile, thumbSrc, label);
  if (colorKeys && colorKeys.length) tile.appendChild(makeSwatch(colorKeys, label));
  tile.appendChild(makeOptOrb(popupCfg));
  bindTileDrag(tile, thumbSrc, onEquip, popupCfg);
  tile.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    openTilePopup(tile, popupCfg);
  });
  return tile;
}
