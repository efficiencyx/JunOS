import { COLOR_GROUPS, ITEMS, VARIANTS } from './catalog.js?v=1';

export const state = {};
for (const it of ITEMS) state[it.key] = it.defaultOn;

export const colors = {};
for (const g of COLOR_GROUPS) colors[g.key] = g.defaultColor || null;

export const variantState = {};
for (const v of VARIANTS) variantState[v.key] = 0;
