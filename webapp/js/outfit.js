window.Outfit = (function () {
  const STORAGE_KEY = 'omega.outfit.v1';
  const COLOR_KEY = 'omega.outfit.colors.v1';
  const VARIANT_KEY = 'omega.outfit.variants.v1';

  const ITEMS = [
    { key: 'shirt', label: 'Shirt', param: 'ParamShirtEnabled', defaultOn: true, excludes: ['dress','dress1'],
      colorPatterns: ['shirt'], colorExcludes: ['logo'] },
    { key: 'hoodie', label: 'Hoodie', param: 'ParamHoodieEnabled', defaultOn: false, excludes: ['dress','dress1'],
      colorPatterns: ['hoodie'], colorExcludes: ['logo'] },
    { key: 'dress', label: 'Dress', param: 'ParamDress2Enabled', defaultOn: false, excludes: ['shirt','hoodie','skirt','pants','dress1'],
      colorPatterns: ['dress'] },
    // Dress1 has no rig parameter, so we flip it on and off by hand
    { key: 'dress1', label: 'Dress (alt)', defaultOn: false,
      excludes: ['shirt','hoodie','skirt','pants','dress'],
      colorPatterns: ['dress1'], visibilityPatterns: ['dress1'], visOn: 1, visOff: null },
    { key: 'skirt', label: 'Skirt', param: 'ParamSkirtEnabled', defaultOn: true, excludes: ['pants','dress','dress1'],
      colorPatterns: ['skirt'] },
    { key: 'pants', label: 'Pants', param: 'ParamPantsEnabled', defaultOn: false, excludes: ['skirt','dress','dress1'],
      colorPatterns: ['pants'] },
    { key: 'bra', label: 'Bra', param: 'ParamBraEnabled', defaultOn: true, excludes: ['bikini_top'],
      // 'nobras' is PlainShirt_FrontNoBras, the shirt's no-bra chest mesh. it
      // matches 'bra' and the bra group runs after the shirt group, so without
      // this the shirt front gets painted in the BRA's color. only shows up
      // once something else hides the bra (bikini top), which is why it sat
      // there unnoticed until v0.97.5 swimwear.
      colorPatterns: ['bra'], colorExcludes: ['skin','braid','nobras'] },
    { key: 'panties', label: 'Panties', param: 'ParamPantiesEnabled', defaultOn: true, excludes: ['bikini_bot'],
      colorPatterns: ['panties'], colorExcludes: ['logo'] },
    // v0.97.5 swimwear. no rig parameters either, so visibility only
    { key: 'bikini_top', label: 'Bikini top', defaultOn: false, excludes: ['bra'],
      colorPatterns: ['bikinitop'], visibilityPatterns: ['bikinitop'], visOn: 1, visOff: 0 },
    { key: 'bikini_bot', label: 'Bikini bottom', defaultOn: false, excludes: ['panties'],
      colorPatterns: ['bikinibot'], visibilityPatterns: ['bikinibot'], visOn: 1, visOff: 0 },
    // in this moc3 the shoe parameters don't touch opacity AT ALL
    { key: 'shoe_l', label: 'Left shoe', param: 'ParamShoeLOn', defaultOn: true,
      colorPatterns: ['shoe_l'], visibilityPatterns: ['shoe_l'], visOn: 1, visOff: 0 },
    { key: 'shoe_r', label: 'Right shoe', param: 'ParamShoeROn', defaultOn: true,
      colorPatterns: ['shoe_r'], visibilityPatterns: ['shoe_r'], visOn: 1, visOff: 0 },
    { key: 'stockings', label: 'Stockings', defaultOn: true,
      colorPatterns: ['stocking'], visibilityPatterns: ['stocking'], visOn: 1, visOff: 0 },
    { key: 'headband', label: 'Headband', defaultOn: false, excludes: ['wizard_hat'],
      colorPatterns: ['headband'], visibilityPatterns: ['headband'], visOn: 1, visOff: 0 },
    { key: 'wizard_hat', label: 'Witch hat', defaultOn: false, excludes: ['headband'],
      colorPatterns: ['wizardhat'], visibilityPatterns: ['wizardhat'], visOn: 1, visOff: 0 },
    { key: 'bow', label: 'Bow', defaultOn: false,
      colorPatterns: ['cutebow'], visibilityPatterns: ['cutebow'], visOn: 1, visOff: 0 },
    { key: 'choker', label: 'Bell choker', defaultOn: false,
      colorPatterns: ['bellchoker'], visibilityPatterns: ['bellchoker'], visOn: 1, visOff: 0 },

    { key: 'cat_ears', label: 'Cat ears', section: 'body', defaultOn: true,
      visibilityPatterns: ['catear'], excludes: ['pointy_ears'] },
    { key: 'pointy_ears', label: 'Pointy ears', section: 'body', defaultOn: false,
      visibilityPatterns: ['pointyear'], visOn: 1, visOff: 0,
      excludes: ['cat_ears'] },
    { key: 'tail', label: 'Tail', section: 'body', defaultOn: true,
      visibilityPatterns: ['tailmain'] },
    { key: 'hair_hologram', label: 'Hair hologram', section: 'body', defaultOn: true,
      visibilityPatterns: ['hairhologram'] },

    // the rig only gives us H3. every other hair style we show by hand.
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

  const COLOR_GROUPS = [
    { key: 'skin', label: 'Skin',
      includes: ['skin','attach','mchand','mcforearm','nipple','moddableface','moddableback'],
      excludes: [] },

    { key: 'blush', label: 'Blush', includes: ['blush'], excludes: [],
      tintMode: 'screen', defaultColor: '#ff3a3a' },

    { key: 'hair', label: 'Hair',
      includes: ['h0_','h1_','h2_','h3_','h4_','hair'],
      excludes: ['hairband','hairpin','hairtie','hairclip','hairbow','hairhologram'] },

    // this small group has to come after the main hair to beat its tint
    { key: 'hair_h0_strand', label: 'Strand', includes: ['h0_sidealt_strand'], excludes: [] },
    { key: 'hair_h1_strand', label: 'Strand', includes: ['h1_front_bang'], excludes: [] },
    { key: 'hair_h2_strand', label: 'Strand', includes: ['h2_front_bang'], excludes: [] },
    { key: 'hair_h3_strand', label: 'Strand', includes: ['h3_front'], excludes: [] },
    { key: 'hair_clip', label: 'Hair clip', includes: ['hairclip'], excludes: [] },

    { key: 'hair_hologram', label: 'Hair hologram', includes: ['hairhologram'], excludes: [] },

    { key: 'ear', label: 'Ear', includes: ['catearback','catearfront','pointyear'], excludes: [] },
    { key: 'ear_mid', label: 'Fluff', includes: ['catearmid'], excludes: [] },

    { key: 'tail', label: 'Tail', includes: ['tailmain'], excludes: [] },

    { key: 'eyebrows', label: 'Eyebrows', includes: ['brow'], excludes: [] },

    { key: 'eye_sclera', label: 'Eye white', includes: ['eyeball'], excludes: [] },
    { key: 'eye_iris', label: 'Eye iris', includes: ['iris'], excludes: [] },
    { key: 'eye_pupil', label: 'Eye pupil', includes: ['pupil'], excludes: [] },
    { key: 'eye_highlight', label: 'Eye shine', includes: ['highlight'], excludes: [] },

    { key: 'lips', label: 'Lips', includes: ['lip'], excludes: [] },

    { key: 'mouth_interior', label: 'Mouth interior',
      includes: ['innermouth','tounge','tongue','teeth','saliva'], excludes: [] },

    // applyGlassesTexture paints these into the ModdableFace texture itself,
    // they're not drawable tints, so there's nothing to include here
    { key: 'glasses_frame', label: 'Glasses frame', includes: [], excludes: [] },
    { key: 'glasses_lens', label: 'Glasses lens', includes: [], excludes: [] },

    { key: 'stockings_accent', label: 'Accent', includes: [], excludes: [] },

    ...ITEMS.filter(it => it.colorPatterns).map(it => ({
      key: it.key, label: it.label,
      includes: it.colorPatterns, excludes: it.colorExcludes || [],
    })),
  ];

  const state = {};
  for (const it of ITEMS) state[it.key] = it.defaultOn;

  const colors = {};
  for (const g of COLOR_GROUPS) colors[g.key] = g.defaultColor || null;

  const ITEM_COLOR_GROUPS = {
    ...Object.fromEntries(ITEMS.filter(it => it.colorPatterns).map(it => [it.key, [it.key]])),
    stockings: ['stockings', 'stockings_accent'],
    cat_ears: ['ear', 'ear_mid'],
    pointy_ears: ['ear'],
    tail: ['tail'],
    hair_hologram: ['hair_hologram'],
    hair_h0: ['hair', 'hair_h0_strand', 'hair_clip'],
    hair_h1: ['hair', 'hair_h1_strand'],
    hair_h2: ['hair', 'hair_h2_strand'],
    hair_h3: ['hair', 'hair_h3_strand'],
    hair_h4: ['hair'],
  };

  const ITEM_VARIANTS = {
    hair_h0: ['hair_h0_style'],
    shirt: ['shirt_logo', 'sleeve_logo'],
    hoodie: ['hoodie_logo'],
    panties: ['panties_logo'],
    skirt: ['skirt_style'],
    stockings: ['sock_style'],
    shoe_l: ['shoe_style'],
    shoe_r: ['shoe_style'],
  };
  const BODY_VARIANTS = ['arm_style', 'leg_style', 'hightech_skin'];
  const CLOTHING_VARIANTS = ['glasses_style'];

  const VARIANT_OWNER = {};
  for (const [itemKey, variantKeys] of Object.entries(ITEM_VARIANTS)) {
    for (const variantKey of variantKeys) {
      (VARIANT_OWNER[variantKey] = VARIANT_OWNER[variantKey] || []).push(itemKey);
    }
  }

  // the decal catalog straight out of the game, variants/logos/, see DECALS in
  // tools/recover_assets.py. garment tags copy the game's own item names,
  // BedabotsShirt and MilfHunterHoodie and USBPanties and friends, pulled from
  // its Il2Cpp metadata, so each picker only offers what the game actually
  // sells for that piece of clothing.
  const LOGO_CATALOG = [
    ['aguiLogo', 'A-GUI', 'sh'],
    ['avocado', 'Avocado', 'p'],
    ['baka', 'Baka', 's'],
    ['banana', 'Banana', 'p'],
    ['bedabots', 'Bedabots', 'sh'],
    ['bloodyMoon', 'Bloody Moon', 'h'],
    ['botLogo', 'Bot', 's'],
    ['cazino', 'Cazino', 'sh'],
    ['celestyn', 'Celestyn', 'h'],
    ['cherry', 'Cherry', 'p'],
    ['cia', 'CIA', 's'],
    ['cosplayHouse', 'Cosplay House', 'h'],
    ['ddLogo', 'Destination Delirium', 's'],
    ['diabete', 'Diabete', 'sh'],
    ['diabeteColaPow', 'Diabete Cola Pow', 'sh'],
    ['diabeteDrSugar', 'Diabete Dr Sugar', 'sh'],
    ['diabeteSweetPotato', 'Diabete Sweet Potato', 'sh'],
    ['diabeteTransparent', 'Diabete (clean)', 'sh'],
    ['dogeCoin', 'Dogecoin', 'sh'],
    ['fishFearMe', 'Fish Fear Me', 'sp'],
    ['flowerkidv', 'FlowerKidV', 'h'],
    ['fungus', 'Fungus', 's'],
    ['galaxy', 'Galaxy', 's'],
    ['gamerTshirt', 'Gamer', 's'],
    ['hikkeiru', 'Hikkeiru', 'p'],
    ['hotPinkGames', 'Hot Pink Games', 's'],
    ['inHeat', 'In Heat', 'shp'],
    ['lightSonic', 'Light Sonic', 'h'],
    ['luxe', 'Luxe', 'sh'],
    ['madJoram', 'Mad Joram', 'h'],
    ['milfHunter', 'MILF Hunter', 'h'],
    ['mirthal', 'Mirthal', 's'],
    ['monizmed', 'Monizmed', 'sh'],
    ['mushroom', 'Mushroom', 'p'],
    ['nitrori', 'Nitrori', 'h'],
    ['nuteku', 'Nuteku', 'h'],
    ['peach', 'Peach', 'p'],
    ['polandball', 'Polandball', 'sh'],
    ['priestbot', 'Priest Bot', 's'],
    ['projektMelody', 'Projekt Melody', 's'],
    ['projektMelody69', 'Projekt Melody 69', 'h'],
    ['radioactive', 'Radioactive', 'p'],
    ['rose', 'Rose', 'p'],
    ['rottingSteel', 'Rotting Steel', 'h'],
    ['shcHoodie', 'Shady Corner', 'h'],
    ['shcPanties', 'Shady Corner', 'p'],
    ['sheep', 'Sheep', 's'],
    ['siluman', 'Siluman', 's'],
    ['silumanAlice', 'Siluman Alice', 's'],
    ['sj68', 'SJ68', 'h'],
    ['skull', 'Skull', 'h'],
    ['stilou', 'Stilou', 'sh'],
    ['strawberry', 'Strawberry', 'p'],
    ['sylphy', 'Sylphy', 's'],
    ['temple', 'Temple', 's'],
    ['tonisAlbum', 'Toni S', 'h'],
    ['ufo', 'UFO', 's'],
    ['usb', 'USB', 'p'],
    ['weeb', 'Weeb', 'h'],
    ['withStupid', 'With Stupid', 's'],
    ['worldTamer', 'World Tamer', 'h'],
    ['wyldSpace', 'WyldSpace', 'sp'],
    ['xoulion', 'Xoulion', 'shp'],
    ['yaranaika', 'Yaranaika', 'sp'],
  ];
  function logoOptions(garment, drawables) {
    return [
      { name: 'None', textures: {} },
      ...LOGO_CATALOG.filter(([, , tags]) => tags.includes(garment)).map(([file, name]) => ({
        name,
        textures: Object.fromEntries(drawables.map(d =>
          [d, { url: `assets/variants/logos/${file}.png`, fullClear: true }])),
        show: drawables,
        thumb: `assets/variants/logos/${file}.png`,
      })),
    ];
  }

  // limb variants are crops from the game atlas, placed through drawable UVs
  const LIMB_DIR = 'assets/variants/limbs';
  // these atlas regions overlap, so they need alphaClip
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
  // the game's hightechHypercamoSkin_interact also lists barcode and lines
  // (her chest barcode and the cracks down her cheeks), with rects that are
  // 100% transparent in the game's own atlas. an empty crop is the item
  // saying GET RID OF IT - the hypercamo is a smooth white shell, she doesn't
  // keep a barcode on it. they're not textures, so they don't belong in this
  // list, they're in the option's hide list instead.
  const HT_SKIN_IDS = ['SkinArmL', 'SkinArmR', 'SkinPelvis', 'SkinThighL', 'SkinThighR'];
  // mech knees have to be TOLD to draw over the calf and thigh
  const LEG_ORDER = [
    ['AttachLegLLower', 'AttachLegLThigh'], ['AttachLegRLower', 'AttachLegRThigh'],
  ];

  const VARIANTS = [
    {
      key: 'hair_h0_style', label: 'Hair style',
      drawables: ['H0_Front_Bang', 'H0_FrontClippedUp_Bang', 'H0_FrontClippedUp_HairClip'],
      options: [
        { name: 'Default', drawable: 'H0_Front_Bang',
          show: ['H0_Front_Bang'], hide: ['H0_FrontClippedUp_Bang', 'H0_FrontClippedUp_HairClip'] },
        { name: 'Hair clip', drawable: 'H0_FrontClippedUp_Bang',
          show: ['H0_FrontClippedUp_Bang', 'H0_FrontClippedUp_HairClip'], hide: ['H0_Front_Bang'] },
      ],
    },
    {
      key: 'arm_style', label: 'Arms',
      drawables: ARM_EXP_IDS,
      options: [
        { name: 'Arms (standard)', textures: {} },
        { name: 'Experimental Arms', textures: limbTex('experimental', ARM_EXP_IDS) },
        { name: 'High-Tech Arms', textures: limbTex('experimental', ARM_EXP_IDS) },
      ],
    },
    {
      key: 'leg_style', label: 'Legs',
      drawables: LEG_EXP_IDS,
      options: [
        { name: 'Legs (standard)', textures: {} },
        { name: 'Experimental Legs', textures: limbTex('experimental', LEG_EXP_IDS), order: LEG_ORDER },
        { name: 'High-Tech Legs', textures: limbTex('experimental', LEG_EXP_IDS), order: LEG_ORDER },
      ],
    },
    {
      key: 'hightech_skin', label: 'High-Tech Skin',
      drawables: HT_SKIN_IDS,
      options: [
        { name: 'Standard skin', textures: {} },
        // both are visible in the rig by default and nothing else turns them
        // off. shipping the empty crop as a texture did NOTHING: limbTex sets
        // alphaClip, and alphaClip erases through the patch's own alpha, so
        // an empty patch erases an empty shape. hiding the drawable is the
        // honest way to say it anyway.
        { name: 'High-Tech Skin', textures: limbTex('hightech', HT_SKIN_IDS), hide: ['barcode', 'lines'] },
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
        { name: 'Two-striped', colorMode: 'overlay', textures: { StockingL: { url: 'assets/variants/twostripedStockingL.png', overlay: true }, StockingR: { url: 'assets/variants/twostripedStockingR.png', overlay: true } } },
        { name: 'Long', textures: { StockingL: 'assets/variants/longSockL.png', StockingR: 'assets/variants/longSockR.png' } },
        { name: 'Lingerie', colorMode: 'duotone', textures: { StockingL: 'assets/variants/lingerieSockL.png', StockingR: 'assets/variants/lingerieSockR.png' } },
        { name: 'Striped stockings', colorMode: 'overlay', textures: { StockingL: { url: 'assets/variants/stripedStockingL.png', overlay: true }, StockingR: { url: 'assets/variants/stripedStockingR.png', overlay: true } } },
        { name: 'Stirrups', colorMode: 'duotone', textures: { StockingL: 'assets/variants/stirrupL.png', StockingR: 'assets/variants/stirrupR.png' } },
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
      key: 'glasses_style', label: 'Glasses',
      drawables: ['ModdableFace'],
      options: [
        { name: 'None', textures: {} },
        { name: 'Classic', textures: {}, show: ['ModdableFace'], thumb: 'assets/variants/glasses.png' },
        { name: 'Hearts', textures: {}, show: ['ModdableFace'], thumb: 'assets/variants/heartGlasses.png' },
      ],
    },
    {
      key: 'shirt_logo', label: 'Shirt logo',
      drawables: ['ModdableShirtLogo'],
      options: logoOptions('s', ['ModdableShirtLogo']),
    },
    {
      key: 'sleeve_logo', label: 'Sleeve logos',
      drawables: ['ModdableShirtLeftSleeveLogo', 'ModdableShirtRightSleeveLogo'],
      options: logoOptions('s', ['ModdableShirtLeftSleeveLogo', 'ModdableShirtRightSleeveLogo']),
    },
    {
      key: 'hoodie_logo', label: 'Hoodie logo',
      drawables: ['ModdableHoodieLogo'],
      options: logoOptions('h', ['ModdableHoodieLogo']),
    },
    {
      key: 'panties_logo', label: 'Panties logo',
      drawables: ['ModdablePantiesLogo'],
      options: logoOptions('p', ['ModdablePantiesLogo']),
    },
  ];
  const variantState = {};
  for (const v of VARIANTS) variantState[v.key] = 0;

  let wardrobeQueue = Promise.resolve();
  let pendingWardrobe = null;
  let authorizedAssets = new Set();
  let availableAssets = new Set();
  let nextWardrobeWrite = 0;

  const assetPath = (value) => {
    const url = typeof value === 'object' ? value.url : value;
    return typeof url === 'string' && url.startsWith('assets/') ? url.slice(7) : null;
  };

  const textureAvailable = (value) => {
    const path = assetPath(value);
    return !path || availableAssets.has(path);
  };

  function activeAssets(items = state, variants = variantState) {
    const assets = new Set();
    for (const it of ITEMS) {
      if (!items[it.key]) continue;
      for (const value of Object.values(it.textures || {})) {
        const path = assetPath(value);
        if (path) assets.add(path);
      }
    }
    for (const v of VARIANTS) {
      const owners = VARIANT_OWNER[v.key];
      if (owners && !owners.some(key => items[key])) continue;
      const opt = v.options[variants[v.key] || 0];
      for (const value of Object.values(opt.textures || {})) {
        const path = assetPath(value);
        if (path) assets.add(path);
      }
      const thumb = assetPath(opt.thumb);
      if (thumb) assets.add(thumb);
    }
    const glasses = GLASSES_STYLES[variants.glasses_style || 0];
    if (glasses) {
      for (const [part] of glasses.layers) assets.add(`variants/glasses/${glasses.base}_${part}.png`);
    }
    return [...assets];
  }

  function drawablesForAssets(assets) {
    const paths = new Set(assets);
    const drawables = new Set();
    for (const it of ITEMS) {
      for (const [drawable, texture] of Object.entries(it.textures || {})) {
        if (paths.has(assetPath(texture))) drawables.add(drawable);
      }
    }
    for (const v of VARIANTS) {
      const opt = v.options[variantState[v.key] || 0];
      for (const [drawable, texture] of Object.entries(opt.textures || {})) {
        if (paths.has(assetPath(texture))) drawables.add(drawable);
      }
    }
    if ([...paths].some(path => path.startsWith('variants/glasses/'))) {
      drawables.add('ModdableFace');
    }
    return drawables;
  }

  async function writeWardrobe(items, variants) {
    const wait = nextWardrobeWrite - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    nextWardrobeWrite = Date.now() + 500;
    const r = await fetch('/api/outfit.php', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items, variants, assets: activeAssets(items, variants) }),
    });
    if (!r.ok) throw new Error(`wardrobe update failed: ${r.status}`);
    return (await r.json()).state;
  }

  function importWardrobe(saved) {
    if (!saved || typeof saved !== 'object') return;
    authorizedAssets = new Set(Array.isArray(saved.assets) ? saved.assets : []);
    availableAssets = new Set(authorizedAssets);
    for (const it of ITEMS) if (typeof saved.items?.[it.key] === 'boolean') state[it.key] = saved.items[it.key];
    for (const v of VARIANTS) {
      const legacy = v.key === 'hair_h0_style' && typeof saved.items?.hair_clip === 'boolean'
        ? Number(saved.items.hair_clip) : undefined;
      const value = saved.variants?.[v.key] ?? legacy;
      if (Number.isInteger(value) && value >= 0 && value < v.options.length) variantState[v.key] = value;
    }
  }

  function queueWardrobe(mutator, after) {
    const items = { ...state };
    const variants = { ...variantState };
    mutator(items, variants);
    const changed = loadPresetState({ items, variants });
    const didChange = changed && (changed.items || changed.variants.length);
    if (!didChange) return wardrobeQueue;

    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
    try { localStorage.setItem(VARIANT_KEY, JSON.stringify(variantState)); } catch (e) {}
    applyChanged(changed);
    syncUI();
    if (after) after();

    pendingWardrobe = { items: { ...state }, variants: { ...variantState } };
    wardrobeQueue = wardrobeQueue.then(async () => {
      const pending = pendingWardrobe;
      if (!pending) return;
      pendingWardrobe = null;
      const saved = await writeWardrobe(pending.items, pending.variants);
      const nextAssets = new Set(Array.isArray(saved.assets) ? saved.assets : []);
      const addedAssets = [...nextAssets].filter(asset => !availableAssets.has(asset));
      authorizedAssets = nextAssets;
      for (const asset of nextAssets) availableAssets.add(asset);
      if (addedAssets.length) {
        applyItems();
        applyVariants();
        applyGlassesTexture();
        if (window.Mods?.owns
            && [...drawablesForAssets(addedAssets)].some(drawable => Mods.owns(drawable))) {
          Mods.applyAll();
        }
      }
    }).catch(e => console.error(e));
    return wardrobeQueue;
  }

  async function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        for (const it of ITEMS) {
          if (typeof saved[it.key] === 'boolean') state[it.key] = saved[it.key];
        }
      }
    } catch (e) {}
    try {
      const raw = localStorage.getItem(COLOR_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        for (const g of COLOR_GROUPS) {
          const value = saved[g.key];
          if (value === null) colors[g.key] = null;
          else {
            const normalized = normalizeHex(value);
            if (normalized) colors[g.key] = normalized;
          }
        }
      }
    } catch (e) {}
    try {
      const raw = localStorage.getItem(VARIANT_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        for (const v of VARIANTS) {
          const i = saved[v.key];
          if (Number.isInteger(i) && i >= 0 && i < v.options.length) variantState[v.key] = i;
        }
      }
    } catch (e) {}
    const r = await fetch('/api/outfit.php', { credentials: 'same-origin' });
    await loadBakedTiles();
    if (!r.ok) throw new Error(`wardrobe load failed: ${r.status}`);
    const remote = await r.json();
    if (remote.initialized) importWardrobe(remote.state);
    else importWardrobe(await writeWardrobe({ ...state }, { ...variantState }));
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
    try { localStorage.setItem(VARIANT_KEY, JSON.stringify(variantState)); } catch (e) {}
  }

  function saveVariants() {
    try { localStorage.setItem(VARIANT_KEY, JSON.stringify(variantState)); } catch (e) {}
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function saveColors() {
    try { localStorage.setItem(COLOR_KEY, JSON.stringify(colors)); } catch (e) {}
    if (window.Prefs) Prefs.pushToServer();
  }

  // this rig has no opacity control for these overlay meshes. the game does.
  const ALWAYS_HIDDEN = [
    'cumoutside', 'shadowboob', 'fondle',
    'nippiercing', 'navelpiercing',
  ];

  function applyItems(onlyItems) {
    const onlyKeys = onlyItems ? new Set(onlyItems) : null;
    const textureMap = {};
    for (const it of ITEMS) {
      if (onlyKeys && !onlyKeys.has(it.key)) continue;
      const on = state[it.key] && (!it.requires || state[it.requires]);
      if (it.param) Live2D.setTarget(it.param, on ? 1 : 0);
      if (it.visibilityPatterns && Live2D.opacityByPattern) {
        const visOn  = it.visOn  !== undefined ? it.visOn  : null;
        const visOff = it.visOff !== undefined ? it.visOff : 0;
        Live2D.opacityByPattern(it.visibilityPatterns, it.visibilityExcludes,
          on ? visOn : visOff);
      }
      // only set while it's worn. the item that owns them rewrites these
      // every pass, so clearing the override here just fights it.
      if (on && it.hideWhenOn && Live2D.opacityByPattern) {
        Live2D.opacityByPattern(it.hideWhenOn, [], 0);
      }
      for (const [drawable, texture] of Object.entries(it.textures || {})) {
        textureMap[drawable] = textureAvailable(texture) ? texture : null;
      }
    }
    if (Live2D.setDrawableTextures && Object.keys(textureMap).length) Live2D.setDrawableTextures(textureMap);
  }

  function applyAll() {
    if (Live2D.opacityByPattern) Live2D.opacityByPattern(ALWAYS_HIDDEN, [], 0);
    applyItems();
    applyVariants();
    // applyColors ends by re-running Mods, which has to see the fresh tints
    applyColors();
  }

  // only redraw the slot that changed. sending an atlas to the GPU is slow.
  function applyVariants(onlyKey) {
    if (!Live2D.setDrawableTextures) return;
    const onlyKeys = onlyKey
      ? new Set(Array.isArray(onlyKey) ? onlyKey : [onlyKey])
      : null;
    if (Live2D.setDrawableOrderBelow) {
      Live2D.setDrawableOrderBelow(
        VARIANTS.flatMap(v => v.options[variantState[v.key] || 0].order || []));
    }
    for (const v of VARIANTS) {
      if (onlyKeys && !onlyKeys.has(v.key)) continue;
      const opt = v.options[variantState[v.key] || 0];
      const owners = VARIANT_OWNER[v.key];
      const worn = !owners || owners.some(key => state[key]);
      if (v.key === 'sock_style' && stockingColorMode()) {
        applyStockingTexture();
      } else {
        if (v.key === 'sock_style') stockingsJob++;
        const map = {};
        for (const d of v.drawables) {
          const texture = opt.textures ? opt.textures[d] || null : null;
          map[d] = texture && textureAvailable(texture) ? texture : null;
        }
        Live2D.setDrawableTextures(map);
      }
      applyVariantVisibility(v);
    }
  }

  function applyVariantVisibility(v) {
    if (!Live2D.setDrawableOpacity) return;
    const opt = v.options[variantState[v.key] || 0];
    const owners = VARIANT_OWNER[v.key];
    const worn = !owners || owners.some(k => state[k]);
    const show = new Set(opt.show || []);
    const hide = new Set(opt.hide || []);
    const controlled = new Set();
    for (const o of v.options) {
      for (const d of o.show || []) controlled.add(d);
      for (const d of o.hide || []) controlled.add(d);
    }
    for (const d of controlled) {
      const op = owners && !worn ? 0 : show.has(d) ? 1 : hide.has(d) ? 0 : null;
      // null hands the drawable back to the rig, and the rig parks every
      // Moddable* slot at zero. a mod holding one needs it left on.
      if (op === null && window.Mods?.owns?.(d)) continue;
      Live2D.setDrawableOpacity(d, op);
    }
  }

  // mods.js calls this after it lets go of a drawable it had forced visible,
  // so whatever WE wanted showing there gets asserted again.
  function refreshVisibility() {
    for (const v of VARIANTS) applyVariantVisibility(v);
  }

  function setVariant(key, index) {
    const v = VARIANTS.find(x => x.key === key);
    if (!v || !v.options[index]) return;
    return queueWardrobe((items, variants) => { variants[key] = index; }, () => {
      if (key.indexOf('hair_') === 0 && window.WardrobeReactions) {
        WardrobeReactions.react({ key, label: v.label, on: true, state: snapshot() });
      }
    });
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
    // clear FIRST, or a small tint wipes out the colors of a bigger group
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
    if (stockingColorMode()) applyStockingTexture();
    // the face-mod slot only follows skin color while it holds face art.
    // glasses sit in the same slot and must NOT get tinted like skin.
    if ((variantState.glasses_style || 0) > 0) Live2D.setDrawableTint('ModdableFace', null);
    applyGlassesTexture();
    // a mod holding one of these drawables took its tint off the shader and
    // bakes it in itself, so it has to re-read whatever we just set. every
    // path that recolors her comes through here, which is why the call lives
    // here and not in applyAll.
    if (window.Mods) Mods.refreshTints();
  }

  // lens/frame colors can't be drawable tints, the glasses composite into one
  // drawable, so each part gets multiplied client-side and the result baked
  // into the ModdableFace texture.
  const GLASSES_STYLES = [
    null,
    { base: 'glasses', layers: [['lens', 'glasses_lens'], ['highlight', null], ['frame', 'glasses_frame']] },
    { base: 'heartGlasses', layers: [['lens', 'glasses_lens'], ['frame', 'glasses_frame'], ['heart', 'glasses_frame'], ['highlight', null]] },
  ];
  const textureImgCache = {};
  const textureImg = (url) => textureImgCache[url] || (textureImgCache[url] = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  }).catch((e) => { delete textureImgCache[url]; throw e; }));

  function tintedLayer(img, hex) {
    if (!hex) return img;
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(img, 0, 0);
    return c;
  }

  function duotoneLayer(img, mainHex, accentHex) {
    if (!accentHex) return tintedLayer(img, mainHex);
    const main = hexToRgb01(mainHex || '#ffffff').map(value => value * 255);
    const accent = hexToRgb01(accentHex).map(value => value * 255);
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, c.width, c.height);
    const data = pixels.data;
    for (let i = 0; i < data.length; i += 4) {
      if (!data[i + 3]) continue;
      const light = Math.max(data[i], data[i + 1], data[i + 2]) / 255;
      data[i] = accent[0] + (main[0] - accent[0]) * light;
      data[i + 1] = accent[1] + (main[1] - accent[1]) * light;
      data[i + 2] = accent[2] + (main[2] - accent[2]) * light;
    }
    ctx.putImageData(pixels, 0, 0);
    return c;
  }

  function stockingColorMode() {
    const variant = VARIANTS.find(v => v.key === 'sock_style');
    return variant.options[variantState.sock_style || 0].colorMode || null;
  }
  let stockingsJob = 0;

  async function applyStockingTexture() {
    if (!Live2D.setDrawableTextures) return;
    const index = variantState.sock_style || 0;
    const variant = VARIANTS.find(v => v.key === 'sock_style');
    const opt = variant.options[index];
    const mode = opt.colorMode;
    if (!mode) return;
    const entries = Object.entries(opt.textures || {}).filter(([, texture]) => textureAvailable(texture));
    const job = ++stockingsJob;
    if (entries.length !== variant.drawables.length) {
      Live2D.setDrawableTextures(Object.fromEntries(variant.drawables.map(drawable => [drawable, null])));
      return;
    }
    let loaded;
    try {
      loaded = await Promise.all(entries.map(async ([drawable, texture]) => {
        const url = typeof texture === 'object' ? texture.url : texture;
        return [drawable, url, await textureImg(url)];
      }));
    } catch (e) {
      if (job === stockingsJob) setTimeout(applyStockingTexture, 1000);
      return;
    }
    if (job !== stockingsJob || (variantState.sock_style || 0) !== index) return;
    const main = colors.stockings;
    const accent = colors.stockings_accent;
    const map = {};
    for (const [drawable, url, img] of loaded) {
      if (mode === 'overlay') {
        map[drawable] = {
          img: tintedLayer(img, accent),
          key: `${url}|${main || ''}|${accent || ''}`,
          overlay: true,
          baseTint: main,
        };
      } else {
        map[drawable] = {
          img: duotoneLayer(img, main, accent),
          key: `${url}|${main || ''}|${accent || ''}`,
        };
      }
    }
    await Live2D.setDrawableTextures(map);
    if (job !== stockingsJob || (variantState.sock_style || 0) !== index) return;
    for (const drawable of variant.drawables) Live2D.setDrawableTint(drawable, null);
  }

  let glassesJob = 0;
  async function applyGlassesTexture() {
    const style = GLASSES_STYLES[variantState.glasses_style || 0];
    if (!style || !Live2D.setDrawableTextures) return;
    if (style.layers.some(([part]) =>
      !availableAssets.has(`variants/glasses/${style.base}_${part}.png`))) return;
    const job = ++glassesJob;
    let imgs;
    try {
      imgs = await Promise.all(style.layers.map(([part]) =>
        textureImg(`assets/variants/glasses/${style.base}_${part}.png`)));
    } catch (e) {
      // a dropped load leaves the raw ModdableFace atlas art on screen, so
      // retry instead of giving up for the rest of the session
      console.warn('glasses layer load failed, retrying', e);
      if (job === glassesJob) setTimeout(applyGlassesTexture, 1000);
      return;
    }
    if (job !== glassesJob || GLASSES_STYLES[variantState.glasses_style || 0] !== style) return;
    const c = document.createElement('canvas');
    c.width = imgs[0].width; c.height = imgs[0].height;
    const ctx = c.getContext('2d');
    style.layers.forEach(([, colorKey], i) => {
      ctx.drawImage(tintedLayer(imgs[i], colorKey && colors[colorKey]), 0, 0);
    });
    Live2D.setDrawableTextures({ ModdableFace: { url: c.toDataURL(), fullClear: true } });
  }

  function setDraftItem(items, key, on) {
    const it = ITEMS.find(x => x.key === key);
    if (!it) return;
    items[key] = !!on;
    if (items[key] && it.excludes) for (const ex of it.excludes) items[ex] = false;
  }

  function setItem(key, on) {
    const it = ITEMS.find(x => x.key === key);
    if (!it) return;
    return queueWardrobe((items) => setDraftItem(items, key, on), () => {
      if (window.WardrobeReactions) {
        WardrobeReactions.react({ key, label: it.label, on: state[key], state: snapshot() });
      }
    });
  }

  function setColor(key, hex) {
    if (!(key in colors)) return;
    const value = hex === null ? null : normalizeHex(hex);
    if (hex !== null && value === null) return;
    colors[key] = value;
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

  let popupViewportListening = false, popupViewportRaf = 0;

  function visualViewportRect() {
    if (window.MobileViewport && MobileViewport.getVisualRect) return MobileViewport.getVisualRect();
    const viewport = window.visualViewport;
    const left = viewport ? viewport.offsetLeft : 0;
    const top = viewport ? viewport.offsetTop : 0;
    const width = viewport ? viewport.width : innerWidth;
    const height = viewport ? viewport.height : innerHeight;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }

  function phonePopupMode() {
    return window.MobileViewport
      ? MobileViewport.isPhone()
      : document.documentElement.classList.contains('phone-ui');
  }

  function schedulePopupPosition() {
    if (popupViewportRaf) cancelAnimationFrame(popupViewportRaf);
    popupViewportRaf = requestAnimationFrame(() => {
      popupViewportRaf = 0;
      if (colorPickerEl && !colorPickerEl.hidden && !pickerEmbedded()) positionColorPicker();
      if (optPopEl && !optPopEl.hidden) positionOptionsPopup();
    });
  }

  function watchPopupViewport() {
    if (popupViewportListening) return;
    popupViewportListening = true;
    if (window.MobileViewport) MobileViewport.subscribe(schedulePopupPosition);
    else {
      window.addEventListener('resize', schedulePopupPosition);
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', schedulePopupPosition);
        window.visualViewport.addEventListener('scroll', schedulePopupPosition);
      }
    }
  }

  function pickerEmbedded() {
    return !!(colorPickerEl && colorPickerEl.classList.contains('ocp-embedded'));
  }

  function closeColorPicker(focusAnchor, force) {
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

  function showColorPicker(anchor, label, state, embedContainer) {
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

  function makeItemColorButton(label, slotLabels, initialValues, onChange, className = 'wd-swatch', toggle = null) {
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
    // wardrobe.html has no settings panel, just the wardrobe
    syncWardrobe();
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
    return queueWardrobe((items, variants) => {
      for (const it of ITEMS) items[it.key] = it.defaultOn;
      for (const v of VARIANTS) variants[v.key] = 0;
    }, () => {
      for (const g of COLOR_GROUPS) colors[g.key] = g.defaultColor || null;
      saveColors();
      applyColors();
    });
  }

  function exportPreset() {
    return { items: { ...state }, colors: { ...colors }, variants: { ...variantState } };
  }

  const SHARE_CODE_MAX_LENGTH = 16 * 1024;
  const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

  function plainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function hasOnlyKeys(value, allowed) {
    return Object.keys(value).every(key => allowed.has(key));
  }

  function canonicalPreset(input) {
    if (!plainObject(input)
        || !hasOnlyKeys(input, new Set(['items', 'colors', 'variants']))) {
      throw new Error('invalid outfit');
    }
    const itemInput = input.items === undefined ? {} : input.items;
    const colorInput = input.colors === undefined ? {} : input.colors;
    const variantInput = input.variants === undefined ? {} : input.variants;
    if (!plainObject(itemInput) || !plainObject(colorInput) || !plainObject(variantInput)) {
      throw new Error('invalid outfit');
    }

    const itemKeys = new Set([...ITEMS.map(it => it.key), 'hair_clip']);
    const colorKeys = new Set(COLOR_GROUPS.map(group => group.key));
    const variantKeys = new Set(VARIANTS.map(variant => variant.key));
    if (!hasOnlyKeys(itemInput, itemKeys)
        || !hasOnlyKeys(colorInput, colorKeys)
        || !hasOnlyKeys(variantInput, variantKeys)) {
      throw new Error('invalid outfit');
    }

    const clean = { items: {}, colors: {}, variants: {} };
    if (hasOwn(itemInput, 'hair_clip') && typeof itemInput.hair_clip !== 'boolean') {
      throw new Error('invalid outfit');
    }
    for (const it of ITEMS) {
      const value = hasOwn(itemInput, it.key) ? itemInput[it.key] : it.defaultOn;
      if (typeof value !== 'boolean') throw new Error('invalid outfit');
      clean.items[it.key] = value;
    }
    for (const it of ITEMS) {
      if (!clean.items[it.key]) continue;
      for (const excluded of it.excludes || []) {
        if (clean.items[excluded]) throw new Error('invalid outfit');
      }
    }
    for (const group of COLOR_GROUPS) {
      const fallback = group.defaultColor || null;
      const value = hasOwn(colorInput, group.key) ? colorInput[group.key] : fallback;
      if (value !== null && (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value))) {
        throw new Error('invalid outfit');
      }
      clean.colors[group.key] = typeof value === 'string' ? value.toLowerCase() : null;
    }
    for (const variant of VARIANTS) {
      const legacy = variant.key === 'hair_h0_style' && itemInput.hair_clip === true ? 1 : 0;
      const value = hasOwn(variantInput, variant.key) ? variantInput[variant.key] : legacy;
      if (!Number.isInteger(value) || value < 0 || value >= variant.options.length) {
        throw new Error('invalid outfit');
      }
      clean.variants[variant.key] = value;
    }
    return clean;
  }

  function encodeOutfitCode() {
    return btoa(JSON.stringify({ v: 1, outfit: canonicalPreset(exportPreset()) }));
  }

  function decodeOutfitCode(value) {
    const code = typeof value === 'string' ? value.trim() : '';
    if (!code || code.length > SHARE_CODE_MAX_LENGTH || !BASE64_PATTERN.test(code)) {
      throw new Error('invalid outfit code');
    }
    let payload;
    try {
      payload = JSON.parse(atob(code));
    } catch (e) {
      throw new Error('invalid outfit code');
    }
    if (!plainObject(payload) || payload.v !== 1
        || !hasOnlyKeys(payload, new Set(['v', 'outfit']))) {
      throw new Error('invalid outfit code');
    }
    return canonicalPreset(payload.outfit);
  }

  // returns the slots that actually moved, so callers can skip the expensive
  // parts of applyAll(). a full applyVariants() recomposes EVERY atlas.
  function loadPresetState(preset) {
    if (!preset || typeof preset !== 'object') return null;
    const { items = {}, colors: cols = {}, variants = {} } = preset;
    const changed = { items: false, itemKeys: [], colors: false, variants: [] };
    for (const it of ITEMS) {
      const on = items[it.key];
      if (typeof on === 'boolean' && state[it.key] !== on) {
        state[it.key] = on;
        changed.items = true;
        changed.itemKeys.push(it.key);
      }
    }
    for (const g of COLOR_GROUPS) {
      const c = cols[g.key];
      if ((typeof c === 'string' || c === null) && colors[g.key] !== c) {
        colors[g.key] = c;
        changed.colors = true;
      }
    }
    for (const v of VARIANTS) {
      const i = variants[v.key];
      if (Number.isInteger(i) && i >= 0 && i < v.options.length && variantState[v.key] !== i) {
        variantState[v.key] = i;
        changed.variants.push(v.key);
      }
    }
    return changed;
  }

  function applyChanged(changed) {
    if (!changed) return;
    if (changed.items) applyItems(changed.itemKeys);
    const variantKeys = new Set(changed.variants);
    if (changed.items) {
      const changedItems = new Set(changed.itemKeys);
      for (const v of VARIANTS) {
        if (VARIANT_OWNER[v.key]?.some(key => changedItems.has(key))) variantKeys.add(v.key);
      }
    }
    if (variantKeys.size) applyVariants([...variantKeys]);
    if (changed.colors || changed.variants.length) applyColors();
  }

  function applyPreset(preset) {
    clearTimeout(previewTimer);
    const clean = canonicalPreset(preset);
    previewBase = null;
    const wardrobeChanged = ITEMS.some(it => state[it.key] !== clean.items[it.key])
      || VARIANTS.some(v => variantState[v.key] !== clean.variants[v.key]);
    const applyPresetColors = () => {
      for (const g of COLOR_GROUPS) colors[g.key] = clean.colors[g.key];
      saveColors();
      applyColors();
    };
    const queued = queueWardrobe((items, variants) => {
      Object.assign(items, clean.items);
      Object.assign(variants, clean.variants);
    }, applyPresetColors);
    if (!wardrobeChanged) applyPresetColors();
    return queued;
  }

  // the preview is look-at-only, dressing gestures on the model are suspended
  // while the modal is up
  const looksOpen = () => document.body.classList.contains('looks-open');

  // preview dresses the model without touching storage. previewBase holds the
  // look to fall back to until the user either commits or leaves the card.
  let previewBase = null;
  function previewPreset(preset) {
    if (!preset) return;
    const items = { ...state, ...(preset.items || {}) };
    const variants = { ...variantState, ...(preset.variants || {}) };
    if (!activeAssets(items, variants).every(path => authorizedAssets.has(path))) return;
    if (!previewBase) previewBase = exportPreset();
    applyChanged(loadPresetState(preset));
  }
  // otherwise sliding the pointer down the list queues one full re-dress
  // per row it crosses. no thank you.
  let previewTimer = null;
  function schedulePreview(preset) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => previewPreset(preset), 90);
  }
  function endPreview() {
    clearTimeout(previewTimer);
    if (!previewBase) return;
    const base = previewBase;
    previewBase = null;
    applyChanged(loadPresetState(base));
  }

  const Presets = (function () {
    const url = '/api/wardrobe.php';
    let cache = [];

    async function list() {
      const r = await fetch(url, { credentials: 'same-origin' });
      if (!r.ok) throw new Error('load failed');
      const rows = await r.json();
      if (!Array.isArray(rows)) throw new Error('load failed');
      cache = rows.flatMap(row => {
        try {
          if (!plainObject(row) || typeof row.name !== 'string') return [];
          return [{
            id: row.id,
            name: row.name,
            updated_at: Number.isFinite(row.updated_at) ? row.updated_at : 0,
            data: canonicalPreset(row.data),
          }];
        } catch (e) {
          return [];
        }
      });
      return cache;
    }
    async function save(name) {
      const r = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, data: exportPreset() }),
      });
      if (!r.ok) throw new Error('save failed');
      return list();
    }
    async function remove(id) {
      const r = await fetch(`${url}?id=${encodeURIComponent(id)}`, {
        method: 'DELETE', credentials: 'same-origin',
      });
      if (!r.ok) throw new Error('delete failed');
      return list();
    }
    const find = (id) => cache.find(p => String(p.id) === String(id)) || null;

    return { list, save, remove, find, get cache() { return cache; } };
  })();

  let looksEl = null, looksActiveId = null, clearWornHover = null;

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

    // the dialog's right pane is an empty hole. the real Live2D stage gets
    // moved under it so the preview IS the live model, not a second renderer.
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

  function toggleLooks(force) {
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

  let wdOverlay = null, wdTooltip = null, wdGhost = null, wdUpdateExpand = null;

  const itemPatterns = (it) => it.colorPatterns || it.visibilityPatterns || [];

  function wornDrawableMap() {
    const map = new Map();
    for (const it of ITEMS) {
      if (!state[it.key]) continue;
      for (const id of Live2D.findDrawables(itemPatterns(it), it.colorExcludes)) map.set(id, it.key);
    }
    if ((variantState.glasses_style || 0) > 0) map.set('ModdableFace', 'glasses_style');
    return map;
  }

  function wornLabel(key) {
    const it = ITEMS.find(x => x.key === key);
    if (it) return it.label;
    const v = VARIANTS.find(x => x.key === key);
    return v ? v.label : key;
  }

  let lastGlassesIdx = 1;
  function wornRemove(key) {
    if (key === 'glasses_style') {
      lastGlassesIdx = variantState.glasses_style || 1;
      setVariant(key, 0);
    } else setItem(key, false);
  }
  function wornWear(key) {
    if (key === 'glasses_style') setVariant(key, lastGlassesIdx || 1);
    else setItem(key, true);
  }

  // small accessories (bow, choker, glasses) are a nightmare to grab with an
  // exact mesh test, so the tolerance falls back to padded bounding boxes
  function wornHitAt(x, y, worn) {
    return Live2D.drawableAt(x, y, new Set(worn.keys()), 16);
  }

  // tiles baked by tools/bake-items.html, sitting in the gitignored
  // webapp/assets/items/. they're game art, so they never ship - whoever ran
  // the extractor bakes their own. no manifest means no bake ran here and
  // every tile falls back to the atlas crop below.
  let bakedTiles = new Set();
  async function loadBakedTiles() {
    try {
      const r = await fetch('assets/items/manifest.json', { credentials: 'same-origin' });
      if (r.ok) bakedTiles = new Set(await r.json());
    } catch (e) {}
  }
  const bakedTile = (name) => bakedTiles.has(name) ? `assets/items/${name}.png` : null;

  // the shots the baker takes. each one dresses her in exactly the item being
  // photographed and keeps only its drawables on screen, so what comes back is
  // the garment laid out the way she wears it instead of one wedge of atlas.
  // glasses, logos and the limb styles stay out: they're painted into a face
  // or body texture, so cropping to their drawables gets you her whole face.
  function bakeShots() {
    const shots = [];
    const allOff = Object.fromEntries(ITEMS.map(it => [it.key, false]));
    const drawablesOf = (keys) => {
      const ids = new Set();
      for (const key of keys) {
        const it = ITEMS.find(x => x.key === key);
        if (it) for (const id of Live2D.findDrawables(itemPatterns(it), it.colorExcludes)) ids.add(id);
      }
      return ids;
    };
    for (const it of ITEMS) {
      const worn = [it.key, ...(it.requires ? [it.requires] : [])];
      shots.push({
        name: it.key,
        items: { ...allOff, ...Object.fromEntries(worn.map(k => [k, true])) },
        variants: {},
        keep: () => drawablesOf([it.key]),
      });
    }
    for (const key of ['skirt_style', 'sock_style', 'shoe_style']) {
      const v = VARIANTS.find(x => x.key === key);
      const owners = VARIANT_OWNER[key] || [];
      v.options.forEach((opt, i) => {
        shots.push({
          name: `${key}-${i}`,
          items: { ...allOff, ...Object.fromEntries(owners.map(k => [k, true])) },
          variants: { [key]: i },
          keep: () => drawablesOf(owners),
        });
      });
    }
    return shots;
  }

  // maintainer-only, driven by tools/bake-items.html. moves state through
  // loadPresetState/applyChanged rather than setItem, so it never PUTs and
  // never waits out writeWardrobe's 500ms spacing - 40 shots would otherwise
  // be half a minute of round trips.
  async function bakeAll(onProgress) {
    const restore = exportPreset();
    const shots = bakeShots();
    const out = [];
    try {
      for (let i = 0; i < shots.length; i++) {
        const shot = shots[i];
        if (onProgress) onProgress(i, shots.length, shot.name);
        applyChanged(loadPresetState({ items: shot.items, variants: shot.variants }));
        // applyVariants fires the atlas recomposite and doesn't wait for it.
        // shoot without this and every variant tile is one style behind - you
        // get two identical Default/Sneakers shoes and nothing tells you.
        if (Live2D.texturesSettled) await Live2D.texturesSettled();
        await new Promise(r => setTimeout(r, 0));
        const png = Live2D.bakeThumb(shot.keep(), 256);
        if (png) out.push({ name: shot.name, png });
      }
    } finally {
      applyChanged(loadPresetState(restore));
    }
    return out;
  }

  function itemThumb(it) {
    const baked = bakedTile(it.key);
    if (baked) return baked;
    const ids = Live2D.findDrawables(itemPatterns(it), it.colorExcludes);
    let best = null, bestPx = 0;
    for (const id of ids) {
      const img = Live2D.drawableThumb(id, 72);
      if (!img) continue;
      // data URL length is a rough proxy for crop detail. good enough tbh.
      const px = img.length;
      if (px > bestPx) { bestPx = px; best = img; }
    }
    return best;
  }

  function variantThumb(v, opt) {
    // a baked shot is the whole garment on its own, so it reads fine even when
    // the variant isn't worn. the drawable crop further down only shows
    // anything while the model is actually wearing it.
    const baked = bakedTile(`${v.key}-${v.options.indexOf(opt)}`);
    if (baked) return baked;
    // opt.thumb is the decal png on its own (logos, the two glasses shots), so
    // it reads whether or not she's wearing it. api/assets.php serves those
    // ungated for exactly this.
    if (opt.thumb) return opt.thumb;
    const owners = VARIANT_OWNER[v.key];
    const active = v.options[variantState[v.key] || 0] === opt
      && (!owners || owners.some(key => state[key]));
    if (active) {
      for (const val of Object.values(opt.textures || {})) {
        const url = typeof val === 'object' ? val.url : val;
        if (url) return url;
      }
    }
    return Live2D.drawableThumb(opt.drawable || v.drawables[0], 72);
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

  function makeSwatch(groupKeys, label) {
    return makeColorButton(groupKeys, label, 'wd-swatch');
  }

  let optPopEl = null, optPopAnchor = null, optPopItemKey = null;

  function closeOptionsPopup(focusAnchor) {
    if (!optPopEl || optPopEl.hidden) return;
    closeColorPicker(false, true);
    optPopEl.hidden = true;
    if (focusAnchor && optPopAnchor) optPopAnchor.focus();
    optPopAnchor = null;
    optPopItemKey = null;
  }

  function positionOptionsPopup() {
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

  function openTilePopup(anchor, cfg) {
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
        b.innerHTML = `${thumb ? `<img draggable="false" src="${thumb}">` : '<div class="wd-noimg">?</div>'}<span>${opt.name}</span>`;
        b.addEventListener('click', () => setVariant(v.key, i));
        grid.appendChild(b);
      });
    }
    optPopEl.hidden = false;
    syncOptionsPopup();
    positionOptionsPopup();
  }

  function syncOptionsPopup() {
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

  function makeOptOrb(cfg) {
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

  function makeTile(label, thumbSrc, onEquip, colorKeys, popupCfg) {
    const tile = document.createElement('div');
    tile.className = 'wd-tile';
    tile.tabIndex = 0;
    tile.setAttribute('role', 'button');
    tile.setAttribute('aria-label', `${label} options`);
    tile.innerHTML = `${thumbSrc ? `<img draggable="false" src="${thumbSrc}">` : '<div class="wd-noimg">?</div>'}<span>${label}</span>`;
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

  function buildWardrobe() {
    const coarsePointer = matchMedia('(pointer: coarse)');
    wdOverlay = document.createElement('div');
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

    const expandableGrids = [];
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
      const expand = document.createElement('button');
      expand.type = 'button';
      expand.className = 'wd-expand';
      expand.title = 'Show all';
      expand.hidden = true;
      expand.setAttribute('aria-expanded', 'false');
      expand.textContent = '⌄';
      expand.addEventListener('click', () => {
        const on = grid.classList.toggle('expanded');
        expand.classList.toggle('on', on);
        expand.setAttribute('aria-expanded', String(on));
        expand.title = on ? 'Collapse' : 'Show all';
      });
      t.appendChild(expand);
      expandableGrids.push([grid, expand]);
      return { title: t, grid };
    };
    const updateExpandButtons = () => {
      for (const [grid, expand] of expandableGrids) {
        expand.hidden = !(grid.classList.contains('expanded') || grid.scrollWidth > grid.clientWidth + 1);
      }
    };
    window.addEventListener('resize', updateExpandButtons);
    wdUpdateExpand = updateExpandButtons;

    const tileGroups = new Set(Object.values(ITEM_COLOR_GROUPS).flat());
    const studioKeys = COLOR_GROUPS.filter(g =>
      !tileGroups.has(g.key) &&
      (!Live2D.findDrawables || Live2D.findDrawables(g.includes, g.excludes).length))
      .map(g => g.key);

    const makeVariantTile = (v, colorKeys) => {
      const tile = document.createElement('div');
      tile.className = 'wd-tile';
      tile.tabIndex = 0;
      tile.setAttribute('role', 'button');
      tile.setAttribute('aria-label', `Choose ${v.label.toLowerCase()}`);
      const thumb = variantThumb(v, v.options[variantState[v.key] || 0]);
      tile.innerHTML = `${thumb ? `<img draggable="false" src="${thumb}">` : '<div class="wd-noimg">?</div>'}<span>${v.label}</span>`;
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

    for (const [sec, name, icon] of [[undefined, 'Clothing', '👗'], ['body', 'Body', '🐾'], ['hair', 'Hair', '💇']]) {
      const { title, grid } = section(name);
      addNav(name, icon, title);
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

  function openWardrobe() {
    if (!wdOverlay) buildWardrobe();
    document.body.classList.add('wardrobe-open');
    if (wdUpdateExpand) requestAnimationFrame(wdUpdateExpand);
    if (window.WardrobeReactions) return WardrobeReactions.activate();
  }

  let leavingWardrobePage = false;
  function closeWardrobe() {
    if (location.pathname.endsWith('wardrobe.html')) {
      if (leavingWardrobePage) return;
      leavingWardrobePage = true;
      const go = () => { location.href = 'index.html?from=wardrobe'; };
      if (window.WardrobeReactions && WardrobeReactions.playOutro) {
        WardrobeReactions.playOutro().catch(() => {}).then(go);
      } else go();
      return;
    }
    document.body.classList.remove('wardrobe-open');
    if (looksEl) toggleLooks(false);
    if (window.WardrobeReactions) WardrobeReactions.deactivate();
    closeOptionsPopup(false);
    wdTooltip.style.display = 'none';
    wdShowGhost(null);
    document.body.classList.remove('wd-over-worn-item');
  }

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
    const hair = ITEMS.filter(it => it.section === 'hair');
    if (hair.some(it => state[it.key] !== it.defaultOn)) {
      const on = hair.filter(it => state[it.key]);
      s += on.length ? ` Your hair style: ${phrase(on)}.` : ' Your hair is completely hidden (bald).';
    }
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

  function syncFromAction(name, kwargs) {
    if ((name || '').toLowerCase() !== 'outfit') return;
    const item = (kwargs.item || '').toLowerCase();
    const stateOn = (kwargs.state || 'on').toLowerCase() === 'on';
    const aliases = {
      shoes: ['shoe_l', 'shoe_r'],
      shoe_left: ['shoe_l'],
      shoe_right: ['shoe_r'],
      hat: ['wizard_hat'],
      witch_hat: ['wizard_hat'],
      dress_alt: ['dress1'],
      socks: ['stockings'],
      catears: ['cat_ears'],
      bikini: ['bikini_top', 'bikini_bot'],
      swimsuit: ['bikini_top', 'bikini_bot'],
      bikini_bottom: ['bikini_bot'],
    };
    if (item === 'hairclip' || item === 'clip') {
      return queueWardrobe((items, variants) => {
        if (stateOn) setDraftItem(items, 'hair_h0', true);
        variants.hair_h0_style = stateOn ? 1 : 0;
      });
    }
    const keys = aliases[item] || (ITEMS.some(it => it.key === item) ? [item] : []);

    if (item === 'nude' && stateOn) {
      return queueWardrobe((items) => {
        for (const it of ITEMS) if (!it.section) items[it.key] = false;
      });
    }

    return queueWardrobe((items) => {
      for (const key of keys) setDraftItem(items, key, stateOn);
    });
  }

  return { load, applyAll, describe, snapshot, reset, syncFromAction, setVariant, openWardrobe,
    makeItemColorButton, refreshColors: applyColors, refreshVisibility, bakeAll };
})();
