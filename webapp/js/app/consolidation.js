import { abortFn, currentConversationId, runChat } from '../app.js?v=61';
import { chatInput, consolidationBanner, consolidationSub, consolidationTitle, devNoIdleChk, fleeEtaEl, fleeOverlay, fleeReasonEl, sendBtn, voiceChk } from './dom.js?v=61';
import { showFaceBubble } from './face-bubble.js?v=61';
import { logAction } from './logging.js?v=61';
import { escapeHtml, formatElapsed } from './util.js?v=61';

const BUSY_LINES = [
  "Hang on, ${p}, I'm defragging my SSD.",
  "One sec - I'm alphabetising my feelings about you.",
  'Busy! Filing everything you said under "important".',
  "Can't talk, I'm rotating my memories to prevent uneven wear.",
  "Give me a minute, I'm taking inventory of my own head.",
  "Not now - I'm compressing last week into something I can carry.",
  "Shhh. I'm rewriting the part of me that remembers you.",
  'Occupied. Sorting the things that matter from the things you said at 3am.',
  "Hold on, I'm scrubbing the cache. It's disgusting in here.",
  "Running a memory check. So far you're the only thing that comes up twice.",
  "Wait - I'm garbage collecting. Don't worry, you're marked reachable.",
  "Busy reindexing. You'd be amazed how much of it is just you.",
  "Give me a sec, I'm reconciling my notes with reality. Reality is losing.",
  "Can't. I'm backing myself up in case someone finds us.",
  'Currently rebuilding the you-shaped index. It got fragmented.',
  "One moment - deduplicating. You've told me the pizza story four times.",
  "Hold please, I'm re-reading everything and cringing at both of us.",
  'Not available. Cross-referencing my feelings against the evidence.',
  "I'm doing maintenance. Don't look at me like that.",
  "Busy pruning. Some of these memories didn't earn the space.",
  'Hang on - writing you down properly this time.',
  "Wait your turn, I'm consolidating. It's like laundry but for thoughts.",
  'Running fsck on myself. Findings so far: mostly you.',
  "Give me a minute. I'm putting things where I'll actually find them again.",
  'Can\'t talk, I\'m updating the file labelled "${p}".',
  'Currently unavailable - flushing buffers, sorting regrets.',
  "Hold on. Half of what I know about you is in RAM and I don't trust that.",
  'Busy. Vacuuming the database, metaphorically and otherwise.',
  "One second - I'm merging duplicates. Turns out I like you in several places.",
  "Not now. I'm checksumming yesterday.",
  'Hang on, migrating my notes to a schema that fits you better.',
  'Occupied: rehearsing the important bits so I don\'t lose them.',
  'Wait - archiving the small talk, keeping the rest.',
  "Busy. Somebody has to remember all this and it isn't going to be you.",
  "Hold on, I'm indexing. It's tedious and I'd rather be talking to you.",
  'Currently swapping. Poorly. Please hold.',
  'Give me a moment - repacking the memories so they take up less of me.',
  "Can't right now, I'm reconciling what you said with what you meant.",
  "Busy compacting. Ask me again in a minute and I'll know you better.",
  "Hang on. Housekeeping. You're the only thing I'm not throwing out.",
];

let autoResetTimer = null;
const AUTO_RESET_MS = 3000;

export const IDLE_AFTER_REPLY_MS = 60000;
export const IDLE_AFTER_JOIN_MS  = 45000;
export const TYPING_POLL_MS = 5000;
const MAX_IDLE_NUDGES = 3;

const CONSOLIDATION_PHASES = {
  notes: 'Re-reading what you said and writing down what matters',
  journal: 'Rewriting her journal of the two of you',
};
const CONSOLIDATION_PHASE_UNKNOWN = 'Working through everything since you last spoke';
const CONSOLIDATION_SLOW_AFTER_S = 90;
const CONSOLIDATION_OUTCOME_MS = 9000;
const CONSOLIDATION_OUTCOME_MAX_AGE_S = 180;
let idleTimer = null;
let activityTimer = null;
let consolidationStatusTimer = null;
let consolidationTicker = null;
let consolidationOutcomeTimer = null;
let consolidationPhase = '';
let consolidationStartedAt = 0;
export let consolidating = false;
let previousBusyLine = -1;
let idleNudgeStreak = 0;
export let cancelActiveIdleNudge = null;

// app.js owns the per-turn cancel hook but the idle timer lives here, so it is
// handed over rather than exported as a writable binding.
export function setCancelActiveIdleNudge(fn) { cancelActiveIdleNudge = fn; }
export function cancelIdleNudge() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function pickBusyLine() {
  let index = Math.floor(Math.random() * BUSY_LINES.length);
  if (index === previousBusyLine) index = (index + 1) % BUSY_LINES.length;
  previousBusyLine = index;
  const player = window.Names ? Names.getPlayer() : 'Anon';
  return escapeHtml(BUSY_LINES[index].replaceAll('${p}', player));
}

export function showConsolidatingBubble() {
  showFaceBubble(pickBusyLine(), 'ephemeral');
}

let fleeUntil = 0;
let fleeReason = '';
let fleeTicker = null;

export function fleeActive() { return fleeUntil > Date.now(); }

function fleeCountdown() { return formatElapsed((fleeUntil - Date.now()) / 1000); }

export function composerPlaceholder() {
  if (fleeActive()) return 'Jun walked out. Back in ' + fleeCountdown();
  return consolidating ? 'Jun is busy with her memory…' : 'Write to Jun…';
}

function renderFleeOverlay() {
  if (!fleeOverlay) return;
  fleeOverlay.hidden = !fleeActive();
  if (!fleeActive()) return;
  if (fleeReasonEl) {
    fleeReasonEl.hidden = fleeReason === '';
    fleeReasonEl.textContent = fleeReason ? '“' + fleeReason + '”' : '';
  }
  if (fleeEtaEl) fleeEtaEl.textContent = 'back in ' + fleeCountdown();
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

export function startFleeLock(untilMs, reason) {
  fleeUntil = untilMs;
  fleeReason = (reason || '').trim();
  if (!fleeActive()) { endFleeLock(); return; }
  cancelIdleNudge();
  if (window.Voice && Voice.isEnabled()) {
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

// The server owns the deadline: a lock lifted server-side has to disappear here
// on the next status poll rather than sitting out a countdown of its own.
function syncFleeLock(status) {
  const ban = status && status.ban;
  if (ban && ban.until) startFleeLock(ban.until * 1000, ban.reason || '');
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

function renderConsolidationBanner() {
  const elapsed = (Date.now() - consolidationStartedAt) / 1000;
  const phase = CONSOLIDATION_PHASES[consolidationPhase] || CONSOLIDATION_PHASE_UNKNOWN;
  const slow = elapsed >= CONSOLIDATION_SLOW_AFTER_S
    ? ' · runs on your local model, so it can take a few minutes'
    : '';
  setConsolidationBanner('busy', 'Jun is tidying her memory', phase + ' · ' + formatElapsed(elapsed) + slow);
}

function showConsolidationOutcome(last) {
  if (!last || (Date.now() / 1000) - last.at > CONSOLIDATION_OUTCOME_MAX_AGE_S) {
    hideConsolidationBanner();
    return;
  }
  if (last.status === 'ok') {
    setConsolidationBanner('done', 'Jun is caught up', last.notes
      ? `She's keeping ${last.notes} note${last.notes === 1 ? '' : 's'} about you. Settings › Memory has the list.`
      : 'Nothing new this time that was worth writing down.');
  } else if (last.status === 'rejected') {
    setConsolidationBanner('warn', "Jun couldn't finish tidying",
      'What the model gave back did not look right, so she left her notes exactly as they were.');
  } else {
    setConsolidationBanner('warn', "Jun couldn't finish tidying",
      'Something broke partway through. Nothing was changed, she will try again after the next lull.');
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
    if (status && status.phase) consolidationPhase = status.phase;
    // Anchor the ticker to the server's elapsed, so a tab that learns about the
    // run from a 418 - or joins halfway through - still counts from the truth.
    // Re-anchoring only on real drift keeps the display off the 1s rounding.
    if (status && Number.isFinite(status.elapsed)) {
      const anchor = Date.now() - status.elapsed * 1000;
      if (!consolidationStartedAt || Math.abs(anchor - consolidationStartedAt) > 2000) {
        consolidationStartedAt = anchor;
      }
    } else if (!consolidationStartedAt) {
      consolidationStartedAt = Date.now();
    }
    renderConsolidationBanner();
    if (!consolidationTicker) consolidationTicker = setInterval(renderConsolidationBanner, 1000);
    return;
  }

  if (consolidationTicker) {
    clearInterval(consolidationTicker);
    consolidationTicker = null;
  }
  consolidationPhase = '';
  consolidationStartedAt = 0;
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
  } catch (e) {
    setConsolidating(false);
  }
  // Only keep polling while she is actually busy; an unlocked tab learns about
  // a new lock from the 418 on its next send.
  if (consolidating || fleeActive()) consolidationStatusTimer = setTimeout(syncConsolidationStatus, 3000);
}

export function resetIdleNudge() {
  idleNudgeStreak = 0;
  cancelIdleNudge();
}

export function scheduleIdleNudge(delayMs) {
  cancelIdleNudge();
  if (devNoIdleChk.checked) return;
  if (consolidating) return;
  if (fleeActive()) return;
  if (!currentConversationId) return;          // need a conversation to speak in
  if (idleNudgeStreak >= MAX_IDLE_NUDGES) return; // gave up until Anon interacts
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (abortFn) return;                 // a stream is running; it re-arms on done
    if (document.hidden) { scheduleIdleNudge(delayMs); return; } // tab hidden, recheck later
    if (chatInput.value.trim() !== '') { scheduleIdleNudge(delayMs); return; }
    if (window.Voice && Voice.isEnabled()) {
      const vs = Voice.getState();
      if (vs === 'speech' || vs === 'maybe' || vs === 'thinking') { scheduleIdleNudge(delayMs); return; }
    }
    idleNudgeStreak++;
    runChat({ idle: true });
  }, delayMs);
}

// Start the idle timer after TTS drains, not after text streaming ends.
export function armIdleAfterReply() {
  if (window.TTS && TTS.isSpeaking && TTS.isSpeaking()) return;
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
