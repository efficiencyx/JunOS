import * as Live2D from '../live2d/live2d.js?v=4';
import { BODY_VARIANTS, CLOTHING_VARIANTS, COLOR_GROUPS, ITEMS, ITEM_COLOR_GROUPS, ITEM_VARIANTS, VARIANTS } from '../outfit/catalog.js?v=1';
import { fillTile, makeOptOrb, makeSwatch, makeTile, openTilePopup, syncOptionsPopup, wdMoveGhost, wdShowGhost } from './tiles.js?v=4';
import { state, variantState } from '../outfit/current.js?v=1';
import { itemThumb, variantThumb } from './tile-bake.js?v=3';
import { looksOpen, toggleLooks } from './looks.js?v=4';
import { reset, setItem } from '../outfit/apply.js?v=3';
import { wornDrawableMap, wornHitAt, wornLabel, wornRemove, wornWear } from './worn.js?v=3';
import { buildWardrobeSection } from '../mods/section.js?v=4';
import { activate, playOutro } from './reactions.js?v=3';
import { refreshColorButtons } from './color-picker.js?v=4';
import { hooks } from '../outfit/hooks.js?v=1';

export let clearWornHover = null;

export let wdOverlay = null, wdTooltip = null, wdGhost = null;

function buildWardrobe() {
  const coarsePointer = matchMedia('(pointer: coarse)');
  wdOverlay = document.createElement('div');
  hooks.refresh = syncWardrobe;
  wdOverlay.className = 'wardrobe-overlay';
  wdOverlay.innerHTML = `<div class="wd-head">
      <div class="wd-titles"><span class="wd-hint"></span></div>
      <div class="wd-actions">
      <button class="ghost wd-looks" type="button" title="Saved outfits">Outfits</button>
      <button class="ghost wd-reset" type="button" title="Restore the default outfit">Reset</button>
      <button class="ghost wd-close" type="button" aria-label="Close wardrobe" title="Close">×</button></div></div>
    <div class="wd-main"><nav class="wd-rail" aria-label="Wardrobe sections"></nav><div class="wd-body"></div></div>`;
  const hint = wdOverlay.querySelector('.wd-hint');
  const syncHint = () => {
    hint.textContent = coarsePointer.matches
      ? 'Tap for options · hold and drag onto Jun to wear'
      : 'Click for options · drag onto Jun to wear';
  };
  syncHint();
  if (coarsePointer.addEventListener) coarsePointer.addEventListener('change', syncHint);
  else coarsePointer.addListener(syncHint);
  const body = wdOverlay.querySelector('.wd-body');
  const rail = wdOverlay.querySelector('.wd-rail');

  const navTargets = [];
  const addNav = (name, el) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wd-nav';
    b.title = name;
    b.textContent = name;
    b.addEventListener('click', () => body.scrollTo({ top: el.offsetTop - 6, behavior: 'smooth' }));
    rail.appendChild(b);
    navTargets.push([el, b]);
  };
  const syncNav = () => {
    let active = navTargets.length ? navTargets[0][1] : null;
    for (const [el, b] of navTargets) if (el.offsetTop <= body.scrollTop + 90) active = b;
    for (const [, b] of navTargets) b.classList.toggle('on', b === active);
  };
  body.addEventListener('scroll', syncNav, { passive: true });

  const section = (name, sub) => {
    const t = document.createElement('div');
    t.className = sub ? 'wd-section wd-sub' : 'wd-section';
    const label = document.createElement('span');
    label.textContent = name;
    t.appendChild(label);
    body.appendChild(t);
    const grid = document.createElement('div');
    grid.className = 'wd-grid';
    body.appendChild(grid);
    return { title: t, grid };
  };
  const tileGroups = new Set(Object.values(ITEM_COLOR_GROUPS).flat());
  const studioKeys = COLOR_GROUPS.filter(g =>
    !tileGroups.has(g.key) &&
    Live2D.findDrawables(g.includes, g.excludes).length)
    .map(g => g.key);

  const makeVariantTile = (v, colorKeys) => {
    const tile = document.createElement('div');
    tile.className = 'wd-tile';
    tile.tabIndex = 0;
    tile.setAttribute('role', 'button');
    tile.setAttribute('aria-label', `Choose ${v.label.toLowerCase()}`);
    const thumb = variantThumb(v, v.options[variantState[v.key] || 0]);
    fillTile(tile, thumb, v.label);
    tile.dataset.variantTile = v.key;
    tile.dataset.variantIndex = String(variantState[v.key] || 0);
    if (colorKeys && colorKeys.length) tile.appendChild(makeSwatch(colorKeys, v.label));
    const popupCfg = { title: v.label, colorKeys, variants: [v] };
    tile.appendChild(makeOptOrb(popupCfg));
    tile.addEventListener('click', () => openTilePopup(tile, popupCfg));
    tile.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      openTilePopup(tile, popupCfg);
    });
    return tile;
  };

  for (const [sec, name] of [[undefined, 'Clothing'], ['body', 'Body'], ['hair', 'Hair']]) {
    const { title, grid } = section(name);
    addNav(name, title);
    for (const it of ITEMS.filter(x => x.section === sec)) {
      const colorKeys = ITEM_COLOR_GROUPS[it.key] || [];
      const popupCfg = {
        title: it.label,
        itemKey: it.key,
        colorKeys,
        variants: (ITEM_VARIANTS[it.key] || [])
          .map(k => VARIANTS.find(v => v.key === k)).filter(Boolean),
      };
      const tile = makeTile(it.label, itemThumb(it),
        () => setItem(it.key, true), colorKeys, popupCfg);
      tile.dataset.item = it.key;
      grid.appendChild(tile);
    }
    if (sec === undefined) {
      for (const key of CLOTHING_VARIANTS) {
        const v = VARIANTS.find(x => x.key === key);
        if (v) grid.appendChild(makeVariantTile(v, key === 'glasses_style' ? ['glasses_frame', 'glasses_lens'] : []));
      }
    }
    if (sec === 'body') {
      for (const key of BODY_VARIANTS) {
        const v = VARIANTS.find(x => x.key === key);
        if (v) grid.appendChild(makeVariantTile(v, key === 'hightech_skin' ? studioKeys : []));
      }
    }
  }

  const anchor = document.createElement('div');
  body.appendChild(anchor);
  buildWardrobeSection(body);
  const modTitle = anchor.nextElementSibling;
  anchor.remove();
  if (modTitle) addNav('Mods', modTitle);
  syncNav();

  wdTooltip = document.createElement('div');
  wdTooltip.className = 'wd-tooltip';
  wdGhost = document.createElement('img');
  wdGhost.className = 'wd-ghost';
  document.body.append(wdOverlay, wdTooltip, wdGhost);

  wdOverlay.querySelector('.wd-close').addEventListener('click', closeWardrobe);
  wdOverlay.querySelector('.wd-reset').addEventListener('click', () => {
    if (window.confirm('Restore Jun\'s default outfit and colors?')) reset();
  });

  wdOverlay.querySelector('.wd-looks').addEventListener('click', () => toggleLooks());

  clearWornHover = () => {
    setHoveredItem(null);
    wdTooltip.style.display = 'none';
  };

  let removeDrag = null;
  const beginRemoveDrag = (key, x, y) => {
    removeDrag = { key, x, y, removed: false };
    wdTooltip.style.display = 'none';
    setHoveredItem(key, wornDrawableMap());
    const tile = wdOverlay.querySelector(`.wd-tile[data-item="${key}"] img, .wd-tile[data-variant-tile="${key}"] img`);
    wdShowGhost(tile ? tile.src : '', x, y);
  };
  let hoveredKey = null, hoveredIds = [];
  const setHoveredItem = (key, worn) => {
    if (hoveredKey === key) return;
    for (const id of hoveredIds) Live2D.setDrawableHighlight(id, null);
    hoveredKey = key;
    hoveredIds = [];
    if (key && worn) for (const [id, k] of worn) if (k === key) hoveredIds.push(id);
    for (const id of hoveredIds) Live2D.setDrawableHighlight(id, [0.45, 0.22, 0.65]);
    document.body.classList.toggle('wd-over-worn-item', !!key);
  };
  window.addEventListener('pointermove', (e) => {
    if (!document.body.classList.contains('wardrobe-open') || looksOpen()) return;
    if (removeDrag) {
      wdMoveGhost(e.clientX, e.clientY);
      if (!removeDrag.removed && Math.hypot(e.clientX - removeDrag.x, e.clientY - removeDrag.y) > 6) {
        removeDrag.removed = true;
        wornRemove(removeDrag.key);
        setHoveredItem(null);
      }
      return;
    }
    let key = null, worn = null;
    if (!(e.target && e.target.closest && e.target.closest('.wardrobe-overlay'))) {
      worn = wornDrawableMap();
      const hit = wornHitAt(e.clientX, e.clientY, worn);
      key = hit ? worn.get(hit) : null;
    }
    setHoveredItem(key, worn);
    wdTooltip.style.display = key ? 'block' : 'none';
    if (key) {
      wdTooltip.textContent = `${wornLabel(key)} - drag away to remove`;
      wdTooltip.style.left = (e.clientX + 14) + 'px';
      wdTooltip.style.top = (e.clientY + 14) + 'px';
    }
  });
  window.addEventListener('pointerdown', (e) => {
    if (!document.body.classList.contains('wardrobe-open') || looksOpen()) return;
    if (e.pointerType === 'touch' || e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('.wardrobe-overlay, .wd-optpop, .omega-color-picker, button, a, input, textarea, select, .composer, .conv-sidebar, .app-header')) return;
    const worn = wornDrawableMap();
    const hit = wornHitAt(e.clientX, e.clientY, worn);
    if (!hit) return;
    const key = worn.get(hit);
    e.preventDefault();
    try { e.target.setPointerCapture(e.pointerId); } catch (err) { }
    beginRemoveDrag(key, e.clientX, e.clientY);
  });
  window.addEventListener('pointerup', (e) => {
    if (!removeDrag || e.pointerType === 'touch') return;
    if (removeDrag.removed && Live2D.isOverModel(e.clientX, e.clientY)) {
      wornWear(removeDrag.key);
    }
    removeDrag = null;
    wdShowGhost(null);
  });
  window.addEventListener('pointercancel', (e) => {
    if (e.pointerType === 'touch') return;
    removeDrag = null;
    wdShowGhost(null);
  });

  let removeTouch = null;
  const clearRemoveTouch = (restore) => {
    if (!removeTouch) return;
    clearTimeout(removeTouch.timer);
    window.removeEventListener('touchstart', cancelRemoveMultitouch, true);
    window.removeEventListener('touchmove', moveRemoveTouch, true);
    window.removeEventListener('touchend', endRemoveTouch, true);
    window.removeEventListener('touchcancel', cancelRemoveTouch, true);
    const removed = removeDrag && removeDrag.removed;
    const key = removeDrag && removeDrag.key;
    removeTouch = null;
    removeDrag = null;
    wdShowGhost(null);
    setHoveredItem(null);
    if (restore && removed && key) wornWear(key);
  };
  const cancelRemoveMultitouch = (e) => {
    if (removeTouch && e.touches.length > 1) clearRemoveTouch(true);
  };
  const moveRemoveTouch = (e) => {
    if (!removeTouch) return;
    const touch = Array.from(e.touches).find(t => t.identifier === removeTouch.id);
    if (!touch || e.touches.length > 1) { clearRemoveTouch(true); return; }
    removeTouch.x = touch.clientX;
    removeTouch.y = touch.clientY;
    if (!removeTouch.dragging) {
      if (Math.hypot(touch.clientX - removeTouch.sx, touch.clientY - removeTouch.sy) > 8) {
        clearRemoveTouch(false);
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    wdMoveGhost(touch.clientX, touch.clientY);
    if (removeDrag && !removeDrag.removed && Math.hypot(touch.clientX - removeDrag.x, touch.clientY - removeDrag.y) > 6) {
      removeDrag.removed = true;
      wornRemove(removeDrag.key);
      setHoveredItem(null);
    }
  };
  const endRemoveTouch = (e) => {
    if (!removeTouch) return;
    const touch = Array.from(e.changedTouches).find(t => t.identifier === removeTouch.id);
    if (!touch) return;
    const restore = !!(removeDrag && removeDrag.removed && Live2D.isOverModel(touch.clientX, touch.clientY));
    if (removeTouch.dragging) {
      e.preventDefault();
      e.stopPropagation();
    }
    clearRemoveTouch(restore);
  };
  const cancelRemoveTouch = () => clearRemoveTouch(true);
  window.addEventListener('touchstart', (e) => {
    if (!document.body.classList.contains('wardrobe-open') || looksOpen()) return;
    if (removeTouch || removeDrag || e.touches.length !== 1) return;
    if (e.target && e.target.closest && e.target.closest('.wardrobe-overlay, .wd-optpop, .omega-color-picker, button, a, input, textarea, select, .composer, .conv-sidebar, .app-header')) return;
    const touch = e.changedTouches[0];
    const worn = wornDrawableMap();
    const hit = wornHitAt(touch.clientX, touch.clientY, worn);
    if (!hit) return;
    removeTouch = {
      id: touch.identifier,
      key: worn.get(hit),
      sx: touch.clientX,
      sy: touch.clientY,
      x: touch.clientX,
      y: touch.clientY,
      dragging: false,
      timer: 0,
    };
    removeTouch.timer = setTimeout(() => {
      if (!removeTouch) return;
      removeTouch.dragging = true;
      beginRemoveDrag(removeTouch.key, removeTouch.x, removeTouch.y);
    }, 400);
    window.addEventListener('touchstart', cancelRemoveMultitouch, { capture: true, passive: true });
    window.addEventListener('touchmove', moveRemoveTouch, { capture: true, passive: false });
    window.addEventListener('touchend', endRemoveTouch, { capture: true, passive: false });
    window.addEventListener('touchcancel', cancelRemoveTouch, { capture: true, passive: true });
  }, { capture: true, passive: true });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !looksOpen() && document.body.classList.contains('wardrobe-open')) closeWardrobe();
  });

  syncWardrobe();
}

function syncWardrobe() {
  if (!wdOverlay) return;
  for (const it of ITEMS) {
    const tile = wdOverlay.querySelector(`.wd-tile[data-item="${it.key}"]`);
    if (tile) {
      tile.classList.toggle('on', !!state[it.key]);
      tile.setAttribute('aria-pressed', String(!!state[it.key]));
    }
  }
  for (const v of VARIANTS) {
    const idx = variantState[v.key] || 0;
    wdOverlay.querySelectorAll(`.wd-optorb[data-opt-orb="${v.key}"]`).forEach(orb => {
      orb.classList.toggle('set', idx > 0);
    });
    const tile = wdOverlay.querySelector(`.wd-tile[data-variant-tile="${v.key}"]`);
    if (tile) {
      tile.classList.toggle('on', idx > 0);
      if (tile.dataset.variantIndex !== String(idx)) {
        const img = tile.querySelector('img');
        const thumb = variantThumb(v, v.options[idx]);
        if (img && thumb) img.src = thumb;
        tile.dataset.variantIndex = String(idx);
      }
    }
  }
  syncOptionsPopup();
  refreshColorButtons();
}

export function openWardrobe() {
  if (!wdOverlay) buildWardrobe();
  document.body.classList.add('wardrobe-open');
  return activate();
}

let leavingWardrobePage = false;

function closeWardrobe() {
  if (leavingWardrobePage) return;
  leavingWardrobePage = true;
  playOutro().catch(() => {}).then(() => { location.href = 'index.html?from=wardrobe'; });
}
