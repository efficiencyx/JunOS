// every play lands on the server as it's made (consolidate.php?action=play)

import * as Feed from './consolidation-feed.js?v=4';
import * as Live2D from '../live2d/live2d.js?v=93';
import * as VoiceMode from '../voice/voicemode.js?v=103';
import * as Achievements from '../achievements/achievements.js?v=10';
import { showFaceBubble } from './face-bubble.js?v=102';
import { escapeHtml } from '../core/util.js?v=1';
import { apiGet, apiJson } from '../core/api.js?v=1';
import { t } from '../core/i18n.js?v=2';

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
const JUNK_EVERY = 5;
const RULES_KEY = 'cabinet.rules_seen';
const CLOSE_AFTER_DONE_MS = 6000;

// english like her real notes, which are stored english. a translated
// decoy would be the one card in his language, junk at a glance
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
let junkLeft = [];
let sinceJunk = 0;
let passDone = false;
let waited = false;
let played = 0;
let seen = new Set();
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

const cardKey = (c) => c.ref || c.id;

function enqueue(card) {
  const key = cardKey(card);
  if (!key || seen.has(key)) return;
  seen.add(key);
  queue.push(card);
}

// junk at most one card in five, and none once the real ones run out
function nextCard() {
  if (++sinceJunk >= JUNK_EVERY && junkLeft.length && (queue.length || !passDone)) {
    sinceJunk = 0;
    return { kind: 'junk', text: junkLeft.pop() };
  }
  return queue.shift() || null;
}

function deal() {
  if (choosing || done) return;
  while (hand.length < HAND_SIZE) {
    const card = nextCard();
    if (!card) break;
    hand.push({ key: ++seq, ...card });
  }
  if (!hand.length && passDone) { end(); return; }
  render();
}

function tallyText() {
  const parts = [t('cabinet.streak', 'streak {n}', { n: streak }), t('cabinet.agreed', 'agreed with her {a}/{b}', { a: agreed, b: total })];
  if (passDone) parts.push(t('cabinet.left', '{n} left', { n: queue.length + hand.length }));
  else if (progress?.step === 1) parts.push(t('cabinet.chat', 'chat {i} of {n}', progress));
  else if (progress?.step === 2) parts.push(t('cabinet.oldNotes', 'old notes {i} of {n}', progress));
  else if (progress?.step === 3) parts.push(t('cabinet.journal', 'journal'));
  return parts.join(' · ');
}

function render() {
  tallyEl.textContent = tallyText();
  handEl.replaceChildren(...hand.map((card) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'cabinet-card' + (card.choice ? ' cabinet-card--choice' : '');
    const text = document.createElement('span');
    text.textContent = card.text;
    if (!card.choice) text.lang = 'en';
    el.append(text);
    if (card.kind === 'changed' && card.was) {
      const was = document.createElement('span');
      was.className = 'cabinet-was';
      was.textContent = t('cabinet.before', 'before:') + ' ';
      const old = document.createElement('span');
      old.lang = 'en';
      old.textContent = card.was;
      was.append(old);
      el.append(was);
    }
    el.setAttribute('aria-pressed', String(picked === card.key));
    el.addEventListener('click', () => { picked = picked === card.key ? null : card.key; render(); });
    return el;
  }));
  for (const btn of drawersEl.querySelectorAll('button')) {
    btn.disabled = !picked || (choosing && btn.dataset.drawer !== 'shred');
  }
}

function reactionLine(reaction, drawer) {
  switch (reaction) {
    case 'junk': return t('jun.cabinet.junk', "That's junk and you know it.");
    case 'moved': return t('jun.cabinet.moved', 'Fine. {drawer} then.', { drawer: drawerLabels()[drawer] });
    case 'limit': return t('jun.cabinet.limit', "No. That's a limit, it stays where it is.");
    case 'health': return t('jun.cabinet.health', 'Not that one. I need to remember it.');
    case 'doubted': return t('jun.cabinet.doubted', "I'll check that one again.");
    case 'rescued': return t('jun.cabinet.rescued', "Okay. I'll keep it after all.");
    case 'never_said': return t('jun.cabinet.neverSaid', 'You never said that. It stays out.');
    case 'undone': return t('jun.cabinet.undone', 'Fine. Back the way it was.');
    default: return '';
  }
}

async function file(drawer) {
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
  deal();
  played++;
  const body = card.kind === 'junk' ? { kind: 'junk', drawer }
    : card.kind === 'note' ? { kind: 'note', id: card.id, drawer }
      : { kind: card.kind, ref: card.ref, drawer };
  const r = await apiJson('consolidate.php?action=play', body).catch(() => null);
  if (!r || !r.ok) return;
  const out = await r.json().catch(() => null);
  if (!out) return;
  if (card.kind !== 'junk') {
    total++;
    if (out.agreed) { agreed++; streak++; } else streak = 0;
  }
  const line = reactionLine(out.reaction, drawer);
  if (line) say(line);
  if (active) render();
}

function cardFrom(ev) {
  if (ev.type === 'check' && DRAWER_OF[ev.category]) return { kind: 'note', id: ev.id, category: ev.category, text: ev.text };
  if (ev.type !== 'note' || ev.dry) return null;
  if (ev.action === 'saved' && DRAWER_OF[ev.category]) return { kind: 'note', id: ev.id, category: ev.category, text: ev.text };
  if ((ev.action === 'updated' || ev.action === 'merged') && DRAWER_OF[ev.category]) {
    return { kind: 'changed', ref: ev.cursor, id: ev.id, category: ev.category, text: ev.text, was: ev.before || ev.was };
  }
  if (ev.action === 'dropped' && (ev.why === 'passing' || ev.why === 'not_said')) return { kind: 'dropped', ref: ev.cursor, text: ev.text };
  return null;
}

function onFeed(ev) {
  if (ev.type === 'step') {
    progress = ev;
  } else if (ev.type === 'stall') {
    say(t('jun.cabinet.stall', 'Lost my train of thought. One sec.'));
  } else if (ev.type === 'done') {
    passDone = true;
    waited = ev.status === 'ok';
  } else {
    const card = cardFrom(ev);
    if (card) enqueue(card);
  }
  if (active && !choosing && !done) deal();
  else if (active) render();
}

async function settle() {
  if (settled) return null;
  settled = true;
  if (!played && !waited) return null;
  try {
    const response = await apiJson('consolidate.php?action=game', { waited, tz: -new Date().getTimezoneOffset() });
    Achievements.check();
    return response.ok ? await response.json() : null;
  } catch (e) {
    return null;
  }
}

async function end() {
  if (done) return;
  done = true;
  hand = [];
  picked = null;
  render();
  const score = await settle();
  say(score && score.total > 0
    ? t('jun.cabinet.done', 'Done. You put {agreed} of {total} where I would have.', score)
    : t('jun.cabinet.everything', "That's everything."));
  setTimeout(teardown, CLOSE_AFTER_DONE_MS);
}

// leaving the game is going back to the chat, so she stops
function stop() {
  if (!active) return;
  if (!passDone && onStop) onStop();
  settle();
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

function drawerLabels() {
  return {
    likes: t('cabinet.drawer.likes', 'likes'),
    work: t('cabinet.drawer.work', 'work'),
    health: t('cabinet.drawer.health', 'health'),
    family: t('cabinet.drawer.family', 'family'),
    plans: t('cabinet.drawer.plans', 'plans'),
    limits: t('cabinet.drawer.limits', 'limits'),
    happened: t('cabinet.drawer.happened', 'happened'),
  };
}

function build() {
  if (overlay) return;
  const labels = drawerLabels();
  overlay = document.createElement('div');
  overlay.className = 'cabinet-overlay';
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t('cabinet.aria', 'Filing cabinet'));
  overlay.innerHTML = `
    <button class="voice-overlay-btn cabinet-close" type="button" aria-label="${t('cabinet.back', 'Back to the chat')}" title="${t('cabinet.back', 'Back to the chat')}">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
    <div class="cabinet-tally" aria-live="polite"></div>
    <div class="cabinet-desk">
      <div class="cabinet-rules" hidden>
        <p>${t('cabinet.rules1', "I'm sorting what I know about you. You can help.")}</p>
        <p>${t('cabinet.rules2', 'Tap a card, then the drawer it goes in. Junk and anything wrong go in the shredder.')}</p>
        <p>${t('cabinet.rules3', 'Where you put it is where it goes. Mostly.')}</p>
        <button type="button">${t('cabinet.fine', 'Fine')}</button>
      </div>
      <div class="cabinet-hand"></div>
      <div class="cabinet-drawers">
        ${DRAWERS.map(([drawer]) => `<button type="button" class="cabinet-drawer" data-drawer="${drawer}">${labels[drawer]}</button>`).join('')}
        <button type="button" class="cabinet-drawer cabinet-shredder" data-drawer="shred">${t('cabinet.shredder', 'shredder')}</button>
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

async function loadDeck() {
  const deck = await apiGet('consolidate.php?action=deck');
  if (!deck) return;
  for (const d of deck.dropped || []) enqueue({ kind: 'dropped', ref: d.ref, text: d.text });
  for (const c of deck.changed || []) enqueue({ kind: 'changed', ref: c.ref, id: c.id, category: c.category, text: c.text, was: c.was });
  for (const n of deck.notes || []) enqueue({ kind: 'note', id: n.id, category: n.category, text: n.text });
}

export async function open({ ask = false, onStop: stopHandler = null } = {}) {
  build();
  if (active) return;
  active = true;
  opener = document.activeElement;
  onStop = stopHandler;
  choosing = false;
  done = settled = passDone = waited = false;
  hand = []; queue = [];
  junkLeft = shuffle(JUNK.slice());
  seen = new Set();
  picked = null;
  sinceJunk = played = agreed = total = streak = 0;
  progress = null;
  for (const el of chrome()) el.setAttribute('inert', '');
  overlay.hidden = false;
  void overlay.offsetHeight;
  document.body.classList.add('cabinet-mode');
  Live2D.setCameraPreset('face');
  render();
  unsubscribe = Feed.subscribe(onFeed);
  await loadDeck();
  if (!active) return;

  const begin = () => {
    if (!active) return;
    if (ask) {
      choosing = true;
      hand = [{ key: ++seq, choice: 'keep', text: t('cabinet.keep', 'Keep playing') }, { key: ++seq, choice: 'stop', text: t('karaoke.stop', 'Stop') }];
      say(t('jun.cabinet.almost', "Almost done. Shred the one you don't want."));
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
