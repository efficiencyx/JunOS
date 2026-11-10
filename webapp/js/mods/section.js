import { makeItemColorButton } from '../wardrobe/color-picker.js?v=36';
import { bindTileDrag } from '../wardrobe/tiles.js?v=36';
import { modItemKey } from '../wardrobe/worn.js?v=32';
import { itemThumbUrl } from './layers.js?v=19';
import { ensureLoaded, followsHerColors, importZip, isEquipped, modState, mods, removeMod, setColor, setEquipped, setFollowsHerColors } from './engine.js?v=31';

let uiBody = null;

export function syncModTiles() {
  if (!uiBody) return;
  for (const mod of mods) mod.items.forEach((_, i) => {
    const tile = uiBody.querySelector(`.wd-tile[data-mod-item="${modItemKey(mod.guid, i)}"]`);
    if (tile) tile.classList.toggle('on', isEquipped(mod, i));
  });
}

export function buildWardrobeSection(body) {
  uiBody = body;
  const t = document.createElement('div');
  t.className = 'wd-section';
  t.textContent = 'Mods';
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:8px;align-items:center;margin:4px 0 8px';
  bar.innerHTML = `<button class="ghost" data-mod-load>Load mod (.zip)</button>
    <span data-mod-msg style="font-size:12px;opacity:.7">Mods stay in your browser - nothing is uploaded</span>
    <input type="file" accept=".zip" multiple hidden>`;
  const input = bar.querySelector('input');
  const msg = bar.querySelector('[data-mod-msg]');
  bar.querySelector('[data-mod-load]').addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    // copy first: clearing the value also empties the live FileList
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;
    const loaded = [], failed = [];
    for (const [n, f] of files.entries()) {
      msg.textContent = files.length > 1 ? `Loading ${n + 1}/${files.length}…` : 'Loading…';
      // one at a time: importZip rewrites the shared mod list and state,
      // and one bad zip must not stop the rest
      try {
        const mod = await importZip(await f.arrayBuffer());
        loaded.push(mod.name);
        renderMods();
      } catch (e) {
        console.error(e);
        failed.push({ file: f.name, error: e.message });
      }
    }
    if (files.length === 1) {
      msg.textContent = loaded.length
        ? `Loaded "${loaded[0]}" - click an item to equip it`
        : 'Failed: ' + failed[0].error;
      return;
    }
    const parts = [];
    if (loaded.length) parts.push(`Loaded ${loaded.length} mod${loaded.length > 1 ? 's' : ''} - click an item to equip it`);
    if (failed.length) parts.push('Failed: ' + failed.map(x => `${x.file} (${x.error})`).join(', '));
    msg.textContent = parts.join('. ');
  });
  const list = document.createElement('div');
  list.dataset.modList = '1';
  body.append(t, bar, list);
  ensureLoaded().then(renderMods);
}

function renderMods() {
  const list = uiBody && uiBody.querySelector('[data-mod-list]');
  if (!list) return;
  list.innerHTML = '';
  for (const mod of mods) {
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;gap:8px;align-items:center;margin:6px 0 4px;font-size:13px';
    const title = document.createElement('b');
    title.textContent = mod.name;
    const remove = document.createElement('button');
    remove.className = 'ghost';
    remove.title = 'Remove mod';
    remove.textContent = '×';
    head.append(title, remove);
    remove.addEventListener('click', async () => {
      await removeMod(mod.guid);
      renderMods();
    });
    const grid = document.createElement('div');
    grid.className = 'wd-grid';
    mod.items.forEach((item, i) => {
      const tile = document.createElement('div');
      tile.className = 'wd-tile';
      tile.dataset.modItem = modItemKey(mod.guid, i);
      tile.classList.toggle('on', isEquipped(mod, i));
      const placeholder = document.createElement('div');
      placeholder.className = 'wd-noimg';
      placeholder.textContent = '…';
      const label = document.createElement('span');
      label.textContent = item.label;
      tile.append(placeholder, label);
      itemThumbUrl(mod, item).then(url => {
        if (!url) return;
        const image = document.createElement('img');
        image.draggable = false;
        image.src = url;
        tile.firstChild.replaceWith(image);
      });
      if (item.slots.length) {
        const values = ((modState(mod.guid).colors || {})[i] || []);
        tile.appendChild(makeItemColorButton(
          item.label, item.slots, values,
          (slotIndex, hex) => setColor(mod.guid, i, slotIndex, hex),
          'wd-swatch',
          {
            label: 'Follow her colors',
            get: () => followsHerColors(mod, i),
            set: (on) => setFollowsHerColors(mod.guid, i, on),
          },
        ));
      }
      const equip = async (on) => {
        await setEquipped(mod.guid, i, on);
        syncModTiles();
      };
      bindTileDrag(tile, () => equip(true), () => equip(!isEquipped(mod, i)));
      grid.appendChild(tile);
    });
    list.append(head, grid);
  }
}
