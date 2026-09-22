import { Presets, applyPreset, decodeOutfitCode, encodeOutfitCode, endPreview, schedulePreview } from '../outfit/presets.js?v=3';
import { clearWornHover, wdOverlay } from './panel.js?v=4';

export const looksOpen = () => document.body.classList.contains('looks-open');

export let looksEl = null, looksActiveId = null;

function buildLooks() {
  looksEl = document.createElement('div');
  looksEl.className = 'wd-looks-modal';
  looksEl.hidden = true;
  looksEl.setAttribute('role', 'dialog');
  looksEl.setAttribute('aria-modal', 'true');
  looksEl.setAttribute('aria-label', 'Saved outfits');
  looksEl.innerHTML = `<div class="wd-looks-backdrop"></div>
    <div class="wd-looks-dialog">
      <div class="wd-looks-side">
        <div class="wd-optpop-head">
          <div class="wd-optpop-title">Saved outfits</div>
          <button type="button" class="wd-optpop-close" aria-label="Close saved outfits" title="Close">×</button>
        </div>
        <div class="wd-looks-save">
          <input class="wd-looks-name" type="text" maxlength="60" placeholder="Name this outfit" aria-label="Outfit name">
          <button type="button" class="ghost wd-looks-add">Save current</button>
        </div>
        <div class="wd-looks-share">
          <button type="button" class="ghost wd-looks-copy">Copy share code</button>
          <button type="button" class="ghost wd-looks-import">Wear shared code</button>
        </div>
        <div class="wd-looks-list" role="list"></div>
        <div class="wd-looks-hint"></div>
      </div>
      <div class="wd-looks-stage" aria-hidden="true"></div>
    </div>`;
  document.body.appendChild(looksEl);

  const list = looksEl.querySelector('.wd-looks-list');
  const hint = looksEl.querySelector('.wd-looks-hint');
  const nameInput = looksEl.querySelector('.wd-looks-name');
  const coarsePointer = matchMedia('(pointer: coarse)');

  const stamp = (t) => {
    const d = new Date(t * 1000);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  function render() {
    list.innerHTML = '';
    for (const p of Presets.cache) {
      const row = document.createElement('div');
      row.className = 'wd-look';
      row.setAttribute('role', 'listitem');
      row.classList.toggle('on', String(p.id) === String(looksActiveId));

      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'wd-look-main';
      main.innerHTML = `<span class="wd-look-name"></span><span class="wd-look-date">${stamp(p.updated_at)}</span>`;
      main.querySelector('.wd-look-name').textContent = p.name;

      const preview = () => schedulePreview(p.data);
      if (!coarsePointer.matches) {
        main.addEventListener('pointerenter', preview);
        main.addEventListener('pointerleave', endPreview);
      }
      main.addEventListener('focus', preview);
      main.addEventListener('blur', endPreview);
      main.addEventListener('click', () => {
        applyPreset(p.data);
        looksActiveId = p.id;
        nameInput.value = p.name;
        render();
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'wd-look-del';
      del.title = `Delete "${p.name}"`;
      del.setAttribute('aria-label', `Delete ${p.name}`);
      del.textContent = '×';
      del.addEventListener('click', async () => {
        if (!window.confirm(`Delete the outfit "${p.name}"?`)) return;
        endPreview();
        try {
          await Presets.remove(p.id);
          if (String(looksActiveId) === String(p.id)) looksActiveId = null;
          render();
        } catch (e) { hint.textContent = 'Could not delete that outfit.'; }
      });

      row.append(main, del);
      list.appendChild(row);
    }
    if (!Presets.cache.length) {
      const empty = document.createElement('div');
      empty.className = 'wd-looks-empty';
      empty.textContent = 'No outfits saved yet. Dress Jun, then name and save the outfit.';
      list.appendChild(empty);
    }
    hint.textContent = Presets.cache.length
      ? (coarsePointer.matches ? 'Tap an outfit to wear it' : 'Hover an outfit to preview it on Jun · click to wear it')
      : '';
  }

  async function saveCurrent() {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    endPreview();
    try {
      await Presets.save(name);
      const saved = Presets.cache.find(p => p.name === name);
      looksActiveId = saved ? saved.id : null;
      render();
    } catch (e) { hint.textContent = 'Could not save that outfit.'; }
  }
  looksEl.querySelector('.wd-looks-add').addEventListener('click', saveCurrent);
  looksEl.querySelector('.wd-looks-copy').addEventListener('click', async () => {
    let code;
    try {
      code = encodeOutfitCode();
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(code);
      hint.textContent = 'Outfit code copied. Anyone can import it from this panel.';
    } catch (e) {
      if (code) window.prompt('Copy this outfit code:', code);
      else hint.textContent = 'Could not create an outfit code.';
    }
  });
  looksEl.querySelector('.wd-looks-import').addEventListener('click', async () => {
    const code = window.prompt('Paste an outfit code:');
    if (code === null) return;
    try {
      await applyPreset(decodeOutfitCode(code));
      looksActiveId = null;
      nameInput.value = '';
      render();
      hint.textContent = 'Shared outfit equipped. Name it above if you want to save it.';
    } catch (e) {
      hint.textContent = 'That outfit code is invalid.';
    }
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveCurrent(); }
  });
  looksEl.querySelector('.wd-optpop-close').addEventListener('click', () => toggleLooks(false));
  looksEl.querySelector('.wd-looks-backdrop').addEventListener('click', () => toggleLooks(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !looksEl.hidden) toggleLooks(false);
  });

  // no second renderer for the preview. the existing Live2D
  // stage gets moved over the pane instead.
  const pane = looksEl.querySelector('.wd-looks-stage');
  if (window.ResizeObserver) new ResizeObserver(syncStageHole).observe(pane);
  window.addEventListener('resize', () => { if (!looksEl.hidden) syncStageHole(); });

  looksEl.render = render;
  render();
  Presets.list().then(render).catch(() => { hint.textContent = 'Could not load your saved outfits.'; });
}

function syncStageHole() {
  const stage = document.getElementById('stage');
  if (!stage || !looksEl || looksEl.hidden) return;
  const r = looksEl.querySelector('.wd-looks-stage').getBoundingClientRect();
  if (!r.width || !r.height) return;
  stage.style.inset = `${r.top}px ${innerWidth - r.right}px ${innerHeight - r.bottom}px ${r.left}px`;
}

export function toggleLooks(force) {
  if (!looksEl) buildLooks();
  const open = force === undefined ? looksEl.hidden : force;
  if (!open) endPreview();
  looksEl.hidden = !open;
  document.body.classList.toggle('looks-open', open);
  if (open && clearWornHover) clearWornHover();
  if (wdOverlay) wdOverlay.querySelector('.wd-looks').classList.toggle('on', open);
  const stage = document.getElementById('stage');
  if (open) {
    syncStageHole();
    Presets.list().then(looksEl.render).catch(() => {});
    looksEl.querySelector('.wd-looks-name').focus();
  } else if (stage) {
    stage.style.inset = '';
  }
}
