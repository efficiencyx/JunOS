// Manual outfit/clothing customization. Bypasses the LLM: toggles drive
// Live2D params directly and the current state is injected into the system
// prompt server-side so the model knows what Jun is wearing.

window.Outfit = (function () {
  const STORAGE_KEY = 'omega.outfit.v1';
  const COLOR_KEY = 'omega.outfit.colors.v1';
  const VARIANT_KEY = 'omega.outfit.variants.v1';

  // Each item is a param-backed boolean. `excludes` lists other keys to force
  // off when this one turns on. `colorPatterns` are substrings matched against
  // drawable IDs to tint when the user picks a color, and `colorExcludes`
  // trims false positives from that match.
  const ITEMS = [
    { key: 'shirt', label: 'Shirt', param: 'ParamShirtEnabled', defaultOn: true, excludes: ['dress','dress1'],
      colorPatterns: ['shirt'] },
    { key: 'hoodie', label: 'Hoodie', param: 'ParamHoodieEnabled', defaultOn: false, excludes: ['dress','dress1'],
      colorPatterns: ['hoodie'] },
    { key: 'dress', label: 'Dress', param: 'ParamDress2Enabled', defaultOn: false, excludes: ['shirt','hoodie','skirt','pants','dress1'],
      colorPatterns: ['dress'] },
    // Dress1 (Dress1_*) is a second, alternative dress that has NO enable param
    // in the rig - its drawables carry full geometry but are hidden by opacity 0
    // (which also clears their IsVisible flag). So it's a force-SHOW item:
    // visOn=1 forces opacity+visible on, visOff=null lets the rig hide it again.
    { key: 'dress1', label: 'Dress (alt)', defaultOn: false,
      excludes: ['shirt','hoodie','skirt','pants','dress'],
      colorPatterns: ['dress1'], visibilityPatterns: ['dress1'], visOn: 1, visOff: null },
    { key: 'skirt', label: 'Skirt', param: 'ParamSkirtEnabled', defaultOn: true, excludes: ['pants','dress','dress1'],
      colorPatterns: ['skirt'] },
    { key: 'pants', label: 'Pants', param: 'ParamPantsEnabled', defaultOn: false, excludes: ['skirt','dress','dress1'],
      colorPatterns: ['pants'] },
    // The 'bra' substring also hits SkinBraChest* (the skin under the bra, not
    // the bra itself), so exclude 'skin' to keep that area skin-toned.
    { key: 'bra', label: 'Bra', param: 'ParamBraEnabled', defaultOn: true,
      colorPatterns: ['bra'], colorExcludes: ['skin'] },
    { key: 'panties', label: 'Panties', param: 'ParamPantiesEnabled', defaultOn: true,
      colorPatterns: ['panties'] },
    // ParamShoeLOn/ROn are NOT wired to the shoe drawable opacity in this moc3,
    // and the current rig keeps Shoe_L/R and StockingL/R at opacity 0 by
    // default (verified: forcing opacity 1 makes them appear). So like Dress1
    // they are force-SHOW items: visOn=1 overrides the rig, visOff=0 hides.
    { key: 'shoe_l', label: 'Left shoe', param: 'ParamShoeLOn', defaultOn: true,
      colorPatterns: ['shoe_l'], visibilityPatterns: ['shoe_l'], visOn: 1, visOff: 0 },
    { key: 'shoe_r', label: 'Right shoe', param: 'ParamShoeROn', defaultOn: true,
      colorPatterns: ['shoe_r'], visibilityPatterns: ['shoe_r'], visOn: 1, visOff: 0 },
    // Stockings (StockingL/StockingR) have no enable parameter at all, so they
    // are visibility-only: driven purely by the opacity override.
    { key: 'stockings', label: 'Stockings', defaultOn: true,
      colorPatterns: ['stocking'], visibilityPatterns: ['stocking'], visOn: 1, visOff: 0 },

    // --- Body parts (section: 'body'). None of these have enable params in
    // the moc3 (only clothing does), so they are all visibility-only items.
    // Colors are already handled by the ear/tail/hair COLOR_GROUPS below.
    { key: 'cat_ears', label: 'Cat ears', section: 'body', defaultOn: true,
      visibilityPatterns: ['catear'], excludes: ['pointy_ears'] },
    // The current rig shows PointyEar* by default, so the toggle must be
    // authoritative both ways: visOn=1 force-shows, visOff=0 force-hides.
    { key: 'pointy_ears', label: 'Pointy ears', section: 'body', defaultOn: false,
      visibilityPatterns: ['pointyear'], visOn: 1, visOff: 0,
      excludes: ['cat_ears'] },
    { key: 'tail', label: 'Tail', section: 'body', defaultOn: true,
      visibilityPatterns: ['tailmain'] },
    { key: 'hair_hologram', label: 'Hair hologram', section: 'body', defaultOn: true,
      visibilityPatterns: ['hairhologram'] },

    // --- Hair (section: 'hair'). Numbered layer groups (H0_..H4_) are
    // alternative style pieces: the rig only shows H3 (a complete basic
    // style - Back/Back_Top/Front/Side) and keeps the rest at opacity 0, so
    // every toggle is authoritative both ways (visOn 1 forces show even when
    // the rig hides it, visOff 0 force-hides). Groups combine freely.
    { key: 'hair_h0', label: 'Default Hair', section: 'hair', defaultOn: true,
      visibilityPatterns: ['h0_'], visOn: 1, visOff: 0 },
    { key: 'hair_h1', label: 'Side Swept Hair', section: 'hair', defaultOn: false,
      visibilityPatterns: ['h1_'], visOn: 1, visOff: 0 },
    { key: 'hair_h2', label: 'Front bang', section: 'hair', defaultOn: false,
      visibilityPatterns: ['h2_'], visOn: 1, visOff: 0 },
    { key: 'hair_h3', label: 'Hime Cut Hair', section: 'hair', defaultOn: false,
      visibilityPatterns: ['h3_'], visOn: 1, visOff: 0 },
    { key: 'hair_h4', label: 'Ponytail', section: 'hair', defaultOn: false,
      visibilityPatterns: ['h4_'], visOn: 1, visOff: 0 },
  ];

  // Patterns tuned to this model's actual drawable IDs (see console dump).
  // Skin parts are prefixed Skin*, pose-time skin layers Attach*; MCHand* and
  // MCForearm* are the partner character's hands. Hair uses H0_..H4_ prefixes
  // plus *Hair*. Cat ears split Front/Mid/Back, eyes into Iris/Pupil/EyeBall/highlight.
  // Order matters here: applyColors paints groups in sequence, so a narrow group
  // listed after a broad one overrides it.
  const COLOR_GROUPS = [
    { key: 'skin', label: 'Skin',
      includes: ['skin','attach','mchand','mcforearm','nipple','moddableface','moddableback'],
      excludes: [] },

    // Blush is split out of skin so it can carry its own reddish tint. It uses
    // an additive (screen) blend instead of multiply - a red multiply just
    // darkens the cheeks into a shadow, while screen adds color for a real flush.
    { key: 'blush', label: 'Blush', includes: ['blush'], excludes: [],
      tintMode: 'screen', defaultColor: '#ff3a3a' },

    // Catches all H<digit>_ styles plus anything containing "hair". The
    // HairHologram drawable is split into its own group below, so exclude it.
    { key: 'hair', label: 'Hair',
      includes: ['h0_','h1_','h2_','h3_','h4_','hair'],
      excludes: ['hairband','hairpin','hairtie','hairclip','hairbow','hairhologram'] },

    { key: 'hair_hologram', label: 'Hair hologram', includes: ['hairhologram'], excludes: [] },

    // Cat ears: broad group first, then per-layer overrides.
    { key: 'ear', label: 'Ear (all)', includes: ['catear','pointyear'], excludes: [] },
    { key: 'ear_back', label: 'Ear back', includes: ['catearback'], excludes: [] },
    { key: 'ear_mid', label: 'Ear inside', includes: ['catearmid'], excludes: [] },
    { key: 'ear_front', label: 'Ear front', includes: ['catearfront'], excludes: [] },

    // Body tail is TailMain*; H4_Tail belongs to the hair group instead.
    { key: 'tail', label: 'Tail', includes: ['tailmain'], excludes: [] },

    { key: 'eyebrows', label: 'Eyebrows', includes: ['brow'], excludes: [] },

    { key: 'eye_sclera', label: 'Eye white', includes: ['eyeball'], excludes: [] },
    { key: 'eye_iris', label: 'Eye iris', includes: ['iris'], excludes: [] },
    { key: 'eye_pupil', label: 'Eye pupil', includes: ['pupil'], excludes: [] },
    { key: 'eye_highlight', label: 'Eye shine', includes: ['highlight'], excludes: [] },

    { key: 'lips', label: 'Lips', includes: ['lip'], excludes: [] },

    { key: 'mouth_interior', label: 'Mouth interior',
      includes: ['innermouth','tounge','tongue','teeth','saliva'], excludes: [] },

    ...ITEMS.filter(it => it.colorPatterns).map(it => ({
      key: it.key, label: it.label,
      includes: it.colorPatterns, excludes: it.colorExcludes || [],
    })),
  ];

  const state = {};
  for (const it of ITEMS) state[it.key] = it.defaultOn;

  // colors[groupKey] is '#rrggbb' or null when there's no override. A group may
  // declare a `defaultColor` that seeds the tint until the user changes/clears it.
  const colors = {};
  for (const g of COLOR_GROUPS) colors[g.key] = g.defaultColor || null;

  // Limb variants ripped from the game's PackedTexturesContainer assets:
  // per-drawable crops of the packed variant textures, saved one PNG per
  // drawable so the standard compositor can place them via each drawable's
  // own UV rect. The game creates its High-Tech limbs by cloning the matching
  // Experimental limb and calling MakeHypercamo(); that changes its Hypercamo
  // material/color state, not its drawable texture list. The separate
  // HighTechHypercamoSkin item owns the SkinArm*/SkinThigh*/SkinPelvis art.
  const LIMB_DIR = 'assets/variants/limbs';
  // alphaClip: limb crops' bounding rects overlap each other and base-skin
  // texels in the atlas, so the compositor must only erase under opaque pixels
  // (a full-rect clear punches transparent holes in neighboring drawables).
  const limbTex = (v, ids) => Object.fromEntries(
    ids.map(d => [d, { url: `${LIMB_DIR}/${v}/${d}.png`, alphaClip: true }]));
  const ARM_EXP_IDS = ['AttachArmL', 'AttachArmLHandCuddle', 'AttachArmLHandDown1',
    'AttachArmLHandDown2', 'AttachArmLHandUp1', 'AttachArmLHandUp2', 'AttachArmLHandUp3',
    'AttachArmLLowerArmDown', 'AttachArmLLowerArmUp', 'AttachArmLLowerCuddle',
    'AttachArmLLowerCuddleUp', 'AttachArmLUpperCuddle', 'AttachArmLUpperCuddleUp',
    'AttachArmR2', 'AttachArmRHandDown1', 'AttachArmRHandDown2', 'AttachArmRHandUp1',
    'AttachArmRHandUp2', 'AttachArmRHandUp3', 'AttachArmRLowerArmDown', 'AttachArmRLowerArmUp'];
  const LEG_EXP_IDS = ['AttachLegLFeet', 'AttachLegLKnee', 'AttachLegLLower', 'AttachLegLThigh',
    'AttachLegRFeet', 'AttachLegRKnee', 'AttachLegRLower', 'AttachLegRThigh'];
  // HighTechHypercamoSkin is a separate game item (ID 1200), not a limb
  // replacement. These are its own packed drawables and optional decals.
  const HT_SKIN_IDS = ['SkinArmL', 'SkinArmR', 'SkinPelvis', 'SkinThighL', 'SkinThighR',
    'barcode', 'lines'];
  // The rig draws the calf pieces over the thigh pieces; invisible on
  // contiguous flesh but wrong for the segmented mech art, where the knee
  // joint must tuck under the thigh. `order` = [below, above] draw-order pairs
  // enforced while the option is equipped.
  const LEG_ORDER = [
    ['AttachLegLLower', 'AttachLegLThigh'], ['AttachLegRLower', 'AttachLegRThigh'],
  ];

  // Alternative-clothing variants. Each slot swaps the atlas region of one or
  // more drawables with an alternative texture (game-faithful compositing via
  // Live2D.setDrawableTextures). Option 0 is the baked default (empty textures
  // = clear overrides). `textures` maps a drawable id -> variant PNG url.
  // `show` drawables are rig-hidden decals force-shown while the option is
  // active. Mech limbs follow the Skin color (its 'attach' pattern tints them).
  const VARIANTS = [
    {
      key: 'arm_style', label: 'Arms',
      drawables: ARM_EXP_IDS,
      options: [
        { name: 'Arms (standard)', textures: {} },
        { name: 'Experimental Arms', textures: limbTex('experimental', ARM_EXP_IDS) },
        // Game: ExperimentalArm.Clone().MakeHypercamo(). It retains the exact
        // Experimental drawable set; Hypercamo's color material supplies the
        // smooth shaded finish. Do not mix in HighTech Skin's SkinArm* art.
        { name: 'High-Tech Arms', textures: limbTex('experimental', ARM_EXP_IDS) },
      ],
    },
    {
      key: 'leg_style', label: 'Legs',
      drawables: LEG_EXP_IDS,
      options: [
        { name: 'Legs (standard)', textures: {} },
        { name: 'Experimental Legs', textures: limbTex('experimental', LEG_EXP_IDS), order: LEG_ORDER },
        // Game: ExperimentalLeg.Clone().MakeHypercamo(). The Skin* panels,
        // barcode, and glow lines belong to the separate HighTech Skin item.
        { name: 'High-Tech Legs', textures: limbTex('experimental', LEG_EXP_IDS), order: LEG_ORDER },
      ],
    },
    {
      key: 'hightech_skin', label: 'High-Tech Skin',
      drawables: HT_SKIN_IDS,
      options: [
        { name: 'Standard skin', textures: {} },
        // Separate game item: HightechHyperCamoSkin (ID 1200). It only swaps
        // the Skin* surface art and exposes its barcode/glow decals; it never
        // changes which arm or leg item is equipped.
        { name: 'High-Tech Skin', textures: limbTex('hightech', HT_SKIN_IDS), show: ['barcode', 'lines'] },
      ],
    },
    {
      key: 'skirt_style', label: 'Skirt style',
      drawables: ['Skirt'],
      options: [
        { name: 'Pleated', textures: {} },
        { name: 'Mini', textures: { Skirt: 'assets/variants/miniskirt.png' } },
      ],
    },
    {
      key: 'sock_style', label: 'Sock style',
      drawables: ['StockingL', 'StockingR'],
      options: [
        { name: 'Default', textures: {} },
        { name: 'Knee-high', textures: { StockingL: 'assets/variants/kneehighSockL.png', StockingR: 'assets/variants/kneehighSockR.png' } },
        { name: 'Short', textures: { StockingL: 'assets/variants/shortSockL.png', StockingR: 'assets/variants/shortSockR.png' } },
        { name: 'Two-striped', textures: { StockingL: { url: 'assets/variants/twostripedStockingL.png', overlay: true }, StockingR: { url: 'assets/variants/twostripedStockingR.png', overlay: true } } },
        { name: 'Long', textures: { StockingL: 'assets/variants/longSockL.png', StockingR: 'assets/variants/longSockR.png' } },
        { name: 'Lingerie', textures: { StockingL: 'assets/variants/lingerieSockL.png', StockingR: 'assets/variants/lingerieSockR.png' } },
        { name: 'Striped stockings', textures: { StockingL: { url: 'assets/variants/stripedStockingL.png', overlay: true }, StockingR: { url: 'assets/variants/stripedStockingR.png', overlay: true } } },
        { name: 'Stirrups', textures: { StockingL: 'assets/variants/stirrupL.png', StockingR: 'assets/variants/stirrupR.png' } },
      ],
    },
    {
      key: 'shoe_style', label: 'Shoes',
      drawables: ['Shoe_L', 'Shoe_R'],
      options: [
        { name: 'Default', textures: {} },
        { name: 'Sneakers', textures: { Shoe_L: 'assets/variants/sneakerL.png', Shoe_R: 'assets/variants/sneakerR.png' } },
        { name: 'Classy', textures: { Shoe_L: 'assets/variants/classyShoeL.png', Shoe_R: 'assets/variants/classyShoeR.png' } },
      ],
    },
    {
      key: 'shirt_logo', label: 'Shirt logo',
      drawables: ['ModdableShirtLogo'],
      options: [
        { name: 'None', textures: {} },
        { name: 'Gamer', textures: { ModdableShirtLogo: { url: 'assets/variants/logoGamerTshirt.png', overlay: true } }, show: ['ModdableShirtLogo'] },
        { name: 'Priest Bot', textures: { ModdableShirtLogo: { url: 'assets/variants/logoPriestbot.png', overlay: true } }, show: ['ModdableShirtLogo'] },
      ],
    },
    {
      key: 'hoodie_logo', label: 'Hoodie logo',
      drawables: ['ModdableHoodieLogo'],
      options: [
        { name: 'None', textures: {} },
        { name: 'Shady Corner', textures: { ModdableHoodieLogo: { url: 'assets/variants/logoShcHoodie.png', overlay: true } }, show: ['ModdableHoodieLogo'] },
      ],
    },
    {
      key: 'panties_logo', label: 'Panties logo',
      drawables: ['ModdablePantiesLogo'],
      options: [
        { name: 'None', textures: {} },
        { name: 'Shady Corner', textures: { ModdablePantiesLogo: { url: 'assets/variants/logoShcPanties.png', overlay: true } }, show: ['ModdablePantiesLogo'] },
      ],
    },
  ];
  const variantState = {};
  for (const v of VARIANTS) variantState[v.key] = 0;   // index into options

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
    try {
      const raw = localStorage.getItem(VARIANT_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        for (const v of VARIANTS) {
          const i = saved[v.key];
          if (Number.isInteger(i) && i >= 0 && i < v.options.length) variantState[v.key] = i;
        }
      }
    } catch (e) { /* ignore */ }
  }

  function saveVariants() {
    try { localStorage.setItem(VARIANT_KEY, JSON.stringify(variantState)); } catch (e) {}
    if (window.Prefs) Prefs.pushToServer();
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
    if (window.Prefs) Prefs.pushToServer();
  }
  function saveColors() {
    try { localStorage.setItem(COLOR_KEY, JSON.stringify(colors)); } catch (e) {}
    if (window.Prefs) Prefs.pushToServer();
  }

  // Overlay meshes the game hides via part opacity in its own code (no Live2D
  // parameter drives them, so the rig leaves them permanently visible). They
  // render as untinted grey blobs over the face/body unless force-hidden here.
  // Matched by substring against the model's drawable IDs, so this is a no-op
  // on extractions that don't contain them.
  const ALWAYS_HIDDEN = [
    'cumoutside', 'shadowboob', 'fondle',
    'nippiercing', 'navelpiercing', 'headband',
  ];

  function applyAll() {
    if (Live2D.opacityByPattern) Live2D.opacityByPattern(ALWAYS_HIDDEN, [], 0);
    for (const it of ITEMS) {
      if (it.param) Live2D.setTarget(it.param, state[it.key] ? 1 : 0);
      // For items whose param doesn't drive drawable opacity, override directly.
      // visOn/visOff are the forced opacity for the on/off state (null = clear
      // the override and let the rig decide). Defaults reproduce the shoe/stocking
      // behaviour: on -> clear (rig shows), off -> force opacity 0 (hide).
      if (it.visibilityPatterns && Live2D.opacityByPattern) {
        const visOn  = it.visOn  !== undefined ? it.visOn  : null;
        const visOff = it.visOff !== undefined ? it.visOff : 0;
        Live2D.opacityByPattern(it.visibilityPatterns, it.visibilityExcludes,
          state[it.key] ? visOn : visOff);
      }
    }
    applyVariants();
    applyColors();
  }

  // Swap each slot's drawables to the selected variant texture (or clear to the
  // baked default). Runs the compositor once per slot.
  function applyVariants() {
    if (!Live2D.setDrawableTextures) return;
    // Collect draw-order pairs from every active option in one go.
    if (Live2D.setDrawableOrderBelow) {
      Live2D.setDrawableOrderBelow(
        VARIANTS.flatMap(v => v.options[variantState[v.key] || 0].order || []));
    }
    for (const v of VARIANTS) {
      const opt = v.options[variantState[v.key] || 0];
      const map = {};
      for (const d of v.drawables) map[d] = (opt.textures && opt.textures[d]) || null;
      Live2D.setDrawableTextures(map);
      // Some variants take control of rig-hidden decals or base meshes.
      if (Live2D.setDrawableOpacity) {
        const show = new Set(opt.show || []);
        const hide = new Set(opt.hide || []);
        const controlled = new Set();
        for (const o of v.options) {
          for (const d of o.show || []) controlled.add(d);
          for (const d of o.hide || []) controlled.add(d);
        }
        for (const d of controlled) {
          Live2D.setDrawableOpacity(d, show.has(d) ? 1 : hide.has(d) ? 0 : null);
        }
      }
    }
  }

  function setVariant(key, index) {
    const v = VARIANTS.find(x => x.key === key);
    if (!v || !v.options[index]) return;
    variantState[key] = index;
    saveVariants();
    applyVariants();
    applyColors();
    syncUI();
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
    for (const id of touched) {
      Live2D.setDrawableTint(id, null);
      if (Live2D.setDrawableScreen) Live2D.setDrawableScreen(id, null);
    }
    for (const g of COLOR_GROUPS) {
      const rgb = hexToRgb01(colors[g.key]);
      if (!rgb) continue;
      if (g.tintMode === 'screen' && Live2D.screenByPattern) {
        Live2D.screenByPattern(g.includes, g.excludes, rgb);
      } else {
        Live2D.tintByPattern(g.includes, g.excludes, rgb);
      }
    }
    // Mechanical limbs follow the skin color: the Skin group's 'attach'
    // pattern already painted them above, so nothing to strip or re-paint.
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
    syncWardrobe(); // wardrobe.html has no settings panel, only the wardrobe
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
    for (const v of VARIANTS) {
      const sel = containerEl.querySelector(`select[data-variant-key="${v.key}"]`);
      if (sel) sel.value = String(variantState[v.key] || 0);
    }
  }

  function reset() {
    for (const it of ITEMS) state[it.key] = it.defaultOn;
    for (const g of COLOR_GROUPS) colors[g.key] = g.defaultColor || null;
    for (const v of VARIANTS) variantState[v.key] = 0;
    save();
    saveColors();
    saveVariants();
    applyAll();
    syncUI();
  }

  function buildUI(rootEl, resetBtn) {
    containerEl = rootEl;
    rootEl.innerHTML = '';
    rootEl.classList.remove('outfit-grid');

    const buildGrid = (items) => {
      const grid = document.createElement('div');
      grid.className = 'outfit-grid';
      for (const it of items) {
        const row = document.createElement('label');
        row.className = 'outfit-row';
        row.innerHTML = `<input type="checkbox" data-key="${it.key}"><span>${it.label}</span>`;
        const cb = row.querySelector('input');
        cb.checked = state[it.key];
        cb.addEventListener('change', () => setItem(it.key, cb.checked));
        grid.appendChild(row);
      }
      return grid;
    };

    rootEl.appendChild(buildGrid(ITEMS.filter(it => !it.section)));

    for (const [section, name] of [['body', 'Body'], ['hair', 'Hair']]) {
      const title = document.createElement('div');
      title.className = 'outfit-colors-title';
      title.textContent = name;
      rootEl.appendChild(title);
      rootEl.appendChild(buildGrid(ITEMS.filter(it => it.section === section)));
    }

    // Variant (alternative clothing) pickers.
    if (VARIANTS.length) {
      const varWrap = document.createElement('div');
      varWrap.className = 'outfit-variants';
      for (const v of VARIANTS) {
        const row = document.createElement('div');
        row.className = 'outfit-variant-row';
        const opts = v.options.map((o, i) => `<option value="${i}">${o.name}</option>`).join('');
        row.innerHTML = `<span class="outfit-variant-label">${v.label}</span>
          <select data-variant-key="${v.key}">${opts}</select>`;
        const sel = row.querySelector('select');
        sel.value = String(variantState[v.key] || 0);
        sel.addEventListener('change', () => setVariant(v.key, parseInt(sel.value, 10)));
        varWrap.appendChild(row);
      }
      rootEl.appendChild(varWrap);
    }

    const colorWrap = document.createElement('div');
    colorWrap.className = 'outfit-colors';
    const title = document.createElement('div');
    title.className = 'outfit-colors-title';
    title.textContent = 'Colors';
    colorWrap.appendChild(title);

    for (const g of COLOR_GROUPS) {
      const matchedIds = Live2D.findDrawables ? Live2D.findDrawables(g.includes, g.excludes) : [];
      const matchCount = matchedIds.length;
      const row = document.createElement('div');
      row.className = 'outfit-color-row';
      row.title = matchedIds.length ? matchedIds.join('\n') : '(nessun drawable corrispondente)';
      row.innerHTML = `
        <span class="outfit-color-label">${g.label}</span>
        <span class="outfit-color-count ${matchCount === 0 ? 'zero' : ''}">${matchCount}</span>
        <input type="color" data-color-key="${g.key}" value="${colors[g.key] || '#ffffff'}">
        <button class="ghost outfit-color-clear ${colors[g.key] ? 'active' : ''}" data-color-clear="${g.key}" title="Rimuovi tinta">×</button>
      `;
      const cp = row.querySelector('input[type="color"]');
      const clr = row.querySelector('button[data-color-clear]');
      cp.addEventListener('input', () => { setColor(g.key, cp.value); clr.classList.add('active'); });
      cp.addEventListener('change', () => { setColor(g.key, cp.value); clr.classList.add('active'); });
      clr.addEventListener('click', () => { setColor(g.key, null); cp.value = '#ffffff'; clr.classList.remove('active'); });
      colorWrap.appendChild(row);
    }
    rootEl.appendChild(colorWrap);

    if (resetBtn) resetBtn.addEventListener('click', reset);
  }

  // ---- Wardrobe overlay -----------------------------------------------------
  // Visual dress-up view over the same ITEMS/VARIANTS state: drag a tile onto
  // Jun to equip it, drag a worn piece to remove it. The live canvas model is
  // the preview - every change goes through setItem/setVariant.
  let wdOverlay = null, wdTooltip = null, wdGhost = null;

  const itemPatterns = (it) => it.colorPatterns || it.visibilityPatterns || [];

  // drawableId -> item key, for every currently-worn toggleable item.
  function wornDrawableMap() {
    const map = new Map();
    for (const it of ITEMS) {
      if (!state[it.key]) continue;
      for (const id of Live2D.findDrawables(itemPatterns(it), it.colorExcludes)) map.set(id, it.key);
    }
    return map;
  }

  function itemThumb(it) {
    const ids = Live2D.findDrawables(itemPatterns(it), it.colorExcludes);
    // Pick the drawable with the largest atlas area so e.g. a dress thumbnail
    // shows the dress body, not a strap.
    let best = null, bestPx = 0;
    for (const id of ids) {
      const img = Live2D.drawableThumb(id, 72);
      if (!img) continue;
      const px = img.length; // data URL length ~ crop detail; good enough proxy
      if (px > bestPx) { bestPx = px; best = img; }
    }
    return best;
  }

  function variantThumb(v, opt) {
    for (const val of Object.values(opt.textures || {})) {
      const url = typeof val === 'object' ? val.url : val;
      if (url) return url;
    }
    return Live2D.drawableThumb(v.drawables[0], 72); // baked default option
  }

  function wdMoveGhost(x, y) {
    wdGhost.style.left = (x + 10) + 'px';
    wdGhost.style.top = (y + 10) + 'px';
  }

  function wdShowGhost(src, x, y) {
    wdGhost.src = src || '';
    wdGhost.style.display = src ? 'block' : 'none';
    if (src) wdMoveGhost(x, y);
  }

  function makeTile(label, thumbSrc, onEquip) {
    const tile = document.createElement('div');
    tile.className = 'wd-tile';
    tile.innerHTML = `${thumbSrc ? `<img draggable="false" src="${thumbSrc}">` : '<div class="wd-noimg">?</div>'}<span>${label}</span>`;
    // Custom pointer drag (not HTML5 DnD): works on touch and gives us the ghost.
    tile.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      tile.setPointerCapture(e.pointerId);
      const sx = e.clientX, sy = e.clientY;
      let dragging = false;
      const move = (ev) => {
        if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6) {
          dragging = true;
          wdShowGhost(thumbSrc, ev.clientX, ev.clientY);
        }
        if (dragging) wdMoveGhost(ev.clientX, ev.clientY);
      };
      const up = (ev) => {
        tile.removeEventListener('pointermove', move);
        tile.removeEventListener('pointerup', up);
        wdShowGhost(null);
        // Drop on Jun equips; a plain click (no real drag) toggles too.
        if (!dragging || Live2D.isOverModel(ev.clientX, ev.clientY)) onEquip(!dragging);
      };
      tile.addEventListener('pointermove', move);
      tile.addEventListener('pointerup', up);
    });
    return tile;
  }

  function buildWardrobe() {
    wdOverlay = document.createElement('div');
    wdOverlay.className = 'wardrobe-overlay';
    wdOverlay.innerHTML = `<div class="wd-head"><span>Wardrobe</span>
      <span class="wd-hint">Hover a worn piece to highlight it - drag it to remove it</span>
      <button class="ghost wd-close" title="Close">×</button></div>
      <div class="wd-body"></div>`;
    const body = wdOverlay.querySelector('.wd-body');

    const section = (name) => {
      const t = document.createElement('div');
      t.className = 'wd-section';
      t.textContent = name;
      body.appendChild(t);
      const grid = document.createElement('div');
      grid.className = 'wd-grid';
      body.appendChild(grid);
      return grid;
    };

    for (const [sec, name] of [[undefined, 'Clothing'], ['body', 'Body'], ['hair', 'Hair']]) {
      const grid = section(name);
      for (const it of ITEMS.filter(x => x.section === sec)) {
        const tile = makeTile(it.label, itemThumb(it), (isClick) => setItem(it.key, isClick ? !state[it.key] : true));
        tile.dataset.item = it.key;
        grid.appendChild(tile);
      }
    }
    for (const v of VARIANTS) {
      const grid = section(v.label);
      v.options.forEach((opt, i) => {
        const tile = makeTile(opt.name, variantThumb(v, opt), () => setVariant(v.key, i));
        tile.dataset.variant = v.key;
        tile.dataset.opt = String(i);
        grid.appendChild(tile);
      });
    }

    wdTooltip = document.createElement('div');
    wdTooltip.className = 'wd-tooltip';
    wdGhost = document.createElement('img');
    wdGhost.className = 'wd-ghost';
    document.body.append(wdOverlay, wdTooltip, wdGhost);

    wdOverlay.querySelector('.wd-close').addEventListener('click', closeWardrobe);

    // Model-side: hover highlights the exact drawable under the pointer; a
    // drag removes the matching item as soon as the pointer actually moves.
    let removeDrag = null; // { key, x, y, removed }
    let hoveredDrawable = null;
    const setHoveredDrawable = (id) => {
      if (hoveredDrawable === id) return;
      if (hoveredDrawable) Live2D.setDrawableHighlight(hoveredDrawable, null);
      hoveredDrawable = id;
      if (hoveredDrawable) Live2D.setDrawableHighlight(hoveredDrawable, [0.45, 0.22, 0.65]);
      document.body.classList.toggle('wd-over-worn-item', !!hoveredDrawable);
    };
    window.addEventListener('pointermove', (e) => {
      if (!document.body.classList.contains('wardrobe-open')) return;
      if (removeDrag) {
        wdMoveGhost(e.clientX, e.clientY);
        if (!removeDrag.removed && Math.hypot(e.clientX - removeDrag.x, e.clientY - removeDrag.y) > 6) {
          removeDrag.removed = true;
          setItem(removeDrag.key, false);
          setHoveredDrawable(null);
        }
        return;
      }
      let key = null, hit = null;
      if (!(e.target && e.target.closest && e.target.closest('.wardrobe-overlay'))) {
        const worn = wornDrawableMap();
        hit = Live2D.drawableAt(e.clientX, e.clientY, new Set(worn.keys()));
        key = hit ? worn.get(hit) : null;
      }
      setHoveredDrawable(hit);
      wdTooltip.style.display = key ? 'block' : 'none';
      if (key) {
        const it = ITEMS.find(x => x.key === key);
        wdTooltip.textContent = `${it.label} - drag away to remove`;
        wdTooltip.style.left = (e.clientX + 14) + 'px';
        wdTooltip.style.top = (e.clientY + 14) + 'px';
      }
    });
    window.addEventListener('pointerdown', (e) => {
      if (!document.body.classList.contains('wardrobe-open') || e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest('.wardrobe-overlay, button, a, input, textarea, select, .composer, .conv-sidebar, .app-header')) return;
      const worn = wornDrawableMap();
      const hit = Live2D.drawableAt(e.clientX, e.clientY, new Set(worn.keys()));
      if (!hit) return;
      const key = worn.get(hit);
      e.preventDefault();
      // Keep receiving pointer events even after the pointer leaves the stage.
      try { e.target.setPointerCapture(e.pointerId); } catch (err) { }
      removeDrag = { key, x: e.clientX, y: e.clientY, removed: false };
      wdTooltip.style.display = 'none';
      setHoveredDrawable(hit);
      const tile = wdOverlay.querySelector(`.wd-tile[data-item="${key}"] img`);
      wdShowGhost(tile ? tile.src : '', e.clientX, e.clientY);
    });
    window.addEventListener('pointerup', (e) => {
      if (!removeDrag) return;
      removeDrag = null;
      wdShowGhost(null);
      // A press without a real move is just a pick; moving it is the remove.
      // This avoids accidentally stripping a layer while inspecting it.
    });
    window.addEventListener('pointercancel', () => {
      removeDrag = null;
      wdShowGhost(null);
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('wardrobe-open')) closeWardrobe();
    });

    syncWardrobe();
  }

  function syncWardrobe() {
    if (!wdOverlay) return;
    for (const it of ITEMS) {
      const tile = wdOverlay.querySelector(`.wd-tile[data-item="${it.key}"]`);
      if (tile) tile.classList.toggle('on', !!state[it.key]);
    }
    for (const v of VARIANTS) {
      wdOverlay.querySelectorAll(`.wd-tile[data-variant="${v.key}"]`).forEach(tile => {
        tile.classList.toggle('on', Number(tile.dataset.opt) === (variantState[v.key] || 0));
      });
    }
  }

  function openWardrobe() {
    if (!wdOverlay) buildWardrobe();
    document.body.classList.add('wardrobe-open');
  }

  function closeWardrobe() {
    // On the dedicated wardrobe page, closing means going back to the app.
    if (location.pathname.endsWith('wardrobe.html')) { location.href = 'index.html'; return; }
    document.body.classList.remove('wardrobe-open');
    wdTooltip.style.display = 'none';
    wdShowGhost(null);
    document.body.classList.remove('wd-over-worn-item');
  }

  // Builds the wardrobe phrase injected into the system prompt.
  function describe() {
    const clothes = ITEMS.filter(it => !it.section);
    const worn = clothes.filter(it => state[it.key]);
    const bare = clothes.filter(it => !state[it.key]);
    const phrase = (arr) => arr.map(it => it.label.toLowerCase()).join(', ');
    let s;
    if (worn.length === 0) s = 'You are currently fully nude (wearing nothing).';
    else {
      s = `You are currently wearing: ${phrase(worn)}.`;
      if (bare.length) s += ` Not wearing: ${phrase(bare)}.`;
    }
    const body = ITEMS.filter(it => it.section === 'body' && state[it.key]);
    if (body.length) s += ` Your body features: ${phrase(body)}.`;
    // Only tell the LLM about the hair when it deviates from the default style.
    const hair = ITEMS.filter(it => it.section === 'hair');
    if (hair.some(it => state[it.key] !== it.defaultOn)) {
      const on = hair.filter(it => state[it.key]);
      s += on.length ? ` Your hair style: ${phrase(on)}.` : ' Your hair is completely hidden (bald).';
    }
    // Note non-default clothing styles (e.g. a mini skirt vs pleated).
    const styles = VARIANTS
      .filter(v => (variantState[v.key] || 0) > 0)
      .map(v => `${v.label.toLowerCase()}: ${v.options[variantState[v.key]].name.toLowerCase()}`);
    if (styles.length) s += ` Styles - ${styles.join('; ')}.`;
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
        case 'shoe_left': setKey('shoe_l', stateOn); break;
        case 'shoe_right': setKey('shoe_r', stateOn); break;
        case 'nude':
          // Only strip clothing - body parts and hair are not wardrobe.
          if (stateOn) for (const it of ITEMS) { if (!it.section) setKey(it.key, false); }
          break;
        // skirt_up / panties_aside are pose-y, not wardrobe state - ignore.
      }
    }

    if (dirty) { save(); syncUI(); }
  }

  return { load, buildUI, applyAll, describe, snapshot, reset, syncFromAction, setVariant, openWardrobe };
})();
