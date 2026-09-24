import * as Live2D from '../live2d/live2d.js?v=4';
import { apiGet } from './api.js?v=1';
import { gaugeTier } from './mood-tier.js?v=2';
import * as Names from './names.js?v=1';
import * as MobileViewport from './viewport.js?v=1';
import * as TTS from '../voice/tts.js?v=2';

export let affection = 0;
export let trust = 0;
export let tension = 0;
let card = null;
let textEl = null;
let hideTimer = null;
let currentToken = 0;
let cardRaf = 0;
let lastCardWidth = null;

function positionCard() {
  cardRaf = requestAnimationFrame(positionCard);
  const a = Live2D.faceAnchor();
  if (!a || !card) return;
  const stage = document.getElementById('stage');
  if (!stage) return;
  const stageRect = stage.getBoundingClientRect();
  const viewport = MobileViewport.getVisualRect();
  const minLeft = Math.max(stageRect.left, viewport.left) + 8;
  const maxRight = Math.min(stageRect.right, viewport.right) - 8;
  const minTop = Math.max(stageRect.top, viewport.top) + 8;
  const maxBottom = Math.min(stageRect.bottom, viewport.bottom) - 8;
  const cardW = Math.max(150, Math.min(Math.min(330, maxRight - minLeft), a.modelW * 0.6));
  if (cardW !== lastCardWidth) {
    lastCardWidth = cardW;
    card.style.setProperty('--wr-w', cardW + 'px');
    card.style.setProperty('--wr-scale', String(cardW / 330));
  }
  const w = card.offsetWidth, h = card.offsetHeight;
  let left = a.x - a.headW * 0.5 - w;
  if (left < minLeft) left = Math.min(a.x + a.headW * 0.5, maxRight - w);
  left = Math.max(minLeft, Math.min(left, maxRight - w));
  const top = Math.max(minTop, Math.min(a.y + a.modelH * 0.18, maxBottom - h));
  card.style.left = left - stageRect.left + 'px';
  card.style.top = top - stageRect.top + 'px';
}

function showCard() {
  if (!card) return;
  card.classList.add('show');
  if (!cardRaf) positionCard();
}

export function configureTts() {
  TTS.setEnabled(localStorage.getItem('tts.enabled') === '1');
  TTS.setEngine(localStorage.getItem('tts.engine') || 'kokoro');
  TTS.setVoice(localStorage.getItem('tts.voice') || 'af_heart');
  TTS.setSpeed(parseFloat(localStorage.getItem('tts.speed') || '1') || 1);
  return TTS.isEnabled();
}

export function buildCard() {
  if (card) return;
  const stage = document.getElementById('stage');
  if (!stage) return;
  const style = document.createElement('style');
  style.textContent = `.wardrobe-reaction { position:absolute; z-index:4; width:var(--wr-w, 330px); max-width:100%; color:#fff; pointer-events:none; opacity:0; transition:opacity .32s ease; font-family:Arial,Helvetica,sans-serif; } .wardrobe-reaction.show { opacity:1; } .wardrobe-reaction-text span { opacity:0; animation:wr-letter .28s ease-out forwards; } @keyframes wr-letter { from { opacity:0; } to { opacity:1; } } .wardrobe-reaction-name { display:table; padding:calc(7px * var(--wr-scale, 1)) calc(16px * var(--wr-scale, 1)) calc(7px * var(--wr-scale, 1)) calc(11px * var(--wr-scale, 1)); background:#15142e; border-left:calc(5px * var(--wr-scale, 1)) solid #ec0054; color:#fff; font-size:calc(15px * var(--wr-scale, 1)); font-weight:800; line-height:1; clip-path:polygon(0 0, 100% 0, 100% calc(100% - 9px * var(--wr-scale, 1)), calc(100% - 9px * var(--wr-scale, 1)) 100%, 0 100%); } .wardrobe-reaction-text { position:relative; margin-top:calc(10px * var(--wr-scale, 1)); padding:calc(6px * var(--wr-scale, 1)) calc(18px * var(--wr-scale, 1)) calc(7px * var(--wr-scale, 1)); background:#191233; font-size:calc(17px * var(--wr-scale, 1)); font-weight:700; line-height:1.25; clip-path:polygon(0 0, 100% 0, 100% calc(100% - 12px * var(--wr-scale, 1)), calc(100% - 12px * var(--wr-scale, 1)) 100%, 0 100%); }`;
  document.head.appendChild(style);
  card = document.createElement('div');
  card.className = 'wardrobe-reaction';
  const nameEl = document.createElement('div');
  nameEl.className = 'wardrobe-reaction-name';
  nameEl.textContent = Names.getBot() || 'JUN';
  textEl = document.createElement('div');
  textEl.className = 'wardrobe-reaction-text';
  card.append(nameEl, textEl);
  stage.appendChild(card);
}

export async function fetchGauges() {
  const state = await apiGet('relationship.php');
  if (state && typeof state.affection === 'number') {
    affection = state.affection;
    trust = Number(state.trust) || 0;
    tension = Number(state.tension) || 0;
  }
}

export const refreshGauges = () => Promise.race([fetchGauges(), new Promise(r => setTimeout(r, 700))]);

// a line somebody else wrote (the date page gets hers from the
// model), through the same card, face and TTS as the canned ones
export async function say(line) {
  buildCard();
  await refreshGauges();
  await Promise.race([
    present(line, openMood()),
    new Promise(r => setTimeout(r, 30000)),
  ]);
}

function applyExpression(kind) {
  if (kind === 'cold') {
    Live2D.setTarget('ParamBlush', 0);
    Live2D.setTarget('ParamMouthForm', -0.8);
    Live2D.setTarget('ParamBrowLEmote', -0.9);
    Live2D.setTarget('ParamBrowREmote', -0.9);
  } else if (kind === 'shy') {
    Live2D.setTarget('ParamBlush', 1);
    Live2D.setTarget('ParamMouthForm', -0.3);
    Live2D.setTarget('ParamBrowLEmote', -0.4);
    Live2D.setTarget('ParamBrowREmote', -0.4);
  } else if (kind === 'tease') {
    Live2D.setTarget('ParamBlush', 0.45);
    Live2D.setTarget('ParamMouthForm', 0.7);
    Live2D.setTarget('ParamEyesHappy', 1);
  } else if (kind === 'warm') {
    Live2D.setTarget('ParamBlush', 0.5);
    Live2D.setTarget('ParamMouthForm', 1);
    Live2D.setTarget('ParamEyesHappy', 1);
    Live2D.setTarget('ParamHeart', 0.55);
  } else {
    Live2D.setTarget('ParamBlush', kind === 'hair' ? 0.35 : 0.2);
    Live2D.setTarget('ParamMouthForm', 0.8);
    Live2D.setTarget('ParamEyesHappy', 1);
  }
}

function setLetters(el, text) {
  el.textContent = '';
  const frag = document.createDocumentFragment();
  let i = 0;
  for (const ch of text) {
    const span = document.createElement('span');
    span.textContent = ch;
    span.style.animationDelay = `${i * 26}ms`;
    frag.appendChild(span);
    i++;
  }
  el.appendChild(frag);
}

export function hide() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  if (card) card.classList.remove('show');
  if (cardRaf) { cancelAnimationFrame(cardRaf); cardRaf = 0; }
  Live2D.resetIdle();
}

export function openMood() {
  const a = gaugeTier(affection), t = gaugeTier(trust), x = gaugeTier(tension);
  if (a === 0) return 'cold';
  if (x === 2) return 'shy';
  if (a === 2) return t === 2 && Math.random() < 0.4 ? 'tease' : 'warm';
  return 'shy';
}

function openGesture(mood) {
  const seq = {
    cold: [
      { dt_ms: 0, params: { ParamAngleX: -16, ParamAngleZ: 6, ParamBodyAngleX: -5 } },
      { dt_ms: 900, params: { ParamAngleX: -6, ParamAngleY: -4 } },
      { dt_ms: 1200, params: { ParamAngleX: 0, ParamAngleY: 0, ParamAngleZ: 0, ParamBodyAngleX: 0 } },
    ],
    shy: [
      { dt_ms: 0, params: { ParamAngleY: -10, ParamAngleZ: -7, ParamBodyAngleX: 3 } },
      { dt_ms: 900, params: { ParamAngleY: -4, ParamAngleX: 6 } },
      { dt_ms: 1200, params: { ParamAngleX: 0, ParamAngleY: 0, ParamAngleZ: 0, ParamBodyAngleX: 0 } },
    ],
    warm: [
      { dt_ms: 0, params: { ParamAngleX: 8, ParamAngleY: 5, ParamAngleZ: -5, ParamBodyAngleX: 6 } },
      { dt_ms: 900, params: { ParamAngleZ: 4 } },
      { dt_ms: 1200, params: { ParamAngleX: 0, ParamAngleY: 0, ParamAngleZ: 0, ParamBodyAngleX: 0 } },
    ],
    tease: [
      { dt_ms: 0, params: { ParamAngleX: 12, ParamAngleZ: 9, ParamBodyAngleX: 5 } },
      { dt_ms: 900, params: { ParamAngleX: 4, ParamAngleZ: -4 } },
      { dt_ms: 1200, params: { ParamAngleX: 0, ParamAngleZ: 0, ParamBodyAngleX: 0 } },
    ],
  }[mood];
  if (seq) Live2D.scheduleSequence(seq);
}

export function present(line, mood) {
  const token = ++currentToken;
  hide();
  buildCard();
  applyExpression(mood);
  openGesture(mood);
  if (card && textEl) {
    setLetters(textEl, line);
    showCard();
  }
  return new Promise((resolve) => {
    const finish = () => { hide(); resolve(); };
    const after = (ms) => {
      if (token === currentToken) hideTimer = setTimeout(finish, ms);
      else resolve();
    };
    const linger = () => after(1800 + 40 * line.length);
    if (configureTts()) {
      TTS.speak(line, {
        onDone() { after(450); },
        onError: linger,
      });
    } else {
      linger();
    }
  });
}

// the card waits for TTS to actually start. `display` is `text`
// plus the decoration (</3, <3, a ~) that TTS must not read out
export function speakLine(text, display, mood) {
  const token = ++currentToken;
  hide();
  TTS.speak(text, {
    onStart() {
      if (token !== currentToken) return;
      buildCard();
      if (!card || !textEl) return;
      setLetters(textEl, display);
      applyExpression(mood);
      showCard();
    },
    onDone() {
      if (token !== currentToken) return;
      hideTimer = setTimeout(hide, 450);
    },
    onError() {
      if (token === currentToken) hide();
    },
  });
}
