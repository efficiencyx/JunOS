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
      visibilityPatterns: ['h1_'], visOn: 1, visOff: 0,
      textures: { H1_Front_Bang: { url: 'assets/variants/hair/clothier/H1_Front_Bang.png', overlay: true } } },
    { key: 'hair_h2', label: 'Front bang', section: 'hair', defaultOn: false,
      visibilityPatterns: ['h2_'], visOn: 1, visOff: 0,
      textures: { H2_Front_Bang: { url: 'assets/variants/hair/eye_covering_bang/H2_Front_Bang.png', overlay: true } } },
    { key: 'hair_h3', label: 'Hime Cut Hair', section: 'hair', defaultOn: false,
      visibilityPatterns: ['h3_'], visOn: 1, visOff: 0,
      textures: { H3_Front: { url: 'assets/variants/hair/hime/H3_Front.png', overlay: true } } },
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

    // The native hair items add a separately colorable layer (ColorIndex 1)
    // to these exact front drawables. Keep them after the broad main-hair
    // group so a strand choice overrides the main tint only on its own mesh.
    { key: 'hair_h1_strand', label: 'Strand', includes: ['h1_front_bang'], excludes: [] },
    { key: 'hair_h2_strand', label: 'Strand', includes: ['h2_front_bang'], excludes: [] },
    { key: 'hair_h3_strand', label: 'Strand', includes: ['h3_front'], excludes: [] },

    { key: 'hair_hologram', label: 'Hair hologram', includes: ['hairhologram'], excludes: [] },

    // The game exposes CatEarMain and CatEarSecondary color slots. In this
    // model the secondary slot is the inner/fluff layer, kept disjoint from
    // the front/back main layers so clearing either slot restores its default.
    { key: 'ear', label: 'Ear', includes: ['catearback','catearfront','pointyear'], excludes: [] },
    { key: 'ear_mid', label: 'Fluff', includes: ['catearmid'], excludes: [] },

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

  // A wardrobe item can own several game color slots. Keep those slots on the
  // same tile and open them in one picker instead of scattering independent
  // controls around the color studio.
  const ITEM_COLOR_GROUPS = {
    ...Object.fromEntries(ITEMS.filter(it => it.colorPatterns).map(it => [it.key, [it.key]])),
    cat_ears: ['ear', 'ear_mid'],
    pointy_ears: ['ear'],
    tail: ['tail'],
    hair_hologram: ['hair_hologram'],
    hair_h0: ['hair'],
    hair_h1: ['hair', 'hair_h1_strand'],
    hair_h2: ['hair', 'hair_h2_strand'],
    hair_h3: ['hair', 'hair_h3_strand'],
    hair_h4: ['hair'],
  };

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

  // Just the param/opacity flips for the boolean items. Cheap: no texture
  // recompositing, no tint repaint. This is all an equip/unequip needs.
  function applyItems() {
    const textureMap = {};
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
      // Native items may add packed art on top of a baked drawable. Hair
      // strands are layer-1 overlays in the game and disappear with the item.
      for (const [drawable, texture] of Object.entries(it.textures || {})) {
        textureMap[drawable] = state[it.key] ? texture : null;
      }
    }
    if (Live2D.setDrawableTextures && Object.keys(textureMap).length) Live2D.setDrawableTextures(textureMap);
  }

  function applyAll() {
    if (Live2D.opacityByPattern) Live2D.opacityByPattern(ALWAYS_HIDDEN, [], 0);
    applyItems();
    applyVariants();
    applyColors();
    // Modded items go last so they win over variant overrides on shared drawables.
    if (window.Mods) Mods.applyAll();
  }

  // Swap each slot's drawables to the selected variant texture (or clear to the
  // baked default). Runs the compositor once per slot. Pass `onlyKey` to touch
  // a single slot (recompositing an atlas is expensive - don't redo the other
  // slots when only one changed).
  function applyVariants(onlyKey) {
    if (!Live2D.setDrawableTextures) return;
    // Collect draw-order pairs from every active option in one go.
    if (Live2D.setDrawableOrderBelow) {
      Live2D.setDrawableOrderBelow(
        VARIANTS.flatMap(v => v.options[variantState[v.key] || 0].order || []));
    }
    for (const v of VARIANTS) {
      if (onlyKey && v.key !== onlyKey) continue;
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
    applyVariants(key);
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
    // Only the boolean params/opacities change on an equip toggle; skip the
    // variant compositor + tint repaint (they redraw and re-upload whole
    // atlases, which caused a visible stutter on every un/equip).
    applyItems();
    syncUI();
  }

  function setColor(key, hex) {
    if (!(key in colors)) return;
    colors[key] = hex || null;
    saveColors();
    applyColors();
    refreshColorButtons();
  }

  function normalizeHex(value) {
    const raw = String(value || '').trim();
    const short = /^#?([0-9a-f]{3})$/i.exec(raw);
    if (short) return '#' + [...short[1]].map(c => c + c).join('').toLowerCase();
    const full = /^#?([0-9a-f]{6})$/i.exec(raw);
    return full ? '#' + full[1].toLowerCase() : null;
  }

  function hexToHsv(hex) {
    const [r, g, b] = hexToRgb01(hex) || [1, 1, 1];
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d && max === r) h = 60 * (((g - b) / d) % 6);
    else if (d && max === g) h = 60 * ((b - r) / d + 2);
    else if (d) h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
    return { h, s: max ? d / max : 0, v: max };
  }

  function hsvToHex({ h, s, v }) {
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    let rgb;
    if (h < 60) rgb = [c, x, 0];
    else if (h < 120) rgb = [x, c, 0];
    else if (h < 180) rgb = [0, c, x];
    else if (h < 240) rgb = [0, x, c];
    else if (h < 300) rgb = [x, 0, c];
    else rgb = [c, 0, x];
    return '#' + rgb.map(n => Math.round((n + m) * 255).toString(16).padStart(2, '0')).join('');
  }

  const colorGroup = (key) => COLOR_GROUPS.find(g => g.key === key);

  function paintColorButton(button) {
    const keys = (button.dataset.colorKeys || '').split(',').filter(Boolean);
    const values = keys.map(key => colors[key] || null);
    button.classList.toggle('set', values.some(Boolean));
    button.querySelectorAll('.color-preview-segment').forEach((segment, i) => {
      segment.classList.toggle('unset', !values[i]);
      segment.style.background = values[i] || '';
    });
  }

  function refreshColorButtons() {
    document.querySelectorAll('[data-color-keys]').forEach(paintColorButton);
    if (!containerEl) return;
    containerEl.querySelectorAll('button[data-color-clear]').forEach(button => {
      const keys = button.dataset.colorClear.split(',').filter(Boolean);
      button.classList.toggle('active', keys.some(key => !!colors[key]));
    });
  }

  let colorPickerEl = null, colorPickerAnchor = null, pickerState = null;
  const COLOR_PRESETS = ['#f6d6c8', '#ef8fa9', '#c76ee8', '#7754d8', '#4b7bd8', '#41a9a2', '#76ae57', '#e2b34c', '#d76b42', '#34273f'];

  function closeColorPicker(focusAnchor) {
    if (!colorPickerEl || colorPickerEl.hidden) return;
    colorPickerEl.hidden = true;
    if (focusAnchor && colorPickerAnchor) colorPickerAnchor.focus();
    colorPickerAnchor = null;
    pickerState = null;
  }

  function positionColorPicker() {
    const anchor = colorPickerAnchor.getBoundingClientRect();
    const width = colorPickerEl.offsetWidth, height = colorPickerEl.offsetHeight;
    let left = anchor.right - width, top = anchor.bottom + 8;
    if (top + height > innerHeight - 8) top = anchor.top - height - 8;
    colorPickerEl.style.left = `${Math.max(8, Math.min(left, innerWidth - width - 8))}px`;
    colorPickerEl.style.top = `${Math.max(8, Math.min(top, innerHeight - height - 8))}px`;
  }

  function pickerColor(index = pickerState.index) {
    return pickerState.values ? pickerState.values[index] : colors[pickerState.keys[index]];
  }

  function commitPickerColor(hex) {
    if (pickerState.values) {
      pickerState.values[pickerState.index] = hex || null;
      pickerState.onChange(pickerState.index, hex || null);
    } else {
      setColor(pickerState.keys[pickerState.index], hex);
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
      <div class="ocp-presets" aria-label="Color presets"></div><button type="button" class="ocp-clear">Use default</button>`;
    document.body.appendChild(colorPickerEl);
    colorPickerEl.querySelector('.ocp-close').addEventListener('click', () => closeColorPicker(true));
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
    window.addEventListener('resize', () => closeColorPicker(false));
    window.addEventListener('scroll', () => closeColorPicker(false), true);
  }

  function showColorPicker(anchor, label, state) {
    buildColorPicker();
    colorPickerAnchor = anchor;
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
    colorPickerEl.hidden = false;
    selectPickerChannel(0);
    positionColorPicker();
  }

  function openColorPicker(anchor, keys, label) {
    const validKeys = keys.filter(key => key in colors);
    showColorPicker(anchor, label, {
      keys: validKeys,
      labels: validKeys.map(key => (colorGroup(key) || {}).label || key),
    });
  }

  function makeItemColorButton(label, slotLabels, initialValues, onChange, className = 'wd-swatch') {
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
      showColorPicker(button, label, { values, labels: slotLabels, onChange: setExternal });
    });
    button.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      slotLabels.forEach((_, index) => setExternal(index, null));
    });
    return button;
  }

  function makeColorButton(groupKeys, label, className) {
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
      groupKeys.forEach(key => setColor(key, null));
    });
    return button;
  }

  let containerEl = null;
  function syncUI() {
    syncWardrobe(); // wardrobe.html has no settings panel, only the wardrobe
    if (!containerEl) return;
    for (const it of ITEMS) {
      const cb = containerEl.querySelector(`input[type="checkbox"][data-key="${it.key}"]`);
      if (cb) cb.checked = state[it.key];
    }
    refreshColorButtons();
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

    // The settings panel uses the same custom picker as the visual wardrobe.
    // Cat-ear main/fluff slots are represented by one bundled row.
    for (const g of COLOR_GROUPS) {
      if (g.key === 'ear_mid') continue;
      const keys = g.key === 'ear' ? ITEM_COLOR_GROUPS.cat_ears : [g.key];
      const groups = keys.map(colorGroup).filter(Boolean);
      const matchedIds = new Set(groups.flatMap(group =>
        Live2D.findDrawables ? Live2D.findDrawables(group.includes, group.excludes) : []));
      const label = g.key === 'ear' ? 'Cat ears' : g.label;
      const row = document.createElement('div');
      row.className = 'outfit-color-row';
      row.title = matchedIds.size ? [...matchedIds].join('\n') : '(no matching drawable)';
      const labelEl = document.createElement('span');
      labelEl.className = 'outfit-color-label';
      labelEl.textContent = label;
      const count = document.createElement('span');
      count.className = `outfit-color-count ${matchedIds.size === 0 ? 'zero' : ''}`;
      count.textContent = String(matchedIds.size);
      const trigger = makeColorButton(keys, label, 'outfit-color-trigger');
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'ghost outfit-color-clear';
      clear.dataset.colorClear = keys.join(',');
      clear.title = 'Remove tint';
      clear.textContent = '×';
      clear.addEventListener('click', () => keys.forEach(key => setColor(key, null)));
      row.append(labelEl, count, trigger, clear);
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

  // Small tint control pinned to a tile's top-right corner. Multi-slot items
  // display a split preview and open every slot in the same custom picker.
  function makeSwatch(groupKeys, label) {
    return makeColorButton(groupKeys, label, 'wd-swatch');
  }

  function makeTile(label, thumbSrc, onEquip, colorKeys) {
    const tile = document.createElement('div');
    tile.className = 'wd-tile';
    tile.tabIndex = 0;
    tile.setAttribute('role', 'button');
    tile.setAttribute('aria-label', `Toggle ${label}`);
    tile.innerHTML = `${thumbSrc ? `<img draggable="false" src="${thumbSrc}">` : '<div class="wd-noimg">?</div>'}<span>${label}</span>`;
    if (colorKeys && colorKeys.length) tile.appendChild(makeSwatch(colorKeys, label));
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
    tile.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      onEquip(true);
    });
    return tile;
  }

  function buildWardrobe() {
    wdOverlay = document.createElement('div');
    wdOverlay.className = 'wardrobe-overlay';
    wdOverlay.innerHTML = `<div class="wd-head">
        <div class="wd-titles"><span class="wd-title">Wardrobe</span>
        <span class="wd-hint">Click to toggle · drag onto Jun to wear</span></div>
        <div class="wd-actions"><button class="ghost wd-reset" type="button" title="Restore the default outfit">Reset</button>
        <button class="ghost wd-close" type="button" aria-label="Close wardrobe" title="Close">×</button></div></div>
      <div class="wd-main"><nav class="wd-rail" aria-label="Wardrobe sections"></nav><div class="wd-body"></div></div>`;
    const body = wdOverlay.querySelector('.wd-body');
    const rail = wdOverlay.querySelector('.wd-rail');

    // Side rail: one anchor per top-level section, active state follows scroll.
    const navTargets = [];
    const addNav = (name, icon, el) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wd-nav';
      b.title = name;
      b.innerHTML = `<i>${icon}</i><span>${name}</span>`;
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
      t.textContent = name;
      body.appendChild(t);
      const grid = document.createElement('div');
      grid.className = 'wd-grid';
      body.appendChild(grid);
      return { title: t, grid };
    };

    for (const [sec, name, icon] of [[undefined, 'Clothing', '👗'], ['body', 'Body', '🐾'], ['hair', 'Hair', '💇']]) {
      const { title, grid } = section(name);
      addNav(name, icon, title);
      for (const it of ITEMS.filter(x => x.section === sec)) {
        const colorKeys = ITEM_COLOR_GROUPS[it.key] || [];
        const tile = makeTile(it.label, itemThumb(it),
          (isClick) => setItem(it.key, isClick ? !state[it.key] : true), colorKeys);
        tile.dataset.item = it.key;
        grid.appendChild(tile);
      }
    }

    // Tints with no wardrobe tile of their own (skin, blush, lips, eyes...)
    // ride on the High-Tech Skin tiles as one multi-channel picker instead of
    // a separate "Color studio" section. Item/ear/hair tints stay on their tiles.
    const tileGroups = new Set(Object.values(ITEM_COLOR_GROUPS).flat());
    const studioKeys = COLOR_GROUPS.filter(g =>
      !tileGroups.has(g.key) &&
      (!Live2D.findDrawables || Live2D.findDrawables(g.includes, g.excludes).length))
      .map(g => g.key);

    // All variant slots grouped under one "Styles" anchor.
    let firstVariant = true;
    for (const v of VARIANTS) {
      const { title, grid } = section(v.label, !firstVariant);
      if (firstVariant) { addNav('Styles', '✨', title); firstVariant = false; }
      v.options.forEach((opt, i) => {
        const tile = makeTile(opt.name, variantThumb(v, opt), () => setVariant(v.key, i),
          v.key === 'hightech_skin' ? studioKeys : []);
        tile.dataset.variant = v.key;
        tile.dataset.opt = String(i);
        grid.appendChild(tile);
      });
    }

    // Game-mod items (loaded from .zip, stored client-side in IndexedDB).
    if (window.Mods) {
      const anchor = document.createElement('div');
      body.appendChild(anchor);
      Mods.buildWardrobeSection(body);
      const modTitle = anchor.nextElementSibling;
      anchor.remove();
      if (modTitle) addNav('Mods', '🧩', modTitle);
    }
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

    // Model-side: hover highlights every drawable of the item under the
    // pointer (the whole garment, not just the hit mesh); a drag removes the
    // matching item as soon as the pointer actually moves.
    let removeDrag = null; // { key, x, y, removed }
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
      if (!document.body.classList.contains('wardrobe-open')) return;
      if (removeDrag) {
        wdMoveGhost(e.clientX, e.clientY);
        if (!removeDrag.removed && Math.hypot(e.clientX - removeDrag.x, e.clientY - removeDrag.y) > 6) {
          removeDrag.removed = true;
          setItem(removeDrag.key, false);
          setHoveredItem(null);
        }
        return;
      }
      let key = null, worn = null;
      if (!(e.target && e.target.closest && e.target.closest('.wardrobe-overlay'))) {
        worn = wornDrawableMap();
        const hit = Live2D.drawableAt(e.clientX, e.clientY, new Set(worn.keys()));
        key = hit ? worn.get(hit) : null;
      }
      setHoveredItem(key, worn);
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
      setHoveredItem(key, worn);
      const tile = wdOverlay.querySelector(`.wd-tile[data-item="${key}"] img`);
      wdShowGhost(tile ? tile.src : '', e.clientX, e.clientY);
    });
    window.addEventListener('pointerup', (e) => {
      if (!removeDrag) return;
      // Dropping the piece back on Jun cancels the removal (change of mind);
      // releasing away from her confirms it. A press without a real move is
      // just a pick - it never removed anything in the first place.
      if (removeDrag.removed && Live2D.isOverModel(e.clientX, e.clientY)) {
        setItem(removeDrag.key, true);
      }
      removeDrag = null;
      wdShowGhost(null);
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
      if (tile) {
        tile.classList.toggle('on', !!state[it.key]);
        tile.setAttribute('aria-pressed', String(!!state[it.key]));
      }
    }
    for (const v of VARIANTS) {
      wdOverlay.querySelectorAll(`.wd-tile[data-variant="${v.key}"]`).forEach(tile => {
        const selected = Number(tile.dataset.opt) === (variantState[v.key] || 0);
        tile.classList.toggle('on', selected);
        tile.setAttribute('aria-pressed', String(selected));
      });
    }
    // Repaint tint swatches (covers reset() and syncFromAction paths).
    refreshColorButtons();
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
    if (window.Mods) s += Mods.describe();
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

  return { load, buildUI, applyAll, describe, snapshot, reset, syncFromAction, setVariant, openWardrobe,
    makeItemColorButton, refreshColors: applyColors };
})();
