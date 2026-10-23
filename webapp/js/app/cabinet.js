// never writes a note, the server only scores it (consolidate.php?action=game)

import * as Feed from './consolidation-feed.js?v=2';
import * as Live2D from '../live2d/live2d.js?v=84';
import * as VoiceMode from '../voice/voicemode.js?v=83';
import * as Achievements from '../achievements/achievements.js?v=8';
import { showFaceBubble } from './face-bubble.js?v=84';
import { escapeHtml } from '../core/util.js?v=1';

const DRAWERS = [
  ['likes', 'preferences'],
  ['work', 'work'],
  ['health', 'health'],
  ['family', 'family'],
  ['plans', 'plans'],
  ['limits', 'boundaries'],
  ['happened', 'events'],
];
const DRAWER_OF = Object.fromEntries(DRAWERS.map(([drawer, category]) => [category, drawer]));
const HAND_SIZE = 3;
const JUNK_EVERY = 4;
const RULES_KEY = 'cabinet.rules_seen';
const CLOSE_AFTER_DONE_MS = 6000;

const JUNK = [
  'We talked about the weather.',
  'Jun said she likes strawberries.',
  'Anon said hi.',
  'The conversation went well.',
  'Anon asked how I was.',
  'We chatted for a while.',
  'Anon said good night.',
  'The user sent a message.',
  'Anon typed "lol".',
  'Jun was in a good mood.',
  'Anon said he would be right back.',
  'We said goodbye.',
];

let overlay = null, handEl, drawersEl, tallyEl, rulesEl;
let active = false;
let opener = null;
let onStop = null;
let choosing = false;
let done = false;
let settled = false;
let hand = [];
let picked = null;
let queue = [];
let pool = [];
let plays = [];
let dealt = 0;
let agreed = 0, total = 0, streak = 0;
let progress = null;
let unsubscribe = null;
let seq = 0;

const say = (text) => showFaceBubble(escapeHtml(text), 'ephemeral');

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function inPlay(id) {
  return hand.some(c => c.id === id) || queue.some(c => c.id === id);
}

function nextCard() {
  if (queue.length) return queue.shift();
  dealt++;
  if (dealt % JUNK_EVERY === 0 || !pool.length) return { junk: true, text: JUNK[Math.floor(Math.random() * JUNK.length)] };
  return pool.shift();
}

function deal() {
  if (choosing || done) return;
  while (hand.length < HAND_SIZE) hand.push({ key: ++seq, ...nextCard() });
  render();
}

function tallyText() {
  const parts = [`streak ${streak}`, `agreed with her ${agreed}/${total}`];
  if (progress?.step === 1) parts.push(`chat ${progress.i} of ${progress.n}`);
  else if (progress?.step === 2) parts.push(`old notes ${progress.i} of ${progress.n}`);
  else if (progress?.step === 3) parts.push('journal');
  return parts.join(' · ');
}

function render() {
  tallyEl.textContent = tallyText();
  handEl.replaceChildren(...hand.map((card) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'cabinet-card' + (card.choice ? ' cabinet-card--choice' : '');
    el.textContent = card.text;
    el.setAttribute('aria-pressed', String(picked === card.key));
    el.addEventListener('click', () => { picked = picked === card.key ? null : card.key; render(); });
    return el;
  }));
  for (const btn of drawersEl.querySelectorAll('button')) {
    btn.disabled = !picked || (choosing && btn.dataset.drawer !== 'shred');
  }
}

function file(drawer) {
  const card = hand.find(c => c.key === picked);
  if (!card) return;
  picked = null;
  hand = hand.filter(c => c !== card);

  if (card.choice) {
    choosing = false;
    hand = [];
    if (card.choice === 'keep') { stop(); return; }
    deal();
    return;
  }
  if (card.junk) {
    plays.push({ junk: true, drawer });
    if (drawer !== 'shred') say("That's junk and you know it.");
  } else {
    plays.push({ id: card.id, drawer });
    total++;
    if (drawer === 'shred') {
      streak = 0;
      say("Hey. I'm keeping that one.");
    } else if (DRAWER_OF[card.category] === drawer) {
      agreed++;
      streak++;
    } else {
      streak = 0;
      say(`I put that under ${DRAWER_OF[card.category]}.`);
    }
  }
  deal();
}

function onFeed(ev) {
  if (ev.type === 'step') {
    progress = ev;
  } else if ((ev.type === 'note' || ev.type === 'check') && ev.id && DRAWER_OF[ev.category] && !inPlay(ev.id)) {
    if (ev.action === 'deleted' || ev.action === 'dropped') return;
    pool = pool.filter(c => c.id !== ev.id);
    queue.push({ id: ev.id, category: ev.category, text: ev.text });
  } else if (ev.type === 'stall') {
    say('Lost my train of thought. One sec.');
  } else if (ev.type === 'done') {
    finish(ev.status);
    return;
  }
  if (active && !choosing && !done) deal();
  else if (active) render();
}

async function settle(waited) {
  if (settled) return null;
  settled = true;
  if (!plays.length && !waited) return null;
  try {
    const response = await fetch('api/consolidate.php?action=game', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plays, waited, tz: -new Date().getTimezoneOffset() }),
    });
    Achievements.check();
    return response.ok ? await response.json() : null;
  } catch (e) {
    return null;
  }
}

async function finish(status) {
  if (done) return;
  done = true;
  hand = [];
  picked = null;
  render();
  if (status !== 'ok') { teardown(); return; }
  const score = await settle(true);
  if (score && score.total > 0) say(`Done. You put ${score.agreed} of ${score.total} where I would have.`);
  setTimeout(teardown, CLOSE_AFTER_DONE_MS);
}

// leaving the game is going back to the chat, so she stops
function stop() {
  if (!active) return;
  if (!done && onStop) onStop();
  settle(false);
  teardown();
}

function teardown() {
  if (!active) return;
  active = false;
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  document.body.classList.remove('cabinet-mode');
  for (const el of chrome()) el.removeAttribute('inert');
  if (opener && opener.isConnected) opener.focus();
  opener = null;
  setTimeout(() => { if (!active) overlay.hidden = true; }, 300);
  if (!VoiceMode.isActive()) Live2D.setCameraPreset('default');
}

function showRules(then) {
  rulesEl.hidden = false;
  const fine = rulesEl.querySelector('button');
  fine.onclick = () => {
    rulesEl.hidden = true;
    try { localStorage.setItem(RULES_KEY, '1'); } catch (e) {}
    then();
  };
  fine.focus();
}

function rulesSeen() {
  try { return localStorage.getItem(RULES_KEY) === '1'; } catch (e) { return true; }
}

function build() {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.className = 'cabinet-overlay';
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Filing cabinet');
  overlay.innerHTML = `
    <button class="voice-overlay-btn cabinet-close" type="button" aria-label="Back to the chat" title="Back to the chat">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
    <div class="cabinet-tally" aria-live="polite"></div>
    <div class="cabinet-desk">
      <div class="cabinet-rules" hidden>
        <p>I'm sorting what I know about you. You can help.</p>
        <p>Tap a card, then the drawer it goes in. Junk goes in the shredder.</p>
        <p>I'll tell you if I'd have put it somewhere else.</p>
        <button type="button">Fine</button>
      </div>
      <div class="cabinet-hand"></div>
      <div class="cabinet-drawers">
        ${DRAWERS.map(([drawer]) => `<button type="button" class="cabinet-drawer" data-drawer="${drawer}">${drawer}</button>`).join('')}
        <button type="button" class="cabinet-drawer cabinet-shredder" data-drawer="shred">shredder</button>
      </div>
    </div>`;
  document.body.append(overlay);
  handEl = overlay.querySelector('.cabinet-hand');
  drawersEl = overlay.querySelector('.cabinet-drawers');
  tallyEl = overlay.querySelector('.cabinet-tally');
  rulesEl = overlay.querySelector('.cabinet-rules');
  drawersEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-drawer]');
    if (btn && !btn.disabled) file(btn.dataset.drawer);
  });
  overlay.querySelector('.cabinet-close').addEventListener('click', stop);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && active) stop(); });
}

const chrome = () => document.querySelectorAll('.chat-panel, .conv-sidebar, .app-header');

async function loadPool() {
  try {
    const response = await fetch('api/memory.php', { credentials: 'same-origin' });
    if (!response.ok) return;
    const data = await response.json();
    pool = shuffle((data.notes || [])
      .filter(n => DRAWER_OF[n.category] && !inPlay(n.id))
      .map(n => ({ id: n.id, category: n.category, text: n.text })));
  } catch (e) {}
}

export async function open({ ask = false, onStop: stopHandler = null } = {}) {
  build();
  if (active) return;
  active = true;
  opener = document.activeElement;
  onStop = stopHandler;
  choosing = false;
  done = settled = false;
  hand = []; queue = []; pool = []; plays = [];
  picked = null;
  dealt = agreed = total = streak = 0;
  progress = null;
  for (const el of chrome()) el.setAttribute('inert', '');
  overlay.hidden = false;
  void overlay.offsetHeight;
  document.body.classList.add('cabinet-mode');
  Live2D.setCameraPreset('face');
  render();
  unsubscribe = Feed.subscribe(onFeed);
  await loadPool();
  if (!active) return;

  const begin = () => {
    if (!active) return;
    if (ask) {
      choosing = true;
      hand = [{ key: ++seq, choice: 'keep', text: 'Keep playing' }, { key: ++seq, choice: 'stop', text: 'Stop' }];
      say("Almost done. Shred the one you don't want.");
      render();
    } else {
      deal();
    }
    overlay.querySelector('.cabinet-card')?.focus();
  };
  if (rulesSeen()) begin();
  else showRules(begin);
}

export function isActive() { return active; }
