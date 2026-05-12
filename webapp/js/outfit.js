// Manual outfit/clothing customization. Bypasses the LLM: toggles drive
// Live2D params directly and the current state is injected into the system
// prompt server-side so the model knows what Jun is wearing.

window.Outfit = (function () {
  const STORAGE_KEY = 'omega.outfit.v1';
  const COLOR_KEY   = 'omega.outfit.colors.v1';

  // Each item: param-backed boolean. `excludes` = other keys to force off when this turns on.
  // `description` is the phrase used in the prompt context.
  // `colorPatterns` (optional): substring patterns matching drawable IDs to tint
  //   when the user picks a color. `colorExcludes` removes false positives.
  const ITEMS = [
    { key: 'shirt',   label: 'Shirt',     param: 'ParamShirtEnabled',   defaultOn: true,  excludes: ['dress'],
      colorPatterns: ['shirt'] },
    { key: 'hoodie',  label: 'Hoodie',    param: 'ParamHoodieEnabled',  defaultOn: false, excludes: ['dress'],
      colorPatterns: ['hoodie'] },
    { key: 'dress',   label: 'Dress',     param: 'ParamDress2Enabled',  defaultOn: false, excludes: ['shirt','hoodie','skirt','pants'],
      colorPatterns: ['dress'] },
    { key: 'skirt',   label: 'Skirt',     param: 'ParamSkirtEnabled',   defaultOn: true,  excludes: ['pants','dress'],
      colorPatterns: ['skirt'] },
    { key: 'pants',   label: 'Pants',     param: 'ParamPantsEnabled',   defaultOn: false, excludes: ['skirt','dress'],
      colorPatterns: ['pants'] },
    // 'bra' substring also matches SkinBraChest* (which is skin under the bra,
    // not the bra itself) — exclude 'skin' so the breast skin keeps skin tone.
    { key: 'bra',     label: 'Bra',       param: 'ParamBraEnabled',     defaultOn: true,
      colorPatterns: ['bra'], colorExcludes: ['skin'] },
    { key: 'panties', label: 'Panties',   param: 'ParamPantiesEnabled', defaultOn: true,
      colorPatterns: ['panties'] },
    { key: 'shoe_l',  label: 'Left shoe', param: 'ParamShoeLOn',        defaultOn: true,
      colorPatterns: ['shoe_l'] },
    { key: 'shoe_r',  label: 'Right shoe',param: 'ParamShoeROn',        defaultOn: true,
      colorPatterns: ['shoe_r'] },
  ];

  // Patterns tuned to this model's actual drawable IDs (see console dump).
  // All skin parts are prefixed `Skin*`; pose-time skin layers are `Attach*`.
  // MCHand* / MCForearm* are the partner-character hands.
  // Hair styles use `H0_` … `H4_` prefixes plus `*Hair*`.
  // Cat ears split Front/Mid/Back; eyes have Iris/Pupil/EyeBall/highlight.
  const COLOR_GROUPS = [
    { key: 'skin', label: 'Skin',
      includes: ['skin','attach','mchand','mcforearm','nipple','blush','moddableface','moddableback'],
      excludes: [] },

    // Hair: catches all H<digit>_ styles plus anything with "hair".
    { key: 'hair', label: 'Hair',
      includes: ['h0_','h1_','h2_','h3_','h4_','hair'],
      excludes: ['hairband','hairpin','hairtie','hairclip','hairbow'] },

    // Cat ears: broad, then per-layer narrow overrides.
    { key: 'ear',       label: 'Ear (all)',  includes: ['catear','pointyear'], excludes: [] },
    { key: 'ear_back',  label: 'Ear back',   includes: ['catearback'],         excludes: [] },
    { key: 'ear_mid',   label: 'Ear inside', includes: ['catearmid'],          excludes: [] },
    { key: 'ear_front', label: 'Ear front',  includes: ['catearfront'],        excludes: [] },

    // Body tail (TailMain*); H4_Tail is part of the hair group.
    { key: 'tail', label: 'Tail', includes: ['tailmain'], excludes: [] },

    { key: 'eyebrows', label: 'Eyebrows', includes: ['brow'], excludes: [] },

    // Eye stack: sclera/iris/pupil/highlight, each overrides the previous.
    { key: 'eye_sclera',    label: 'Eye white', includes: ['eyeball'],  excludes: [] },
    { key: 'eye_iris',      label: 'Eye iris',  includes: ['iris'],     excludes: [] },
    { key: 'eye_pupil',     label: 'Eye pupil', includes: ['pupil'],    excludes: [] },
    { key: 'eye_highlight', label: 'Eye shine', includes: ['highlight'], excludes: [] },

    { key: 'lips', label: 'Lips', includes: ['lip'], excludes: [] },

    { key: 'mouth_interior', label: 'Mouth interior',
      includes: ['innermouth','tounge','tongue','teeth','saliva'], excludes: [] },

    // Wardrobe items (clothing pieces).
    ...ITEMS.filter(it => it.colorPatterns).map(it => ({
      key: it.key, label: it.label,
      includes: it.colorPatterns, excludes: it.colorExcludes || [],
    })),
  ];

  const state = {};
  for (const it of ITEMS) state[it.key] = it.defaultOn;

  // colors[groupKey] = '#rrggbb' or null (no override).
  const colors = {};
  for (const g of COLOR_GROUPS) colors[g.key] = null;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        for (const it of ITEMS) {
          if (typeof saved[it.key] === 'boolean') state[it.key] = saved[it.key];
        }
      }
    } catch (e) { /* ignore */ }
    try {
      const raw = localStorage.getItem(COLOR_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        for (const g of COLOR_GROUPS) {
          if (typeof saved[g.key] === 'string' || saved[g.key] === null) {
            colors[g.key] = saved[g.key];
          }
        }
      }
    } catch (e) { /* ignore */ }
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function saveColors() {
    try { localStorage.setItem(COLOR_KEY, JSON.stringify(colors)); } catch (e) {}
  }

  function applyAll() {
    for (const it of ITEMS) {
      Live2D.setTarget(it.param, state[it.key] ? 1 : 0);
    }
    applyColors();
  }

  function hexToRgb01(hex) {
    if (!hex) return null;
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
  }

  function applyColors() {
    if (!Live2D.tintByPattern || !Live2D.findDrawables || !Live2D.setDrawableTint) return;
    // Two-pass: clear every drawable any group could touch, then paint each
    // active group in declared order. This way a narrow group whose color was
    // cleared can't accidentally erase the broad group's color underneath.
    const touched = new Set();
    for (const g of COLOR_GROUPS) {
      for (const id of Live2D.findDrawables(g.includes, g.excludes)) touched.add(id);
    }
    for (const id of touched) Live2D.setDrawableTint(id, null);
    for (const g of COLOR_GROUPS) {
      const rgb = hexToRgb01(colors[g.key]);
      if (rgb) Live2D.tintByPattern(g.includes, g.excludes, rgb);
    }
  }

  function setItem(key, on) {
    const it = ITEMS.find(x => x.key === key);
    if (!it) return;
    state[key] = !!on;
    if (state[key] && it.excludes) {
      for (const ex of it.excludes) state[ex] = false;
    }
    save();
    applyAll();
    syncUI();
  }

  function setColor(key, hex) {
    if (!(key in colors)) return;
    colors[key] = hex || null;
    saveColors();
    applyColors();
  }

  let containerEl = null;
  function syncUI() {
    if (!containerEl) return;
    for (const it of ITEMS) {
      const cb = containerEl.querySelector(`input[type="checkbox"][data-key="${it.key}"]`);
      if (cb) cb.checked = state[it.key];
    }
    for (const g of COLOR_GROUPS) {
      const cp = containerEl.querySelector(`input[type="color"][data-color-key="${g.key}"]`);
      const btn = containerEl.querySelector(`button[data-color-clear="${g.key}"]`);
      if (cp) cp.value = colors[g.key] || '#ffffff';
      if (btn) btn.classList.toggle('active', !!colors[g.key]);
    }
  }

  function reset() {
    for (const it of ITEMS) state[it.key] = it.defaultOn;
    for (const g of COLOR_GROUPS) colors[g.key] = null;
    save();
    saveColors();
    applyAll();
    syncUI();
  }

  function buildUI(rootEl, resetBtn) {
    containerEl = rootEl;
    rootEl.innerHTML = '';
    rootEl.classList.remove('outfit-grid');

    // Toggle grid (existing behavior).
    const grid = document.createElement('div');
    grid.className = 'outfit-grid';
    for (const it of ITEMS) {
      const row = document.createElement('label');
      row.className = 'outfit-row';
      row.innerHTML = `<input type="checkbox" data-key="${it.key}"><span>${it.label}</span>`;
      const cb = row.querySelector('input');
      cb.checked = state[it.key];
      cb.addEventListener('change', () => setItem(it.key, cb.checked));
      grid.appendChild(row);
    }
    rootEl.appendChild(grid);

    // Color pickers (skin + one per clothing item).
    const colorWrap = document.createElement('div');
    colorWrap.className = 'outfit-colors';
    const title = document.createElement('div');
    title.className = 'outfit-colors-title';
    title.textContent = 'Colori';
    colorWrap.appendChild(title);

    for (const g of COLOR_GROUPS) {
      const matchCount = Live2D.findDrawables ? Live2D.findDrawables(g.includes, g.excludes).length : 0;
      const matchedIds = Live2D.findDrawables ? Live2D.findDrawables(g.includes, g.excludes) : [];
      const row = document.createElement('div');
      row.className = 'outfit-color-row';
      row.title = matchedIds.length ? matchedIds.join('\n') : '(nessun drawable corrispondente)';
      row.innerHTML = `
        <span class="outfit-color-label">${g.label}</span>
        <span class="outfit-color-count ${matchCount === 0 ? 'zero' : ''}">${matchCount}</span>
        <input type="color" data-color-key="${g.key}" value="${colors[g.key] || '#ffffff'}">
        <button class="ghost outfit-color-clear ${colors[g.key] ? 'active' : ''}" data-color-clear="${g.key}" title="Rimuovi tinta">×</button>
      `;
      const cp  = row.querySelector('input[type="color"]');
      const clr = row.querySelector('button[data-color-clear]');
      cp.addEventListener('input',  () => { setColor(g.key, cp.value); clr.classList.add('active'); });
      cp.addEventListener('change', () => { setColor(g.key, cp.value); clr.classList.add('active'); });
      clr.addEventListener('click', () => { setColor(g.key, null); cp.value = '#ffffff'; clr.classList.remove('active'); });
      colorWrap.appendChild(row);
    }
    rootEl.appendChild(colorWrap);

    if (resetBtn) resetBtn.addEventListener('click', reset);
  }

  // Phrase for the system prompt.
  function describe() {
    const worn = ITEMS.filter(it => state[it.key]);
    const bare = ITEMS.filter(it => !state[it.key]);
    const phrase = (arr) => arr.map(it => it.label.toLowerCase()).join(', ');
    if (worn.length === 0) return 'Jun is currently fully nude (wearing nothing).';
    let s = `Jun is currently wearing: ${phrase(worn)}.`;
    if (bare.length) s += ` Not wearing: ${phrase(bare)}.`;
    return s;
  }

  function snapshot() {
    const out = {};
    for (const it of ITEMS) out[it.key] = state[it.key];
    return out;
  }

  // Mirror state when the LLM emits an outfit/nude action, so the panel,
  // localStorage, and the next system-prompt all stay in sync with reality.
  // Item kwargs come from action_map.json's outfit._resolve table.
  function syncFromAction(name, kwargs) {
    const n = (name || '').toLowerCase();
    let dirty = false;
    const setKey = (key, on) => {
      const it = ITEMS.find(x => x.key === key);
      if (!it || state[key] === !!on) return;
      state[key] = !!on;
      if (state[key] && it.excludes) {
        for (const ex of it.excludes) state[ex] = false;
      }
      dirty = true;
    };

    if (n === 'outfit') {
      const item = (kwargs.item || '').toLowerCase();
      const stateOn = (kwargs.state || 'on').toLowerCase() === 'on';
      switch (item) {
        case 'shirt': case 'hoodie': case 'skirt': case 'pants':
        case 'dress': case 'bra': case 'panties':
          setKey(item, stateOn); break;
        case 'shoes':
          setKey('shoe_l', stateOn); setKey('shoe_r', stateOn); break;
        case 'shoe_left':  setKey('shoe_l', stateOn); break;
        case 'shoe_right': setKey('shoe_r', stateOn); break;
        case 'nude':
          if (stateOn) for (const it of ITEMS) setKey(it.key, false);
          break;
        // skirt_up / panties_aside are pose-y, not wardrobe state — ignore.
      }
    }

    if (dirty) { save(); syncUI(); }
  }

  return { load, buildUI, applyAll, describe, snapshot, reset, syncFromAction };
})();
