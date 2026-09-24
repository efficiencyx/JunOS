import { affection, buildCard, configureTts, fetchGauges, openMood, present, refreshGauges, speakLine, trust, tension } from '../core/speech-card.js?v=3';
import { gaugeTier } from '../core/mood-tier.js?v=2';
import { hooks } from '../outfit/hooks.js?v=1';
import { OPEN_LINES } from './open-lines.js?v=1';
import { REACTION_LINES } from './reaction-lines.js?v=1';
import { RETURN_LINES } from './return-lines.js?v=1';

const BASE_REACT_CHANCE = 0.35;
let reactChance = BASE_REACT_CHANCE;
let active = false;
const lastLine = {};

export async function activate() {
  active = true;
  hooks.react = react;
  buildCard();
  await fetchGauges();
}

export async function playIntro() {
  buildCard();
  await refreshGauges();
  await Promise.race([playOpening(OPEN_LINES, 'open'), new Promise(r => setTimeout(r, 12000))]);
}

export async function playOutro() {
  buildCard();
  await refreshGauges();
  await Promise.race([
    playOpening(RETURN_LINES, 'return'),
    new Promise(r => setTimeout(r, 12000)),
  ]);
}

function sample(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function decorate(text, mood) {
  const r = Math.random();
  if (mood === 'cold') return r < 0.35 ? `${text} </3` : text;
  const soft = text.replace(/([^.!?~])[.]$/, '$1~');
  if (mood === 'shy') return r < 0.5 ? soft : text;
  if (r < 0.35) return `${text} <3`;
  if (r < 0.65) return soft;
  return text;
}

function pick(event, mood, item) {
  const pool = REACTION_LINES[event][mood];
  const id = `${event}:${mood}`;
  let line;
  for (let tries = 0; tries < 4; tries++) {
    line = sample(pool);
    if (line !== lastLine[id]) break;
  }
  lastLine[id] = line;
  return line.replace(/\{item\}/g, item.toLowerCase());
}

function pickMood() {
  if (affection < 30) return 'cold';
  if (affection >= 85 && Math.random() < 0.20 + 0.03 * (affection - 85)) return 'tease';
  if (affection >= 65 && Math.random() < 0.5) return 'warm';
  return 'shy';
}

function playOpening(pools, idPrefix) {
  const key = `${gaugeTier(affection)}${gaugeTier(trust)}${gaugeTier(tension)}`;
  const pool = pools[key];
  if (!pool || !pool.length) return Promise.resolve();
  const id = `${idPrefix}:${key}`;
  let line;
  for (let tries = 0; tries < 4; tries++) {
    line = sample(pool);
    if (line !== lastLine[id]) break;
  }
  lastLine[id] = line;
  return present(line, openMood());
}

function react({ key, label, on, state }) {
  if (!active || !document.body.classList.contains('wardrobe-open') || !configureTts()) return;
  if (Math.random() >= reactChance) {
    reactChance = Math.min(1, reactChance + 0.05);
    return;
  }
  reactChance = BASE_REACT_CHANCE;
  const isHair = key.indexOf('hair_') === 0;
  const clothes = Object.keys(state).filter(k => !k.startsWith('hair_') && !['cat_ears', 'pointy_ears', 'tail', 'hair_hologram'].includes(k));
  const nude = clothes.length > 0 && clothes.every(k => !state[k]);
  const event = nude ? 'nude'
    : key === 'bra' || key === 'panties' ? 'underwear'
    : isHair ? 'hair'
    : on ? 'wear'
    : 'remove';
  const mood = pickMood();
  const text = pick(event, mood, label);
  speakLine(text, decorate(text, mood), mood);
}
