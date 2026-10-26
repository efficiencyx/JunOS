import { makeItemColorButton } from '../wardrobe/color-picker.js?v=20';
import { bindTileDrag } from '../wardrobe/tiles.js?v=20';
import { modItemKey } from '../wardrobe/worn.js?v=18';
import { itemThumbUrl } from './layers.js?v=12';
import { ensureLoaded, followsHerColors, importZip, isEquipped, modState, mods, removeMod, setColor, setEquipped, setFollowsHerColors } from './engine.js?v=17';

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
    <input type="file" accept=".zip" hidden>`;
  const input = bar.querySelector('input');
  const msg = bar.querySelector('[data-mod-msg]');
  bar.querySelector('[data-mod-load]').addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const f = input.files[0];
    input.value = '';
    if (!f) return;
    msg.textContent = 'Loading…';
    try {
      const mod = await importZip(await f.arrayBuffer());
      msg.textContent = `Loaded "${mod.name}" - click an item to equip it`;
      renderMods();
    } catch (e) {
      console.error(e);
      msg.textContent = 'Failed: ' + e.message;
    }
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
