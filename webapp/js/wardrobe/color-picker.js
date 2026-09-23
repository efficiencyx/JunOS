import * as MobileViewport from '../core/viewport.js?v=1';
import { colorGroup } from '../outfit/catalog.js?v=1';
import { colors } from '../outfit/current.js?v=1';
import { hexToHsv, hsvToHex, normalizeHex } from '../outfit/colors.js?v=1';
import { optPopEl, positionOptionsPopup } from './tiles.js?v=4';
import { setColor } from '../outfit/apply.js?v=3';

function paintColorButton(button) {
  const keys = (button.dataset.colorKeys || '').split(',').filter(Boolean);
  const values = keys.map(key => colors[key] || null);
  button.classList.toggle('set', values.some(Boolean));
  button.querySelectorAll('.color-preview-segment').forEach((segment, i) => {
    segment.classList.toggle('unset', !values[i]);
    segment.style.background = values[i] || '';
  });
}

export function refreshColorButtons() {
  document.querySelectorAll('[data-color-keys]').forEach(paintColorButton);
}

function pickColor(key, hex) {
  setColor(key, hex);
  refreshColorButtons();
}

export let colorPickerEl = null, colorPickerAnchor = null, pickerState = null;

const COLOR_PRESETS = ['#f6d6c8', '#ef8fa9', '#c76ee8', '#7754d8', '#4b7bd8', '#41a9a2', '#76ae57', '#e2b34c', '#d76b42', '#34273f'];

let popupViewportListening = false, popupViewportRaf = 0;

export function visualViewportRect() {
  return MobileViewport.getVisualRect();
}

export function phonePopupMode() {
  return MobileViewport.isPhone();
}

export function schedulePopupPosition() {
  if (popupViewportRaf) cancelAnimationFrame(popupViewportRaf);
  popupViewportRaf = requestAnimationFrame(() => {
    popupViewportRaf = 0;
    if (colorPickerEl && !colorPickerEl.hidden && !pickerEmbedded()) positionColorPicker();
    if (optPopEl && !optPopEl.hidden) positionOptionsPopup();
  });
}

export function watchPopupViewport() {
  if (popupViewportListening) return;
  popupViewportListening = true;
  MobileViewport.subscribe(schedulePopupPosition);
}

export function pickerEmbedded() {
  return !!(colorPickerEl && colorPickerEl.classList.contains('ocp-embedded'));
}

export function closeColorPicker(focusAnchor, force) {
  if (!colorPickerEl || colorPickerEl.hidden) return;
  if (pickerEmbedded() && !force) return;
  colorPickerEl.hidden = true;
  if (focusAnchor && colorPickerAnchor) colorPickerAnchor.focus();
  colorPickerAnchor = null;
  pickerState = null;
}

function positionColorPicker() {
  if (!colorPickerAnchor || !colorPickerEl || colorPickerEl.hidden) return;
  const viewport = visualViewportRect();
  const sheet = phonePopupMode();
  colorPickerEl.classList.toggle('ocp-sheet', sheet);
  colorPickerEl.style.width = sheet ? `${viewport.width}px` : '';
  colorPickerEl.style.maxHeight = sheet ? `${Math.max(0, viewport.height - 8)}px` : '';
  if (sheet) {
    colorPickerEl.style.left = `${viewport.left}px`;
    colorPickerEl.style.top = `${Math.max(viewport.top, viewport.bottom - colorPickerEl.offsetHeight)}px`;
    return;
  }
  const anchor = colorPickerAnchor.getBoundingClientRect();
  const width = colorPickerEl.offsetWidth, height = colorPickerEl.offsetHeight;
  let left = anchor.right - width, top = anchor.bottom + 8;
  if (top + height > viewport.bottom - 8) top = anchor.top - height - 8;
  colorPickerEl.style.left = `${Math.max(viewport.left + 8, Math.min(left, viewport.right - width - 8))}px`;
  colorPickerEl.style.top = `${Math.max(viewport.top + 8, Math.min(top, viewport.bottom - height - 8))}px`;
}

function pickerColor(index = pickerState.index) {
  return pickerState.values ? pickerState.values[index] : colors[pickerState.keys[index]];
}

function commitPickerColor(hex) {
  if (pickerState.values) {
    pickerState.values[pickerState.index] = hex || null;
    pickerState.onChange(pickerState.index, hex || null);
  } else {
    pickColor(pickerState.keys[pickerState.index], hex);
  }
}

function updatePickerUI() {
  if (!pickerState) return;
  const hex = pickerColor();
  const shown = hex || hsvToHex(pickerState.hsv);
  colorPickerEl.style.setProperty('--picker-hue', `hsl(${pickerState.hsv.h} 100% 50%)`);
  const svThumb = colorPickerEl.querySelector('.ocp-sv-thumb');
  svThumb.style.left = `${pickerState.hsv.s * 100}%`;
  svThumb.style.top = `${(1 - pickerState.hsv.v) * 100}%`;
  colorPickerEl.querySelector('.ocp-hue-thumb').style.left = `${pickerState.hsv.h / 3.6}%`;
  colorPickerEl.querySelector('.ocp-sv').setAttribute('aria-valuetext',
    `Saturation ${Math.round(pickerState.hsv.s * 100)}%, brightness ${Math.round(pickerState.hsv.v * 100)}%`);
  colorPickerEl.querySelector('.ocp-hue').setAttribute('aria-valuenow', String(Math.round(pickerState.hsv.h)));
  colorPickerEl.querySelector('.ocp-current').style.background = shown;
  const input = colorPickerEl.querySelector('.ocp-hex');
  input.value = shown.toUpperCase();
  input.classList.remove('invalid');
  const clear = colorPickerEl.querySelector('.ocp-clear');
  clear.disabled = !hex;
  clear.textContent = hex ? 'Use default' : 'Using default';
  colorPickerEl.querySelectorAll('.ocp-channel').forEach((button, i) => {
    button.classList.toggle('active', i === pickerState.index);
    button.setAttribute('aria-selected', String(i === pickerState.index));
    const dot = button.querySelector('i'), value = pickerColor(i);
    dot.classList.toggle('unset', !value);
    dot.style.background = value || '';
  });
}

function selectPickerChannel(index) {
  if (!pickerState || !pickerState.labels[index]) return;
  pickerState.index = index;
  pickerState.hsv = hexToHsv(pickerColor(index) || '#ffffff');
  updatePickerUI();
}

function applyPickerHsv() {
  commitPickerColor(hsvToHex(pickerState.hsv));
  updatePickerUI();
}

function beginColorPointer(event, element, onMove) {
  if (event.button !== 0) return;
  event.preventDefault();
  const id = event.pointerId;
  const move = (e) => { if (e.pointerId === id) onMove(e, element.getBoundingClientRect()); };
  const end = (e) => {
    if (e.pointerId !== id) return;
    element.removeEventListener('pointermove', move);
    element.removeEventListener('pointerup', end);
    element.removeEventListener('pointercancel', end);
  };
  element.setPointerCapture(id);
  element.addEventListener('pointermove', move);
  element.addEventListener('pointerup', end);
  element.addEventListener('pointercancel', end);
  move(event);
}

function buildColorPicker() {
  if (colorPickerEl) return;
  watchPopupViewport();
  colorPickerEl = document.createElement('div');
  colorPickerEl.className = 'omega-color-picker';
  colorPickerEl.hidden = true;
  colorPickerEl.setAttribute('role', 'dialog');
  colorPickerEl.setAttribute('aria-label', 'Color picker');
  colorPickerEl.innerHTML = `
    <div class="ocp-head"><div><b class="ocp-title"></b><span>Item colors</span></div><button type="button" class="ocp-close" aria-label="Close color picker">×</button></div>
    <div class="ocp-channels" role="tablist"></div>
    <div class="ocp-sv" role="slider" tabindex="0" aria-label="Saturation and brightness"><i class="ocp-sv-thumb"></i></div>
    <div class="ocp-hue" role="slider" tabindex="0" aria-label="Hue"><i class="ocp-hue-thumb"></i></div>
    <div class="ocp-value-row"><i class="ocp-current"></i><input class="ocp-hex" type="text" maxlength="7" spellcheck="false" aria-label="Hex color"></div>
    <div class="ocp-presets" aria-label="Color presets"></div><button type="button" class="ocp-clear">Use default</button>
    <label class="ocp-toggle" hidden><span class="ocp-toggle-text"></span><input type="checkbox"><i></i></label>`;
  document.body.appendChild(colorPickerEl);
  colorPickerEl.querySelector('.ocp-close').addEventListener('click', () => closeColorPicker(true));
  colorPickerEl.querySelector('.ocp-toggle input').addEventListener('change', (e) => {
    if (pickerState && pickerState.toggle) pickerState.toggle.set(e.target.checked);
  });
  const sv = colorPickerEl.querySelector('.ocp-sv');
  sv.addEventListener('pointerdown', (e) => beginColorPointer(e, sv, (ev, rect) => {
    pickerState.hsv.s = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    pickerState.hsv.v = Math.max(0, Math.min(1, 1 - (ev.clientY - rect.top) / rect.height));
    applyPickerHsv();
  }));
  sv.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === 'ArrowLeft') pickerState.hsv.s -= step;
    else if (e.key === 'ArrowRight') pickerState.hsv.s += step;
    else if (e.key === 'ArrowUp') pickerState.hsv.v += step;
    else if (e.key === 'ArrowDown') pickerState.hsv.v -= step;
    else return;
    e.preventDefault();
    pickerState.hsv.s = Math.max(0, Math.min(1, pickerState.hsv.s));
    pickerState.hsv.v = Math.max(0, Math.min(1, pickerState.hsv.v));
    applyPickerHsv();
  });
  const hue = colorPickerEl.querySelector('.ocp-hue');
  hue.addEventListener('pointerdown', (e) => beginColorPointer(e, hue, (ev, rect) => {
    pickerState.hsv.h = Math.max(0, Math.min(359.99, (ev.clientX - rect.left) / rect.width * 360));
    applyPickerHsv();
  }));
  hue.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    pickerState.hsv.h = (pickerState.hsv.h + (e.key === 'ArrowRight' ? 3 : 357)) % 360;
    applyPickerHsv();
  });
  const hexInput = colorPickerEl.querySelector('.ocp-hex');
  const submitHex = () => {
    const hex = normalizeHex(hexInput.value);
    if (!hex) { hexInput.classList.add('invalid'); return; }
    pickerState.hsv = hexToHsv(hex);
    commitPickerColor(hex);
    updatePickerUI();
  };
  hexInput.addEventListener('change', submitHex);
  hexInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitHex(); } });
  colorPickerEl.querySelector('.ocp-clear').addEventListener('click', () => {
    commitPickerColor(null);
    pickerState.hsv = hexToHsv('#ffffff');
    updatePickerUI();
  });
  const presets = colorPickerEl.querySelector('.ocp-presets');
  for (const color of COLOR_PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.style.background = color;
    button.title = color.toUpperCase();
    button.setAttribute('aria-label', `Use ${color}`);
    button.addEventListener('click', () => {
      pickerState.hsv = hexToHsv(color);
      commitPickerColor(color);
      updatePickerUI();
    });
    presets.appendChild(button);
  }
  document.addEventListener('pointerdown', (e) => {
    if (!colorPickerEl.hidden && !colorPickerEl.contains(e.target) && !(colorPickerAnchor && colorPickerAnchor.contains(e.target))) closeColorPicker(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !colorPickerEl.hidden) { e.stopPropagation(); closeColorPicker(true); }
  }, true);
  window.addEventListener('scroll', (e) => {
    if (colorPickerEl.hidden || pickerEmbedded()) return;
    if (e.target instanceof Node && colorPickerEl.contains(e.target)) return;
    if (phonePopupMode() || colorPickerEl.contains(document.activeElement)) schedulePopupPosition();
    else closeColorPicker(false);
  }, true);
}

export function showColorPicker(anchor, label, state, embedContainer) {
  buildColorPicker();
  if (embedContainer) {
    colorPickerEl.classList.add('ocp-embedded');
    colorPickerEl.classList.remove('ocp-sheet');
    if (colorPickerEl.parentElement !== embedContainer) embedContainer.appendChild(colorPickerEl);
    colorPickerAnchor = null;
  } else {
    colorPickerEl.classList.remove('ocp-embedded');
    if (colorPickerEl.parentElement !== document.body) document.body.appendChild(colorPickerEl);
    colorPickerAnchor = anchor;
  }
  colorPickerEl.style.left = '';
  colorPickerEl.style.top = '';
  colorPickerEl.style.width = '';
  colorPickerEl.style.maxHeight = '';
  pickerState = { ...state, index: 0, hsv: hexToHsv('#ffffff') };
  if (!pickerState.labels.length) return;
  colorPickerEl.querySelector('.ocp-title').textContent = label;
  const channels = colorPickerEl.querySelector('.ocp-channels');
  channels.innerHTML = '';
  channels.hidden = pickerState.labels.length < 2;
  pickerState.labels.forEach((channelLabel, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ocp-channel';
    button.setAttribute('role', 'tab');
    const dot = document.createElement('i'), text = document.createElement('span');
    text.textContent = channelLabel;
    button.append(dot, text);
    button.addEventListener('click', () => selectPickerChannel(index));
    channels.appendChild(button);
  });
  const toggle = colorPickerEl.querySelector('.ocp-toggle');
  toggle.hidden = !pickerState.toggle;
  if (pickerState.toggle) {
    toggle.querySelector('.ocp-toggle-text').textContent = pickerState.toggle.label;
    toggle.querySelector('input').checked = !!pickerState.toggle.get();
  }
  colorPickerEl.hidden = false;
  selectPickerChannel(0);
  if (!embedContainer) positionColorPicker();
}

function openColorPicker(anchor, keys, label) {
  const validKeys = keys.filter(key => key in colors);
  showColorPicker(anchor, label, {
    keys: validKeys,
    labels: validKeys.map(key => (colorGroup(key) || {}).label || key),
  });
}

export function makeItemColorButton(label, slotLabels, initialValues, onChange, className = 'wd-swatch', toggle = null) {
  const values = slotLabels.map((_, i) => initialValues[i] || null);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.title = `${label} colors · right-click to clear`;
  button.setAttribute('aria-label', `Choose ${label} colors`);
  const segments = slotLabels.map(() => {
    const segment = document.createElement('i');
    segment.className = 'color-preview-segment';
    button.appendChild(segment);
    return segment;
  });
  const paint = () => {
    button.classList.toggle('set', values.some(Boolean));
    segments.forEach((segment, i) => {
      segment.classList.toggle('unset', !values[i]);
      segment.style.background = values[i] || '';
    });
  };
  const setExternal = (index, hex) => {
    values[index] = hex || null;
    paint();
    onChange(index, hex || null);
  };
  paint();
  button.addEventListener('pointerdown', (e) => e.stopPropagation());
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    showColorPicker(button, label, { values, labels: slotLabels, onChange: setExternal, toggle });
  });
  button.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    slotLabels.forEach((_, index) => setExternal(index, null));
  });
  return button;
}

export function makeColorButton(groupKeys, label, className) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.dataset.colorKeys = groupKeys.join(',');
  button.dataset.colorLabel = label.toLowerCase();
  button.title = `${label} colors · right-click to clear`;
  button.setAttribute('aria-label', `Choose ${label} colors`);
  for (let i = 0; i < groupKeys.length; i++) {
    const segment = document.createElement('i');
    segment.className = 'color-preview-segment';
    button.appendChild(segment);
  }
  paintColorButton(button);
  button.addEventListener('pointerdown', (e) => e.stopPropagation());
  button.addEventListener('click', (e) => { e.stopPropagation(); openColorPicker(button, groupKeys, label); });
  button.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    groupKeys.forEach(key => pickColor(key, null));
  });
  return button;
}
