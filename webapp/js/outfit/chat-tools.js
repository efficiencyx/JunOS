import { ITEMS, VARIANTS } from './catalog.js?v=1';
import { Presets, applyPreset } from './presets.js?v=3';
import { queueWardrobe } from './sync.js?v=3';
import { setDraftItem } from './apply.js?v=3';
import { state, variantState } from './current.js?v=1';
import * as Mods from '../mods/mods.js?v=3';

export function describe() {
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
  s += Mods.describe();
  const looks = Presets.cache.map(p => p.name);
  if (looks.length) {
    s += ` Saved looks you can put on whole, by name, with [A:wear_look|name=NAME]:`
      + ` ${looks.join(', ')}.`;
  }
  return s;
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
