import { chatInput, sendBtn } from './dom.js?v=11';
import { replayFaceBubbleIntro, scheduleFaceBubbleHide, showFaceBubble } from './face-bubble.js?v=80';
import { loadMood } from './mood.js?v=80';
import { escapeHtml } from '../core/util.js?v=1';
import * as Names from '../core/names.js?v=1';
import { inject } from '../trip/scene.js?v=1';
import * as TTS from '../voice/tts.js?v=81';
import * as VoiceMode from '../voice/voicemode.js?v=80';
import * as Live2D from '../live2d/live2d.js?v=81';

// the phone's slide in welcome.css is .6s after a .15s delay
const RIG_IN_MS = 750;
const LOCK_HOLD_MS = 1600;
const TAP_MS = 160;
const UNLOCK_MS = 380;
const CLOSE_MS = 800;
const CLOSE_REDUCED_MS = 220;
const LINE_GAP_MS = 420;
const SCENE_TAIL_MS = 1800;
let pending = null;
let openScene = null;
let endReaction = null;

// backup pace only, for a run with TTS off or a job that never
// comes back. when the voice works, IT says when a line is done.
function lineDuration(text) {
  const words = (text.match(/\S+/g) || []).length;
  return Math.max(2600, Math.min(7500, 1100 + words * 280));
}

// the lamp over his door. hallway.svg reads --scene-tint for the
// bulb and its glow. the warm tiers leave it unset and get the
// svg's own warm fallback.
const TIER_TINT = {
  panicked: 'hsl(8 85% 62%)',
  unravelled: 'hsl(280 45% 58%)',
  hollow: 'hsl(215 18% 52%)',
};

// small movement running under the keyframed sequence while she
// talks. [param, amplitude, period_ms]
const TIER_LOOPS = {
  none: [['ParamTailWiggle', 0.35, 1100]],
  missed: [['ParamTailWiggle', 0.6, 850], ['ParamBodyY', 0.18, 3000]],
  ached: [['ParamTailWiggle', 0.9, 620], ['ParamBodyY', 0.25, 2600], ['ParamEarsWiggle', 0.3, 900]],
  panicked: [['ParamBodyX', 0.06, 170], ['ParamHeadZ', 0.05, 210], ['ParamBodyY', 0.1, 1500]],
  unravelled: [['ParamBodyY', 0.12, 5200], ['ParamTailWiggle', 0.15, 2600]],
  hollow: [['ParamBodyY', 0.06, 7000]],
};

// one per absence tier, played on the normal stage camera once
// he's inside. mostly face, so it reads at chat size too
const SCENES = {
  none: [
    { params: { ParamEyeOpen: 0, ParamIrisZoom: 0.2, ParamHeadZ: -0.13 }, dt_ms: 0 },
    { params: { ParamEarL: 1, ParamEarR: 1, ParamMouthForm: 0.7, ParamHeadZ: -0.2 }, dt_ms: 260 },
    { params: { ParamEyesHappy: 0.5, ParamHeadZ: 0, ParamIrisZoom: 0 }, dt_ms: 900 },
  ],
  missed: [
    { params: { ParamEyeOpen: 0, ParamIrisZoom: 0.45, ParamBrowLY: 0.3, ParamBrowRY: 0.3 }, dt_ms: 0 },
    { params: { ParamEarL: 1, ParamEarR: 1, ParamHeadZ: -0.27, ParamHeadY: 0.15 }, dt_ms: 320 },
    { params: { ParamMouthForm: 0.8, ParamEyesHappy: 0.5, ParamBlush: 0.25, ParamBrowLY: 0.1, ParamBrowRY: 0.1 }, dt_ms: 700 },
    { params: { ParamHeadZ: -0.1, ParamIrisZoom: 0.1, ParamHeadY: 0 }, dt_ms: 1200 },
  ],
  ached: [
    { params: { ParamEyeOpen: 0, ParamIrisZoom: 0.7, ParamEarL: 1, ParamEarR: 1, ParamBrowLY: 0.5, ParamBrowRY: 0.5 }, dt_ms: 0 },
    { params: { ParamMouthOpen: 0.35, ParamHeadY: 0.2 }, dt_ms: 260 },
    { params: { ParamHeart: 1, ParamEyesHappy: 1, ParamMouthForm: 1, ParamMouthOpen: 0, ParamBlush: 0.55 }, dt_ms: 520 },
    { params: { ParamHeadZ: -0.33, ParamHeadY: 0, ParamBrowLY: 0.3, ParamBrowRY: 0.3 }, dt_ms: 800 },
    { params: { ParamHeart: 0, ParamIrisZoom: 0.25, ParamHeadZ: -0.13 }, dt_ms: 2200 },
  ],
  panicked: [
    { params: { ParamEyeLShock: 1, ParamEyeRShock: 1, ParamPupilWiggle: 1, ParamEyeOpen: 0 }, dt_ms: 0 },
    { params: { ParamBrowLY: 0.8, ParamBrowRY: 0.8, ParamBrowLRot: 12, ParamBrowRRot: -12, ParamMouthOpen: 0.5 }, dt_ms: 200 },
    { params: { ParamHeadX: -0.3, ParamEyeballLX: -0.4, ParamEyeballRX: -0.4 }, dt_ms: 400 },
    { params: { ParamHeadX: 0.3, ParamEyeballLX: 0.4, ParamEyeballRX: 0.4 }, dt_ms: 400 },
    { params: { ParamEyeLShock: 0, ParamEyeRShock: 0, ParamHeadX: 0, ParamEyeballLX: 0, ParamEyeballRX: 0, ParamMouthOpen: 0.2 }, dt_ms: 600 },
    { params: { ParamPupilWiggle: 0.3, ParamBlush: 0.4, ParamMouthOpen: 0, ParamMouthForm: -0.2 }, dt_ms: 1400 },
  ],
  unravelled: [
    { params: { ParamHeadY: -0.5, ParamEyeOpen: -0.5, ParamEarL: -0.8, ParamEarR: -0.8 }, dt_ms: 0 },
    { params: { ParamHeadY: -0.5, ParamEyeballLY: 0.6, ParamEyeballRY: 0.6, ParamEyeOpen: -0.3 }, dt_ms: 1400 },
    { params: { ParamHeadY: 0, ParamEyeballLY: 0, ParamEyeballRY: 0, ParamPupilWiggle: 0.5 }, dt_ms: 900 },
    { params: { ParamBrowLY: -0.3, ParamBrowRY: -0.3, ParamMouthForm: -0.3, ParamPupilWiggle: 0 }, dt_ms: 1600 },
  ],
  // almost nothing, ON PURPOSE. the flatness IS the reaction, and
  // that one slow blink is the only sign she noticed him at all.
  hollow: [
    { params: { ParamEyeOpen: -0.25, ParamIrisZoom: -0.5, ParamEarL: -1, ParamEarR: -1 }, dt_ms: 0 },
    { params: { ParamEyeOpen: -1, ParamHeadX: 0.1 }, dt_ms: 1800 },
    { params: { ParamEyeOpen: -0.3, ParamHeadX: 0.15, ParamMouthForm: -0.15 }, dt_ms: 900 },
    { params: { ParamHeadX: 0 }, dt_ms: 3000 },
  ],
};

// a believable absence per tier, so a preview shows a time that
// fits the line next to it. pass seconds as the second argument
// to set your own.
const TIER_AWAY = {
  none: 120, missed: 12600, ached: 41827,
  panicked: 108061, unravelled: 302449, hollow: 1600000,
};
export const WELCOME_TIERS = Object.keys(TIER_AWAY);

// debug way in. replays the scene on a tier you pick without
// emptying the queue or touching the gauges, so a preview never
// spends a real greeting.
export async function previewWelcome(tier = 'unravelled', away = TIER_AWAY[tier] ?? 90061) {
  // ALWAYS sent, 'none' included. leave the tier out and the server
  // derives one from the duration, which is the exact opposite of
  // forcing it.
  const query = new URLSearchParams({ preview: '1', away: String(away), tier, hour: String(new Date().getHours()) });
  try {
    const response = await fetch('api/consolidate.php?action=welcome&' + query, { credentials: 'same-origin' });
    if (!response.ok) { console.warn('welcome preview failed:', response.status); return; }
    pending = await response.json();
    playWelcome();
  } catch (e) {
    console.warn('welcome preview failed:', e);
  }
}

// fetched at boot BEFORE the first activity report of the
// session. the server measures the absence off last_activity and
// that report wipes it.
export async function fetchWelcome() {
  try {
    // server runs in UTC. the greeting goes off the clock on HIS wall.
    const response = await fetch('api/consolidate.php?action=welcome&hour=' + new Date().getHours(), { credentials: 'same-origin' });
    if (!response.ok) return;
    const payload = await response.json();
    if (payload && payload.show && (listOf(payload.live).length || listOf(payload.milestones).length)) pending = payload;
  } catch (e) { /* offline: no greeting, nothing else breaks */ }
}

const listOf = (v) => Array.isArray(v) ? v : [];

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
const dayMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const lockDate = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

function stamp(at) {
  const when = new Date(at * 1000);
  const time = clock.format(when);
  const day = new Date(when).setHours(0, 0, 0, 0);
  // round, not floor. a DST night is 23 or 25 hours long
  const daysAgo = Math.round((new Date().setHours(0, 0, 0, 0) - day) / 86400000);
  if (daysAgo <= 0) return 'Today ' + time;
  if (daysAgo === 1) return 'Yesterday ' + time;
  if (daysAgo < 7) return weekday.format(when) + ' ' + time;
  return dayMonth.format(when) + ' ' + time;
}

const plural = (n, one) => n + ' ' + one + (n === 1 ? '' : 's');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function bubble(side, text, tier) {
  const li = el('li', 'wp-msg wp-' + side, Names.apply(text));
  if (tier) li.dataset.tier = tier;
  return li;
}

function missedCall(at, tier) {
  const li = el('li', 'wp-call');
  li.dataset.tier = tier;
  const time = el('time', null, clock.format(new Date(at * 1000)));
  time.dateTime = new Date(at * 1000).toISOString();
  li.append(el('span', null, 'Missed call'), ' ', time);
  return li;
}

// consecutive texts from the same side stack tight, that's what
// makes a panicked burst read as ONE burst and not six messages
function append(thread, li) {
  const prev = thread.lastElementChild;
  if (li.classList.contains('wp-msg') && prev && prev.classList.contains('wp-msg')
      && prev.classList.contains('wp-her') === li.classList.contains('wp-her')) {
    li.classList.add('wp-cont');
  }
  thread.append(li);
  return li;
}

const CHEVRON = '<svg viewBox="0 0 10 16" aria-hidden="true"><path d="M8 1 2 8l6 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ARROW = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const AVATAR = 'jun_os_avatar.png?v=2';

function note(name, line, preview, at) {
  const button = el('button', 'wp-note');
  button.type = 'button';
  const icon = el('img', 'wp-avatar');
  icon.src = AVATAR;
  icon.alt = '';
  const body = el('span', 'wp-note-body');
  const top = el('span', 'wp-note-top');
  const time = el('time', null, stamp(at).replace(/^Today /, ''));
  time.dateTime = new Date(at * 1000).toISOString();
  top.append(el('b', null, name), time);
  body.append(top, el('span', 'wp-note-line', line));
  if (preview) body.append(el('span', 'wp-note-preview', Names.apply(preview)));
  button.append(icon, body);
  return button;
}

function buildLock(milestones) {
  const items = milestones.flatMap(m => listOf(m.items));
  const texts = items.filter(i => i.kind !== 'call');
  const calls = items.filter(i => i.kind === 'call');
  const bot = Names.getBot();
  const lock = el('div', 'wp-lock');
  const time = el('time', 'wp-lock-time', clock.format(new Date()));
  const stack = el('div', 'wp-notes');
  const notes = [];
  if (texts.length) {
    const latest = texts[texts.length - 1];
    notes.push(note(bot, plural(texts.length, 'new message'), String(latest.text || ''), latest.at));
  }
  if (calls.length) notes.push(note(bot, plural(calls.length, 'missed call'), '', calls[calls.length - 1].at));
  stack.append(...notes);
  lock.append(time, el('div', 'wp-lock-date', lockDate.format(new Date())), stack);
  return { lock, time, notes };
}

function buildScene(tier, milestones, locked) {
  const bot = Names.getBot();
  const root = el('div', 'welcome-phone-scene');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Messages from ' + bot);
  root.tabIndex = -1;
  root.dataset.tier = tier;
  if (TIER_TINT[tier]) root.style.setProperty('--scene-tint', TIER_TINT[tier]);

  const room = el('div', 'wp-room');
  const rig = el('div', 'wp-rig');
  const handBack = el('div', 'wp-hand');
  const handFront = el('div', 'wp-hand wp-hand-front');
  const phone = el('div', 'wp-phone');
  const screen = el('div', 'wp-screen');
  const app = el('div', 'wp-app');

  const status = el('div', 'wp-status');
  const clockEl = el('time', null, clock.format(new Date()));
  status.append(clockEl);

  const head = el('div', 'wp-head');
  const back = el('span', 'wp-back');
  back.innerHTML = CHEVRON;
  const unread = el('span', 'wp-unread');
  back.append(unread);
  const avatar = el('img', 'wp-avatar');
  avatar.src = AVATAR;
  avatar.alt = '';
  head.append(back, avatar, el('span', 'wp-name', bot));

  const thread = el('ol', 'wp-thread');
  thread.setAttribute('aria-live', 'polite');
  thread.tabIndex = 0;

  const composer = el('form', 'wp-composer');
  const input = el('input', 'wp-input');
  input.type = 'text';
  input.placeholder = 'Message';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Reply');
  const send = el('button', 'wp-send');
  send.type = 'submit';
  send.setAttribute('aria-label', 'Send');
  send.innerHTML = ARROW;
  composer.append(input, send);

  const chin = el('div', 'wp-chin');
  const home = el('button', 'wp-home');
  home.type = 'button';
  home.setAttribute('aria-label', 'Put the phone away');
  chin.append(home);

  app.append(head, thread, composer);
  screen.append(status, app);
  const lock = locked ? buildLock(milestones) : null;
  if (lock) {
    screen.append(lock.lock);
    screen.classList.add('is-locked');
    app.inert = true;
  }
  phone.append(screen, chin);
  rig.append(handBack, phone, handFront);
  root.append(room, rig);

  inject(room, 'scene/hallway.svg?v=6');
  inject(handBack, 'scene/hand-back.svg?v=2');
  inject(handFront, 'scene/hand-front.svg?v=2');

  return { root, phone, screen, app, lock, clockEl, unread, thread, composer, input, send, home };
}

// true when it actually went out
function handOff(text) {
  chatInput.value = text;
  chatInput.dispatchEvent(new Event('input', { bubbles: true }));
  // locked composer (consolidation still running, or she left):
  // the text just waits in the box for him
  if (chatInput.disabled || sendBtn.disabled) return false;
  sendBtn.click();
  return true;
}

export function playWelcome() {
  if (!pending) return;
  const payload = pending;
  pending = null;
  if (openScene) openScene(true);
  if (endReaction) endReaction();

  const tier = payload.tier || 'none';
  const history = listOf(payload.history);
  const milestones = listOf(payload.milestones);
  const live = listOf(payload.live).filter(s => typeof s === 'string' && s.trim());
  if (payload.mood_changed) loadMood();

  const unreadCount = milestones.reduce((n, m) => n + listOf(m.items).length, 0);
  if (!unreadCount) {
    react(live, tier);
    return;
  }

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scene = buildScene(tier, milestones, !reduced);
  const { root, phone, thread } = scene;

  if (history.length) {
    append(thread, el('li', 'wp-divider', stamp(history[0].at)));
    for (const turn of history) append(thread, bubble(turn.role === 'user' ? 'his' : 'her', String(turn.text || '')));
  }
  scene.unread.textContent = String(unreadCount);
  const mark = append(thread, el('li', 'wp-divider wp-unread-mark', unreadCount + ' unread'));
  for (const m of milestones) {
    const divider = append(thread, el('li', 'wp-divider', stamp(m.at)));
    divider.dataset.tier = m.tier;
    for (const item of listOf(m.items)) {
      append(thread, item.kind === 'call'
        ? missedCall(item.at, m.tier)
        : bubble('her', String(item.text || ''), m.tier));
    }
  }
  // the unread wall fills the screen, history stays up there for
  // whoever scrolls back. and that's the last time WE scroll it
  const toUnread = () => { thread.scrollTop = mark.offsetTop - 8; };

  const timers = [];
  let closed = false;
  let locked = !!scene.lock;

  function unlock(tapped) {
    if (!locked || closed) return;
    locked = false;
    const { lock, notes } = scene.lock;
    if (tapped) tapped.classList.add('is-pressed');
    timers.push(setTimeout(() => {
      scene.app.inert = false;
      scene.screen.classList.remove('is-locked');
      toUnread();
      for (const n of notes) n.disabled = true;
      timers.push(setTimeout(() => lock.remove(), UNLOCK_MS));
    }, tapped ? TAP_MS : 0));
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    // aria-modal promises nothing behind it is reachable, so Tab
    // goes round the phone and never into the app underneath
    const stops = locked
      ? [...scene.lock.notes, scene.home]
      : [thread, scene.input, scene.send, scene.home];
    const at = stops.indexOf(document.activeElement);
    e.preventDefault();
    stops[at === -1 ? 0 : (at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
  }

  let downInPhone = false;
  root.addEventListener('pointerdown', (e) => { downInPhone = phone.contains(e.target); });
  root.addEventListener('click', (e) => {
    if (!downInPhone && !phone.contains(e.target)) close();
  });
  scene.home.addEventListener('click', () => close());
  if (scene.lock) for (const n of scene.lock.notes) n.addEventListener('click', () => unlock(null));
  scene.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = scene.input.value.trim();
    if (!text) return;
    close(false, handOff(text));
  });
  window.addEventListener('keydown', onKey, true);
  const tick = setInterval(() => {
    const now = clock.format(new Date());
    scene.clockEl.textContent = now;
    if (scene.lock) scene.lock.time.textContent = now;
  }, 15000);

  // her real reply to what he sent IS the reaction, so a sent
  // reply skips the greeting
  function close(instant = false, replied = false) {
    if (closed) return;
    closed = true;
    openScene = null;
    for (const t of timers) clearTimeout(t);
    clearInterval(tick);
    window.removeEventListener('keydown', onKey, true);
    if (root.contains(document.activeElement)) document.activeElement.blur();
    if (instant) { root.remove(); return; }
    root.classList.add('is-closing');
    setTimeout(() => {
      root.remove();
      if (!replied) react(live, tier);
    }, reduced ? CLOSE_REDUCED_MS : CLOSE_MS);
  }
  openScene = close;

  document.body.appendChild(root);
  root.focus({ preventScroll: true });
  toUnread();
  if (locked) timers.push(setTimeout(() => unlock(scene.lock.notes[0]), RIG_IN_MS + LOCK_HOLD_MS));
  // two frames. the overlay has to be laid out at its start
  // position before the class lands or the slide has nothing to
  // move from
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('is-open')));
}

// six lines from a long absence is a while to sit through. he
// reaches for the chat box, she's done
function abortOnInteraction() {
  const stop = () => { if (endReaction) endReaction(true); };
  chatInput.addEventListener('focus', stop, { once: true });
  chatInput.addEventListener('keydown', stop, { once: true });
  sendBtn.addEventListener('click', stop, { once: true });
  return () => {
    chatInput.removeEventListener('focus', stop);
    chatInput.removeEventListener('keydown', stop);
    sendBtn.removeEventListener('click', stop);
  };
}

// she reacts once he's through the door. face bubble + voice, the
// tier sequence on the normal camera, no zoom
function react(lines, tier) {
  if (!lines.length) return;
  const plains = lines.map(line => Names.apply(line));
  const cards = plains.map(escapeHtml);
  const rig = Live2D.hasModel();
  const loops = rig ? TIER_LOOPS[tier] || TIER_LOOPS.none : [];
  const speaks = TTS.isEnabled();
  const timers = [];
  const at = (ms, fn) => timers.push(setTimeout(fn, ms));
  let shown = -1;
  let talking = false;

  const detach = abortOnInteraction();
  endReaction = (aborted = false) => {
    endReaction = null;
    detach();
    for (const t of timers) clearTimeout(t);
    // voice mode speaks through the same TTS. if it's on, whatever
    // is playing now may be ITS reply, not our line
    if (talking && !VoiceMode.isActive()) TTS.stop();
    // only the last line has a hide timer, a line cut off early
    // would sit on her face until the next reply
    if (aborted && shown >= 0 && shown < cards.length - 1) scheduleFaceBubbleHide(cards[shown], 'ephemeral');
    for (const [param] of loops) Live2D.stopLoop(param);
    if (rig) {
      Live2D.resetIdle();
      Live2D.startIdle();
      Live2D.setFidgetsEnabled(true);
    }
  };

  if (rig) {
    Live2D.setFidgetsEnabled(false);
    Live2D.scheduleSequence(SCENES[tier] || SCENES.none);
    for (const [param, amp, period] of loops) Live2D.startLoop(param, amp, period);
  }

  // lines advance when the VOICE finishes them, not on a timer. a
  // fixed pace yanks the text away mid sentence on anything longer
  // than a few words. with no TTS we guess from the word count
  // instead.
  function showLine(i) {
    if (!endReaction) return;
    if (i >= plains.length) {
      at(SCENE_TAIL_MS, () => endReaction && endReaction());
      return;
    }
    shown = i;
    replayFaceBubbleIntro();
    showFaceBubble(cards[i], 'ephemeral');

    let advanced = false;
    const next = () => {
      if (advanced || !endReaction) return;
      advanced = true;
      talking = false;
      showLine(i + 1);
    };

    // speak() kills whatever is playing, which is exactly what we
    // want. one job at a time is what gives us an onDone per line
    // to wait on.
    talking = speaks && TTS.speak(plains[i], {
      onDone: () => { talking = false; at(LINE_GAP_MS, next); },
      onError: next,
    });
    // scheduleFaceBubbleHide defers itself while TTS is talking, so
    // the last card has to be set up AFTER the job exists or its read
    // timer starts right NOW.
    if (i === plains.length - 1) scheduleFaceBubbleHide(cards[i], 'ephemeral');

    // synthesis can die without a word, or the tab gets throttled.
    // NEVER leave her waiting on a callback that isn't coming.
    at(talking ? lineDuration(plains[i]) * 3 + 5000 : lineDuration(plains[i]), next);
  }

  showLine(0);
}
