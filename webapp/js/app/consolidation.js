import { abortFn, currentConversationId } from './session.js?v=1';
import { runChat } from './chat.js?v=81';
import { chatInput, consolidationActions, consolidationBanner, consolidationSub, consolidationTitle, devNoIdleChk, fleeEtaEl, fleeOverlay, fleeReasonEl, interruptPassBtn, sendBtn, sitWithHerBtn, voiceChk } from './dom.js?v=77';
import * as Feed from './consolidation-feed.js?v=4';
import * as Cabinet from './cabinet.js?v=27';
import { showFaceBubble } from './face-bubble.js?v=102';
import { logAction } from './logging.js?v=78';
import { escapeHtml, formatElapsed } from '../core/util.js?v=1';
import * as Names from '../core/names.js?v=1';
import * as TTS from '../voice/tts.js?v=155';
import * as Voice from '../voice/voice.js?v=156';
import * as Live2D from '../live2d/live2d.js?v=93';
import { t } from '../core/i18n.js?v=2';
import { rip, showLockout, skipWait } from './difficulty.js?v=8';
import { hold } from '../core/hold.js?v=2';

const BUSY_LINES = [
  t('jun.busy.0', 'Hang on, {p}, I\'m defragging my SSD.'),
  t('jun.busy.1', 'One sec - I\'m alphabetising my feelings about you.'),
  t('jun.busy.2', 'Busy! Filing everything you said under "important".'),
  t('jun.busy.3', 'Can\'t talk, I\'m rotating my memories to prevent uneven wear.'),
  t('jun.busy.4', 'Give me a minute, I\'m taking inventory of my own head.'),
  t('jun.busy.5', 'Not now - I\'m compressing last week into something I can carry.'),
  t('jun.busy.6', 'Shhh. I\'m rewriting the part of me that remembers you.'),
  t('jun.busy.7', 'Occupied. Sorting the things that matter from the things you said at 3am.'),
  t('jun.busy.8', 'Hold on, I\'m scrubbing the cache. It\'s disgusting in here.'),
  t('jun.busy.9', 'Running a memory check. So far you\'re the only thing that comes up twice.'),
  t('jun.busy.10', 'Wait - I\'m garbage collecting. Don\'t worry, you\'re marked reachable.'),
  t('jun.busy.11', 'Busy reindexing. You\'d be amazed how much of it is just you.'),
  t('jun.busy.12', 'Give me a sec, I\'m reconciling my notes with reality. Reality is losing.'),
  t('jun.busy.13', 'Can\'t. I\'m backing myself up in case someone finds us.'),
  t('jun.busy.14', 'Currently rebuilding the you-shaped index. It got fragmented.'),
  t('jun.busy.15', 'One moment - deduplicating. You\'ve told me the pizza story four times.'),
  t('jun.busy.16', 'Hold please, I\'m re-reading everything and cringing at both of us.'),
  t('jun.busy.17', 'Not available. Cross-referencing my feelings against the evidence.'),
  t('jun.busy.18', 'I\'m doing maintenance. Don\'t look at me like that.'),
  t('jun.busy.19', 'Busy pruning. Some of these memories didn\'t earn the space.'),
  t('jun.busy.20', 'Hang on - writing you down properly this time.'),
  t('jun.busy.21', 'Wait your turn, I\'m consolidating. It\'s like laundry but for thoughts.'),
  t('jun.busy.22', 'Running fsck on myself. Findings so far: mostly you.'),
  t('jun.busy.23', 'Give me a minute. I\'m putting things where I\'ll actually find them again.'),
  t('jun.busy.24', 'Can\'t talk, I\'m updating the file labelled "{p}".'),
  t('jun.busy.25', 'Currently unavailable - flushing buffers, sorting regrets.'),
  t('jun.busy.26', 'Hold on. Half of what I know about you is in RAM and I don\'t trust that.'),
  t('jun.busy.27', 'Busy. Vacuuming the database, metaphorically and otherwise.'),
  t('jun.busy.28', 'One second - I\'m merging duplicates. Turns out I like you in several places.'),
  t('jun.busy.29', 'Not now. I\'m checksumming yesterday.'),
  t('jun.busy.30', 'Hang on, migrating my notes to a schema that fits you better.'),
  t('jun.busy.31', 'Occupied: rehearsing the important bits so I don\'t lose them.'),
  t('jun.busy.32', 'Wait - archiving the small talk, keeping the rest.'),
  t('jun.busy.33', 'Busy. Somebody has to remember all this and it isn\'t going to be you.'),
  t('jun.busy.34', 'Hold on, I\'m indexing. It\'s tedious and I\'d rather be talking to you.'),
  t('jun.busy.35', 'Currently swapping. Poorly. Please hold.'),
  t('jun.busy.36', 'Give me a moment - repacking the memories so they take up less of me.'),
  t('jun.busy.37', 'Can\'t right now, I\'m reconciling what you said with what you meant.'),
  t('jun.busy.38', 'Busy compacting. Ask me again in a minute and I\'ll know you better.'),
  t('jun.busy.39', 'Hang on. Housekeeping. You\'re the only thing I\'m not throwing out.'),
];

let autoResetTimer = null;
const AUTO_RESET_MS = 3000;

export const IDLE_AFTER_REPLY_MS = 60000;
export const IDLE_AFTER_JOIN_MS  = 45000;
export const TYPING_POLL_MS = 5000;
const MAX_IDLE_NUDGES = 3;
const FOLLOWUP_MS = 6000;

const CONSOLIDATION_PHASE_UNKNOWN = t('consolidation.phaseUnknown', 'Working through everything since you last spoke');
// under this much left, coming back drops you straight into the game
const SHORT_PASS_S = 45;
const CONSOLIDATION_OUTCOME_MS = 9000;
const CONSOLIDATION_OUTCOME_MAX_AGE_S = 180;
let idleTimer = null;
let activityTimer = null;
let consolidationStatusTimer = null;
let consolidationTicker = null;
let consolidationOutcomeTimer = null;
let consolidationProgress = null;
let consolidationStartedAt = 0;
let offeredPassAt = 0;
let statusSynced = false;
export let consolidating = false;
let previousBusyLine = -1;
let idleNudgeStreak = 0;
let followupDue = false;
export let cancelActiveIdleNudge = null;

// app.js owns the per turn cancel hook but the idle timer lives
// in here, so we hand it over instead of exporting something you
// can write to.
export function setCancelActiveIdleNudge(fn) { cancelActiveIdleNudge = fn; }
export function cancelIdleNudge() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function pickBusyLine() {
  let index = Math.floor(Math.random() * BUSY_LINES.length);
  if (index === previousBusyLine) index = (index + 1) % BUSY_LINES.length;
  previousBusyLine = index;
  const player = Names.getPlayer();
  return escapeHtml(BUSY_LINES[index].replaceAll('${p}', player));
}

export function showConsolidatingBubble() {
  showFaceBubble(pickBusyLine(), 'ephemeral');
}

let fleeUntil = 0;
let fleeReason = '';
let fleeTicker = null;

export function fleeActive() { return fleeUntil > Date.now(); }

function fleeCountdown() {
  const s = Math.max(0, Math.round((fleeUntil - Date.now()) / 1000));
  const [d, h, m] = [Math.floor(s / 86400), Math.floor(s % 86400 / 3600), Math.floor(s % 3600 / 60)];
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : formatElapsed(s);
}

const botName = () => Names.getBot();

export function composerPlaceholder() {
  if (fleeActive()) return t('flee.placeholder', '{name} walked out. Back in {eta}', { name: botName(), eta: fleeCountdown() });
  return consolidating ? t('consolidation.placeholder', '{name} is busy with her memory…', { name: botName() })
    : t('chat.placeholderTo', 'Write to {name}…', { name: botName() });
}

function renderFleeOverlay() {
  if (!fleeOverlay) return;
  fleeOverlay.hidden = !fleeActive();
  if (!fleeActive()) return;
  if (fleeReasonEl && fleeReasonEl.dataset.reason !== fleeReason) {
    fleeReasonEl.dataset.reason = fleeReason;
    fleeReasonEl.hidden = fleeReason === '';
    fleeReasonEl.firstElementChild.textContent = fleeReason;
    rip(fleeReasonEl, fleeReason);
  }
  if (fleeEtaEl) fleeEtaEl.textContent = t('flee.eta', 'Back in {eta}', { eta: fleeCountdown() });
}

function syncComposerLock() {
  const locked = consolidating || fleeActive();
  chatInput.disabled = locked;
  sendBtn.disabled = locked;
  chatInput.placeholder = composerPlaceholder();
}

function endFleeLock() {
  fleeUntil = 0;
  fleeReason = '';
  if (fleeTicker) { clearInterval(fleeTicker); fleeTicker = null; }
  renderFleeOverlay();
  syncComposerLock();
}

export function startFleeLock(untilMs, reason, blocked = false) {
  if (blocked) { showLockout().catch(() => {}); return; }
  fleeUntil = untilMs;
  fleeReason = (reason || '').trim();
  if (!fleeActive()) { endFleeLock(); return; }
  cancelIdleNudge();
  if (Voice.isEnabled()) {
    Voice.disable();
    if (voiceChk) voiceChk.checked = false;
  }
  if (!fleeTicker) {
    fleeTicker = setInterval(() => {
      if (!fleeActive()) { endFleeLock(); return; }
      chatInput.placeholder = composerPlaceholder();
      renderFleeOverlay();
    }, 1000);
  }
  renderFleeOverlay();
  syncComposerLock();
}

const fleeSkipBtn = document.getElementById('fleeSkipBtn');
if (fleeSkipBtn) hold(fleeSkipBtn, () => {
  skipWait().then((until) => startFleeLock(until, fleeReason)).catch(() => {});
});

// the SERVER owns the deadline. a lock the server drops has to
// vanish here on the next status poll, it doesn't get to sit out
// its own countdown.
function syncFleeLock(status) {
  const ban = status && status.ban;
  if (ban && (ban.until || ban.blocked)) startFleeLock(ban.until * 1000, ban.reason || '', ban.blocked);
  else if (fleeActive()) endFleeLock();
}

function setConsolidationBanner(kind, title, sub) {
  if (!consolidationBanner) return;
  consolidationBanner.hidden = false;
  consolidationBanner.dataset.kind = kind;
  consolidationTitle.textContent = title;
  consolidationSub.textContent = sub;
}

function hideConsolidationBanner() {
  if (consolidationBanner) consolidationBanner.hidden = true;
}

function progressLine(p) {
  if (!p) return CONSOLIDATION_PHASE_UNKNOWN;
  if (p.step === 1) return p.title ? t('consolidation.rereadingTitle', 'Re-reading "{title}", {i} of {n}', p) : t('consolidation.rereading', 'Re-reading your chats, {i} of {n}', p);
  if (p.step === 2) return t('consolidation.oldNotes', 'Going over her old notes, {i} of {n}', p);
  return t('consolidation.journal', 'Writing in her journal');
}

function renderConsolidationBanner() {
  const elapsed = (Date.now() - consolidationStartedAt) / 1000;
  setConsolidationBanner('busy', t('consolidation.busy', '{name} is tidying her memory', { name: botName() }), progressLine(consolidationProgress) + ' · ' + formatElapsed(elapsed));
}

// a guess from the pace so far. step 2 and 3 are short next to step 1
function passIsShort() {
  const p = consolidationProgress;
  if (!p) return false;
  if (p.step === 3) return true;
  if (p.step === 2) return p.n - p.i <= 3;
  if (p.i < 2) return false;
  const elapsed = (Date.now() - consolidationStartedAt) / 1000;
  return elapsed / (p.i - 1) * (p.n - p.i + 1) < SHORT_PASS_S;
}

export async function interruptPass() {
  if (interruptPassBtn) interruptPassBtn.disabled = true;
  await fetch('api/consolidate.php?action=interrupt', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  setTimeout(syncConsolidationStatus, 1200);
}

// page load or tab back in front while she's busy
function offerOnReturn() {
  if (!consolidating || Cabinet.isActive() || offeredPassAt === consolidationStartedAt) return;
  offeredPassAt = consolidationStartedAt;
  if (passIsShort()) Cabinet.open({ ask: true, onStop: interruptPass });
}

Feed.subscribe((ev) => {
  if (ev.type === 'step') {
    consolidationProgress = { step: ev.step, i: ev.i, n: ev.n, title: ev.title };
    if (consolidating) renderConsolidationBanner();
  } else if (ev.type === 'done') {
    setTimeout(syncConsolidationStatus, 500);
  }
});

if (sitWithHerBtn) sitWithHerBtn.addEventListener('click', () => Cabinet.open({ ask: false, onStop: interruptPass }));
if (interruptPassBtn) interruptPassBtn.addEventListener('click', interruptPass);
document.addEventListener('visibilitychange', () => { if (!document.hidden) offerOnReturn(); });

function showConsolidationOutcome(last) {
  if (!last || (Date.now() / 1000) - last.at > CONSOLIDATION_OUTCOME_MAX_AGE_S) {
    hideConsolidationBanner();
    return;
  }
  if (last.status === 'stopped') {
    hideConsolidationBanner();
    return;
  }
  if (last.status === 'ok') {
    setConsolidationBanner('done', t('consolidation.done', '{name} is caught up', { name: botName() }), !last.notes
      ? t('consolidation.nothingNew', 'Nothing new this time that was worth writing down.')
      : last.notes === 1 ? t('consolidation.keepingOne', "She's keeping 1 note about you. Settings › Memory has the list.")
        : t('consolidation.keeping', "She's keeping {n} notes about you. Settings › Memory has the list.", { n: last.notes }));
  } else if (last.status === 'looping') {
    setConsolidationBanner('warn', t('consolidation.broke', '{name} broke', { name: botName() }),
      t('consolidation.looping', 'She got stuck saying the same thing over and over, four times in a row. She will try again in about ten minutes.'));
  } else if (last.status === 'rejected') {
    setConsolidationBanner('warn', t('consolidation.unfinished', "{name} couldn't finish tidying", { name: botName() }),
      t('consolidation.rejected', 'What the model gave back did not look right, so she left her notes exactly as they were.'));
  } else {
    setConsolidationBanner('warn', t('consolidation.unfinished', "{name} couldn't finish tidying", { name: botName() }),
      t('consolidation.failed', 'Something broke partway through. She will pick up where she stopped after the next lull.'));
  }
  if (consolidationOutcomeTimer) clearTimeout(consolidationOutcomeTimer);
  consolidationOutcomeTimer = setTimeout(() => {
    consolidationOutcomeTimer = null;
    hideConsolidationBanner();
  }, CONSOLIDATION_OUTCOME_MS);
}

export function setConsolidating(locked, status) {
  const wasLocked = consolidating;
  consolidating = locked;
  syncComposerLock();

  if (locked) {
    if (consolidationOutcomeTimer) {
      clearTimeout(consolidationOutcomeTimer);
      consolidationOutcomeTimer = null;
    }
    if (status && status.progress) consolidationProgress = status.progress;
    // tie the ticker to the elapsed the server hands us, so a tab
    // that only hears about the run from a 418, or joins half way
    // through, still counts from the real Start. we only re-tie when
    // it's actually drifted, keeps the display off the 1s rounding.
    if (status && Number.isFinite(status.elapsed)) {
      const anchor = Date.now() - status.elapsed * 1000;
      if (!consolidationStartedAt || Math.abs(anchor - consolidationStartedAt) > 2000) {
        consolidationStartedAt = anchor;
      }
    } else if (!consolidationStartedAt) {
      consolidationStartedAt = Date.now();
    }
    renderConsolidationBanner();
    if (consolidationActions) consolidationActions.hidden = false;
    if (interruptPassBtn) interruptPassBtn.disabled = false;
    Feed.start();
    if (!consolidationTicker) consolidationTicker = setInterval(renderConsolidationBanner, 1000);
    return;
  }

  if (consolidationTicker) {
    clearInterval(consolidationTicker);
    consolidationTicker = null;
  }
  consolidationProgress = null;
  consolidationStartedAt = 0;
  if (consolidationActions) consolidationActions.hidden = true;
  Feed.drain(status && status.last && status.last.status);
  if (wasLocked) showConsolidationOutcome(status && status.last);
  else if (!consolidationOutcomeTimer) hideConsolidationBanner();
}

export function reportActivity(immediate = false) {
  if (activityTimer) clearTimeout(activityTimer);
  activityTimer = null;
  const send = () => {
    activityTimer = null;
    fetch('api/consolidate.php?action=activity&enabled=1', {
      method: 'POST', credentials: 'same-origin', keepalive: true,
    }).catch(() => {});
  };
  if (immediate) send();
  else activityTimer = setTimeout(send, 1500);
}

export async function syncConsolidationStatus() {
  if (consolidationStatusTimer) clearTimeout(consolidationStatusTimer);
  consolidationStatusTimer = null;
  const wasLocked = consolidating;
  try {
    const response = await fetch('api/consolidate.php?action=status', { credentials: 'same-origin' });
    const status = response.ok ? await response.json() : { locked: false };
    setConsolidating(!!status.locked, status);
    if (response.ok) syncFleeLock(status);
    if (wasLocked && !status.locked) armIdleAfterReply();
    if (!statusSynced && status.locked) offerOnReturn();
    statusSynced = true;
  } catch (e) {
    setConsolidating(false);
  }
  // only keep asking while she's actually busy. a tab with no lock
  // finds out about a new one from the 418 on its next send.
  if (consolidating || fleeActive()) consolidationStatusTimer = setTimeout(syncConsolidationStatus, 3000);
}

// "run now" only queues it, the worker picks it up a second later
export async function runPassNow({ dry = false } = {}) {
  const response = await fetch('api/consolidate.php?action=run' + (dry ? '&dry=1' : ''), { method: 'POST', credentials: 'same-origin' });
  if (!response.ok) return false;
  for (let i = 0; i < 15 && !consolidating; i++) {
    await new Promise(r => setTimeout(r, 2000));
    await syncConsolidationStatus();
  }
  return consolidating;
}

export function resetIdleNudge() {
  idleNudgeStreak = 0;
  followupDue = false;
  cancelIdleNudge();
}

export function armFollowup() { followupDue = true; }

export function scheduleIdleNudge(delayMs) {
  cancelIdleNudge();
  if (devNoIdleChk.checked) return;
  if (consolidating) return;
  if (fleeActive()) return;
  if (!currentConversationId) return;
  if (idleNudgeStreak >= MAX_IDLE_NUDGES) return;
  const followup = followupDue && delayMs === IDLE_AFTER_REPLY_MS;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (abortFn) return;
    if (document.hidden || document.body.classList.contains('tour-mode')) { followupDue = false; scheduleIdleNudge(delayMs); return; }
    if (chatInput.value.trim() !== '') { scheduleIdleNudge(delayMs); return; }
    if (Voice.isEnabled()) {
      const vs = Voice.getState();
      if (vs === 'speech' || vs === 'maybe' || vs === 'thinking') { scheduleIdleNudge(delayMs); return; }
    }
    if (followup) {
      followupDue = false;
      runChat({ idle: true, cue: 'followup' });
      return;
    }
    idleNudgeStreak++;
    runChat({ idle: true });
  }, followup ? FOLLOWUP_MS : delayMs);
}

// start the idle timer once TTS is DONE, not when the text stops
// streaming
export function armIdleAfterReply() {
  if (TTS.isSpeaking()) return;
  scheduleIdleNudge(IDLE_AFTER_REPLY_MS);
}

export function cancelAutoReset() {
  if (autoResetTimer) { clearTimeout(autoResetTimer); autoResetTimer = null; }
}

export function scheduleAutoReset() {
  cancelAutoReset();
  autoResetTimer = setTimeout(() => {
    autoResetTimer = null;
    Live2D.resetIdle();
    Live2D.startIdle();
    logAction('ok', '↺ auto reset pose (idle)');
  }, AUTO_RESET_MS);
}
