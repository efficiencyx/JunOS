import { BODY_VARIANTS, COLOR_GROUPS, ITEM_COLOR_GROUPS, ITEM_VARIANTS, ITEMS, VARIANTS } from './catalog.js?v=7';
import { Presets, applyPreset } from './presets.js?v=49';
import { queueWardrobe } from './sync.js?v=49';
import { setColor, setDraftItem } from './apply.js?v=49';
import { colors, state, variantState } from './current.js?v=8';
import * as Mods from '../mods/mods.js?v=120';

// every color and style rides on the item it belongs to: "shirt (#333333, bedabots logo)"
export function describe() {
  const clothes = ITEMS.filter(it => !it.section);
  const mods = Mods.inventory();
  const worn = pairShoes([...clothes.filter(it => state[it.key]).map(it => described(it)), ...glasses(), ...mods.worn]);
  const bare = pairShoes(clothes.filter(it => !state[it.key]).map(it => it.label.toLowerCase()));
  let s;
  if (worn.length === 0) s = 'You are currently fully nude (wearing nothing).';
  else {
    s = `You are currently wearing: ${worn.join(', ')}.`;
    if (bare.length) s += ` Not wearing: ${bare.join(', ')}.`;
  }
  const body = [
    ...ITEMS.filter(it => it.section === 'body' && state[it.key]).map(it => described(it)),
    ...BODY_VARIANTS.map(styleName).filter(Boolean),
  ];
  if (body.length) s += ` Your body features: ${body.join(', ')}.`;
  const hair = ITEMS.filter(it => it.section === 'hair');
  const hairOn = hair.filter(it => state[it.key]);
  if (!hairOn.length) s += ' Your hair is completely hidden (bald).';
  else {
    const pieces = hairOn.map(it => described(it, 'hair'));
    if (colors.hair || pieces.join() !== hairOn.map(it => it.label.toLowerCase()).join()
      || hair.some(it => state[it.key] !== it.defaultOn)) {
      s += ` Your hair${colors.hair ? ` (${colors.hair})` : ''}: ${pieces.join(', ')}.`;
    }
  }
  const makeup = ITEMS.filter(it => it.section === 'makeup' && state[it.key]);
  if (makeup.length) s += ` Your makeup: ${makeup.map(it => described(it)).join(', ')}.`;
  const rest = COLOR_GROUPS.filter(g => colors[g.key] && colors[g.key] !== g.defaultColor && !itemOwned(g.key))
    .map(g => colorName(g.key));
  if (rest.length) s += ` Other colors: ${rest.join(', ')}.`;
  if (mods.owned.length) {
    s += ` Special items you own, put on by exact name with [A:outfit|item=NAME|state=on]: ${mods.owned.join(', ')}.`;
  }
  const looks = Presets.cache.map(p => p.name);
  if (looks.length) s += ` Saved looks, put on whole with [A:wear_look|name=NAME]: ${looks.join(', ')}.`;
  return s;
}

const colorName = (key) => `${key.replace(/_/g, ' ')} ${colors[key]}`;

// the main color goes bare, any other one keeps its key so recolor can find it
function described(it, sharedColor = null) {
  const [main, ...extra] = ITEM_COLOR_GROUPS[it.key] || [];
  const parts = [];
  if (main && main !== sharedColor && colors[main]) parts.push(colors[main]);
  for (const key of ITEM_VARIANTS[it.key] || []) {
    const style = styleName(key);
    if (style) parts.push(/logo/i.test(style) ? style.replace(`${it.label.toLowerCase()} `, '') : style);
  }
  for (const key of extra) if (colors[key]) parts.push(colorName(key));
  return it.label.toLowerCase() + (parts.length ? ` (${parts.join(', ')})` : '');
}

function styleName(key) {
  const variant = VARIANTS.find(v => v.key === key);
  const pick = variantState[key] || 0;
  if (!variant || pick === 0) return '';
  const name = variant.options[pick].name.toLowerCase();
  return /logo/i.test(variant.label) ? `${name} ${variant.label.toLowerCase()}` : name;
}

function glasses() {
  const pick = variantState.glasses_style || 0;
  if (pick === 3) return [colors.eyepatch ? `eyepatch (${colors.eyepatch})` : 'eyepatch'];
  if (pick !== 1 && pick !== 2) return [];
  const tints = ['glasses_frame', 'glasses_lens'].filter(key => colors[key]).map(colorName);
  const name = `${pick === 1 ? 'classic' : 'heart'} glasses`;
  return [name + (tints.length ? ` (${tints.join(', ')})` : '')];
}

function pairShoes(parts) {
  const left = parts.find(p => p.startsWith('left shoe'));
  const right = parts.find(p => p.startsWith('right shoe'));
  if (!left || !right || left.slice(9) !== right.slice(10)) return parts;
  return parts.filter(p => p !== right).map(p => (p === left ? `shoes${left.slice(9)}` : p));
}

function itemOwned(key) {
  return key.startsWith('glasses_') || key === 'eyepatch'
    || Object.values(ITEM_COLOR_GROUPS).some(keys => keys.includes(key));
}

export function wearLook(name) {
  const want = String(name || '').toLowerCase().trim();
  if (!want) return false;
  const hit = Presets.cache.find(p => p.name.toLowerCase() === want)
    || Presets.cache.find(p => p.name.toLowerCase().includes(want));
  if (!hit) return false;
  applyPreset(hit.data);
  return true;
}

// change_outfit already resolved conflicts on the server. still
// use queueWardrobe: it re-authorizes textures and PUTs the same
// state back, keeping both sides in sync.
export function applyToolChange(change) {
  if (!change || typeof change !== 'object') return;
  if (typeof change.look === 'string' && change.look) return wearLook(change.look);
  const items = change.items && typeof change.items === 'object' ? change.items : {};
  const keys = Object.keys(items).filter(key => ITEMS.some(it => it.key === key));
  if (keys.length) {
    queueWardrobe((draft) => {
      for (const key of keys) setDraftItem(draft, key, !!items[key]);
    });
  }
  const mods = change.mods && typeof change.mods === 'object' ? change.mods : {};
  for (const [name, on] of Object.entries(mods)) Mods.wearByName(name, !!on);
}

export function applyToolRecolor(change) {
  if (!change || typeof change !== 'object') return;
  for (const [key, hex] of Object.entries(change)) {
    const group = COLOR_GROUPS.find(g => g.key === key);
    if (group) setColor(key, hex ?? group.defaultColor ?? null);
  }
}

export function snapshot() {
  const out = {};
  for (const it of ITEMS) out[it.key] = state[it.key];
  return out;
}

export function syncFromAction(name, kwargs, resolvedByMap = false) {
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

  if (!keys.length) {
    if (!resolvedByMap) Mods.wearByName(kwargs.item, stateOn);
    return;
  }

  return queueWardrobe((items) => {
    for (const key of keys) setDraftItem(items, key, stateOn);
  });
}
