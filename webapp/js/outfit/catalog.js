
export const ITEMS = [
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
    // PlainShirt_FrontNoBras matches bra, whose tint runs after
    // shirt. exclude it or the v0.97.5 bikini top exposes a shirt
    // front in bra colour.
    colorPatterns: ['bra'], colorExcludes: ['skin','braid','nobras'] },
  { key: 'panties', label: 'Panties', param: 'ParamPantiesEnabled', defaultOn: true, excludes: ['bikini_bot'],
    colorPatterns: ['panties'], colorExcludes: ['logo'] },
  // v0.97.5 swimwear. no rig parameters either, so visibility only
  { key: 'bikini_top', label: 'Bikini top', defaultOn: false, excludes: ['bra'],
    colorPatterns: ['bikinitop'], visibilityPatterns: ['bikinitop'], visOn: 1, visOff: 0 },
  { key: 'bikini_bot', label: 'Bikini bottom', defaultOn: false, excludes: ['panties'],
    colorPatterns: ['bikinibot'], visibilityPatterns: ['bikinibot'], visOn: 1, visOff: 0 },
  // in this moc3 (the compiled Cubism rig file) the shoe
  // parameters don't touch opacity AT ALL
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

export const COLOR_GROUPS = [
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

  // applyGlassesTexture paints these into the ModdableFace
  // texture itself. they're not drawable tints (a drawable is one
  // mesh of the rig), so there's nothing to include here
  { key: 'glasses_frame', label: 'Glasses frame', includes: [], excludes: [] },
  { key: 'glasses_lens', label: 'Glasses lens', includes: [], excludes: [] },

  { key: 'stockings_accent', label: 'Accent', includes: [], excludes: [] },

  ...ITEMS.filter(it => it.colorPatterns).map(it => ({
    key: it.key, label: it.label,
    includes: it.colorPatterns, excludes: it.colorExcludes || [],
  })),
];

export const ITEM_COLOR_GROUPS = {
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

export const ITEM_VARIANTS = {
  hair_h0: ['hair_h0_style'],
  shirt: ['shirt_logo', 'sleeve_logo'],
  hoodie: ['hoodie_logo'],
  panties: ['panties_logo'],
  skirt: ['skirt_style'],
  stockings: ['sock_style'],
  shoe_l: ['shoe_style'],
  shoe_r: ['shoe_style'],
};

export const BODY_VARIANTS = ['arm_style', 'leg_style', 'hightech_skin'];

export const CLOTHING_VARIANTS = ['glasses_style'];

export const VARIANT_OWNER = {};
for (const [itemKey, variantKeys] of Object.entries(ITEM_VARIANTS)) {
  for (const variantKey of variantKeys) {
    (VARIANT_OWNER[variantKey] = VARIANT_OWNER[variantKey] || []).push(itemKey);
  }
}

// variants/logos/ mirrors DECALS in tools/recover_assets.py.
// the garment tags (s shirt, h hoodie, p panties) follow the
// game's Il2Cpp item names, BedabotsShirt, MilfHunterHoodie,
// USBPanties (Il2Cpp is Unity's compiled C#). so a picker only
// offers the decals the game actually has on that garment.
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

const LIMB_DIR = 'assets/variants/limbs';

// these regions overlap on the atlas (the big shared texture
// sheet), so they need alphaClip
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

// hightechHypercamoSkin_interact gives barcode and lines 100%
// transparent rects. these remove her chest barcode and cheek
// cracks, so put them in hide, not the texture list.
const HT_SKIN_IDS = ['SkinArmL', 'SkinArmR', 'SkinPelvis', 'SkinThighL', 'SkinThighR'];

// mech knees have to be told to draw over the calf and thigh
const LEG_ORDER = [
  ['AttachLegLLower', 'AttachLegLThigh'], ['AttachLegRLower', 'AttachLegRThigh'],
];

export const VARIANTS = [
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
      // alphaClip erases wherever the patch has alpha. a fully
      // transparent crop erases nothing, so these rig drawables
      // would stay visible. hide them by name instead.
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

// this rig has no opacity control for these overlay meshes. the
// game does.
export const ALWAYS_HIDDEN = [
  'cumoutside', 'shadowboob', 'fondle',
  'nippiercing', 'navelpiercing',
];

// lens/frame colors can't be drawable tints, the glasses
// composite into one drawable, so each part gets multiplied
// client-side and the result baked into the ModdableFace texture.
export const GLASSES_STYLES = [
  null,
  { base: 'glasses', layers: [['lens', 'glasses_lens'], ['highlight', null], ['frame', 'glasses_frame']] },
  { base: 'heartGlasses', layers: [['lens', 'glasses_lens'], ['frame', 'glasses_frame'], ['heart', 'glasses_frame'], ['highlight', null]] },
];

export const colorGroup = (key) => COLOR_GROUPS.find(g => g.key === key);
