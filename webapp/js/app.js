// the ?v= on an import is part of what the module IS. not a cache key. an
// identity. load this file from index.html at one version while a child asks
// for ../app.js at another and the browser builds it TWICE, which turns the
// import cycles into "can't access lexical declaration before
// initialization". every URL in this graph carries one number and they all
// move together: the <script> tag, the imports below, and every ?v= inside
// js/app/ and js/live2d/. no example numbers in here on purpose, a bulk
// renumber would rewrite them and kill the exact mismatch we're describing.
//
// bumping only the files you edited is NOT enough, and it fails late. js is
// served immutable for a year, so a module whose *body* changed while its own
// ?v= stayed put is Never fetched again, and that stale copy keeps asking for
// the version number it was written against. change anything in the graph,
// renumber the Whole graph. no exceptions.

import { showAuthScreen } from './app/auth-screen.js?v=8';
import { IDLE_AFTER_REPLY_MS, TYPING_POLL_MS, armIdleAfterReply, cancelActiveIdleNudge, cancelAutoReset, cancelIdleNudge, composerPlaceholder, consolidating, fleeActive, reportActivity, resetIdleNudge, scheduleAutoReset, scheduleIdleNudge, setCancelActiveIdleNudge, setConsolidating, showConsolidatingBubble, startFleeLock, syncConsolidationStatus } from './app/consolidation.js?v=8';
import { chatInput, debugSystemPromptEl, devNoIdleChk, messagesEl, messagesEmpty, missingParamsEl, mobileConversationTitle, modelSelect, narrowSidebarQuery, reasoningSelect, sendBtn, sendButtonIdleMarkup, sendButtonStopMarkup, siteVolumeInput, stageEl, thinkChk } from './app/dom.js?v=8';
import { announceMobileReply, faceBubble, hideFaceBubble, latestAssistantReply, restartFaceBubbleHide, scheduleFaceBubbleHide, scheduleFaceBubblePosition, setLatestAssistantReply, showFaceBubble } from './app/face-bubble.js?v=8';
import { appendRaw, logAction, logMissing, logToolStatus, setStageStatus } from './app/logging.js?v=8';
import { loadMood } from './app/mood.js?v=8';
import { applyProviderCapabilities, applyRoleGates, setSiteVolume, syncThinkToggle, updateSiteVolumeLabel, wireNameSettings } from './app/settings.js?v=8';
import { loadConversation, refreshSidebar, setSidebarOpen } from './app/sidebar.js?v=8';
import { makeNameFilter, makeStreamBuffer } from './app/stream-filters.js?v=8';
import { escapeHtml, localTimeString, phoneMode } from './app/util.js?v=8';
import { wireTts } from './app/wire-tts.js?v=8';
import { wireVoice } from './app/wire-voice.js?v=8';
import { WELCOME_TIERS, fetchWelcome, playWelcome, previewWelcome } from './app/welcome.js?v=8';

export const messages = [];
export let abortFn = null;
export let currentConversationId = null;
export let currentUser = null;

// the sidebar changes conversations but the id gets read all over app.js, so
// ownership stays here and we hand it over instead of exporting something
// you can write to.
export function setCurrentConversationId(id) { currentConversationId = id; }

// console handle for replaying the welcome scene, Welcome.preview('panicked')
window.Welcome = { preview: previewWelcome, tiers: WELCOME_TIERS };
let chatGeneration = 0;

export let stopActiveStream = null;
export let renderVoiceDraft = null;
let activeBubbleStream = null;
export let currentConversationTitle = 'New conversation';

const MARKDOWN_TAGS = [
  'p', 'br', 'strong', 'em', 's', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'a', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'kbd',
];

export function renderMarkdown(text) {
  if (!window.marked || !window.DOMPurify) return escapeHtml(text || '');
  const html = marked.parse(text || '');
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: MARKDOWN_TAGS,
    ALLOWED_ATTR: ['href', 'title'],
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
  });
  const template = document.createElement('template');
  template.innerHTML = clean;
  template.content.querySelectorAll('a').forEach(link => {
    try {
      const url = new URL(link.getAttribute('href') || '', location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    } catch (_) {
      link.removeAttribute('href');
    }
  });
  return template.innerHTML;
}

export function appendMsg(role, content) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  if (role === 'user') hideFaceBubble();
  if (role === 'assistant') {
    el.innerHTML = renderMarkdown(content);
  } else {
    el.textContent = content;
  }
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  updateEmptyState();
  return el;
}

function addRatingControls(message) {
  document.querySelectorAll('.msg-rate button').forEach(button => { button.disabled = true; });
  const rate = document.createElement('div');
  rate.className = 'msg-rate';
  const up = document.createElement('button');
  const down = document.createElement('button');
  up.type = down.type = 'button';
  up.textContent = '👍';
  down.textContent = '👎';
  up.setAttribute('aria-label', 'Rate this reply positively');
  down.setAttribute('aria-label', 'Rate this reply negatively');
  rate.append(up, down);
  message.appendChild(rate);
  requestAnimationFrame(() => rate.classList.add('shown'));

  let rateTimer;
  const fadeOutRate = () => {
    clearTimeout(rateTimer);
    if (!message.isConnected || !rate.isConnected || rate.classList.contains('hiding')) return;
    rate.classList.add('hiding');
    let removed = false;
    const removeRate = event => {
      if (event && event.target !== rate) return;
      if (removed) return;
      removed = true;
      rate.remove();
      rate.removeEventListener('transitionend', removeRate);
    };
    rate.addEventListener('transitionend', removeRate);
    setTimeout(removeRate, 250);
  };
  rateTimer = setTimeout(fadeOutRate, 5000);

  up.addEventListener('click', () => {
    if (abortFn) return;
    up.classList.add('selected');
    up.disabled = down.disabled = true;
    clearTimeout(rateTimer);
    fadeOutRate();
  });
  down.addEventListener('click', async () => {
    if (abortFn) return;
    up.disabled = down.disabled = true;
    clearTimeout(rateTimer);
    message.remove();
    if (messages[messages.length - 1]?.role === 'assistant') messages.pop();
    if (currentConversationId != null) {
      try {
        await fetch(`api/conversations.php?action=delete_last_assistant&id=${encodeURIComponent(currentConversationId)}`, {
          method: 'POST',
          credentials: 'same-origin',
        });
      } catch {}
    }
    updateEmptyState();
    runChat({ idle: false });
  });
}

export function setConversationTitle(title) {
  currentConversationTitle = title || 'New conversation';
  if (!mobileConversationTitle) return;
  mobileConversationTitle.textContent = currentConversationTitle;
  mobileConversationTitle.setAttribute('aria-label', latestAssistantReply
    ? `${currentConversationTitle}. Show latest reply`
    : currentConversationTitle);
}

faceBubble.addEventListener('pointerdown', restartFaceBubbleHide);
faceBubble.addEventListener('scroll', restartFaceBubbleHide, { capture: true, passive: true });
faceBubble.addEventListener('focus', restartFaceBubbleHide);
faceBubble.addEventListener('keydown', restartFaceBubbleHide);
faceBubble.addEventListener('focusout', (event) => {
  if (!faceBubble.contains(event.relatedTarget)) restartFaceBubbleHide();
});
if (window.ResizeObserver) new ResizeObserver(scheduleFaceBubblePosition).observe(faceBubble);
window.addEventListener('resize', scheduleFaceBubblePosition);
if (window.MobileViewport) {
  MobileViewport.subscribe((state) => {
    if (state.visualChanged || state.layoutChanged) scheduleFaceBubblePosition();
    if (!state.phoneChanged) return;
    hideFaceBubble();
    setLatestAssistantReply(latestAssistantReply);
    if (activeBubbleStream && (state.isPhone || activeBubbleStream.ephemeral)) activeBubbleStream.render();
  });
}

export function updateEmptyState() {
  if (!messagesEmpty) return;
  if (messagesEl.children.length > 0) {
    messagesEmpty.classList.add('hidden');
  } else {
    messagesEmpty.classList.remove('hidden');
  }
}

export function sendMessage() {
  if (fleeActive()) {
    ui.toast('⚠ ' + composerPlaceholder(), 'error');
    return;
  }
  if (consolidating) {
    showConsolidatingBubble();
    return;
  }
  const text = chatInput.value.trim();
  if (!text) return;
  if (abortFn) {
    if (!cancelActiveIdleNudge) return;
    cancelActiveIdleNudge();
  }
  resetIdleNudge();
  reportActivity();
  chatInput.value = '';
  appendMsg('user', text);
  messages.push({ role: 'user', content: window.Names ? Names.canonicalize(text) : text });
  runChat({ idle: false });
}

function sendTouchEvent(text) {
  if (abortFn || fleeActive()) return;
  resetIdleNudge();
  reportActivity();
  messages.push({ role: 'user', content: text });
  runChat({ idle: false, ephemeral: true });
}

export const VOICE_STATE_LABELS = {
  idle: 'off',
  calibrating: 'listening to the room…',
  listening: 'listening',
  // maybe lasts ~96ms. way too short to flicker another label
  maybe: 'listening',
  speech: 'hearing you',
  thinking: 'transcribing…',
};

export async function sttAvailable() {
  try {
    const r = await fetch('/api/stt.php?action=health', { credentials: 'same-origin' });
    if (!r.ok) return false;
    const d = await r.json();
    return !!d.stt;
  } catch (e) {
    return false;
  }
}

export function sendFromVoice(text) {
  if (stopActiveStream) stopActiveStream();
  chatInput.value = text;
  sendMessage();
}

// bubble says "spoken", history says <audio>. that string is ALSO what the
// server stores for the turn, both sides have to match or the next request
// replays a different conversation than the one on disk.
export function sendAudioFromVoice(b64, onUnsupported) {
  if (stopActiveStream) stopActiveStream();
  resetIdleNudge();
  reportActivity();
  const bubble = appendMsg('user', '🎤 spoken message');
  messages.push({ role: 'user', content: '<audio>' });
  runChat({
    idle: false,
    audio: b64,
    onAudioUnsupported: () => {
      bubble.remove();
      const last = messages[messages.length - 1];
      if (last && last.content === '<audio>') messages.pop();
      updateEmptyState();
      if (onUnsupported) onUnsupported();
    },
  });
}

export function runChat({ idle, ephemeral, audio, onAudioUnsupported }) {
  if (abortFn) return;
  cancelIdleNudge();
  cancelAutoReset();
  const generation = ++chatGeneration;
  const isCurrent = () => generation === chatGeneration;

  const draft = appendMsg('assistant', '');
  if (ephemeral) {
    draft.remove();
    updateEmptyState();
  }
  const body = document.createElement('div');
  body.className = 'msg-body';
  draft.appendChild(body);
  const typing = document.createElement('span');
  typing.className = 'typing';
  body.appendChild(typing);

  let thinkEl = null, thinkBody = null, thinking = '';
  function pushThinking(t) {
    if (!thinkEl) {
      thinkEl = document.createElement('details');
      thinkEl.className = 'msg-think';
      thinkEl.open = true;
      const summary = document.createElement('summary');
      summary.textContent = 'Thinking…';
      thinkBody = document.createElement('div');
      thinkBody.className = 'msg-think-body';
      thinkEl.append(summary, thinkBody);
      draft.insertBefore(thinkEl, body);
    }
    thinking += t;
    thinkBody.textContent = thinking;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  let thinkSettled = false;
  function settleThinking() {
    if (!thinkEl || thinkSettled) return;
    thinkSettled = true;
    thinkEl.open = false;
    thinkEl.querySelector('summary').textContent = 'Thought process';
  }

  let visible = '';
  let shown = '';
  let silenced = false;
  const bubbleSource = ephemeral ? 'ephemeral' : 'phone';
  const bubbleEnabled = () => !(window.VoiceMode && VoiceMode.isActive()) && (ephemeral || phoneMode());
  const renderBubble = () => {
    if (!shown.trim() || !bubbleEnabled()) return;
    showFaceBubble(renderMarkdown(shown), bubbleSource);
  };
  const bubbleStream = { ephemeral: !!ephemeral, render: renderBubble, text: () => shown };
  activeBubbleStream = bubbleStream;
  const names = makeNameFilter(sub => {
    shown += sub;
    if (!(window.VoiceMode && VoiceMode.isActive())) {
      body.innerHTML = renderMarkdown(shown);
      body.appendChild(typing);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    renderBubble();
    if (window.TTS) TTS.feed(sub);
  });
  renderVoiceDraft = () => {
    body.innerHTML = renderMarkdown(shown);
    if (abortFn) body.appendChild(typing);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };
  const stream = makeStreamBuffer(clean => {
    visible += clean;
    names.push(clean);
  });

  sendBtn.disabled = false;
  sendBtn.innerHTML = sendButtonStopMarkup;
  sendBtn.setAttribute('aria-label', 'Stop response');

  stopActiveStream = (discard = false) => {
    if (!isCurrent()) return;
    chatGeneration++;
    if (abortFn) abortFn();
    if (window.TTS) TTS.stop();
    typing.remove();
    if (!discard && visible.trim()) messages.push({ role: 'assistant', content: visible });
    else draft.remove();
    finalize(!discard);
    ui.setStatus('idle', 'idle');
    updateEmptyState();
    if (!discard) {
      scheduleAutoReset();
      armIdleAfterReply();
    }
  };
  const onClickStop = () => stopActiveStream();
  sendBtn.addEventListener('click', onClickStop, { once: true });

  setCancelActiveIdleNudge(idle ? () => {
    if (!isCurrent()) return;
    chatGeneration++;
    if (abortFn) abortFn();
    if (window.TTS) TTS.stop();
    typing.remove();
    draft.remove();
    updateEmptyState();
    finalize(false);
  } : null);

  ui.setStatus('streaming', 'streaming');
  if (window.DevHud) DevHud.beginGen();
  appendRaw('--- ' + new Date().toLocaleTimeString() + (idle ? ' (idle nudge)' : '') + ' ---\n');

  // guess the reply's language off Anon's message so the pocket-tts model can
  // warm up while she writes. this ONLY picks the voice, the guess never
  // reaches the model, she works out Anon's language from the conversation
  // herself.
  if (window.TTS && TTS.predictLang) {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const predicted = TTS.predictLang(lastUser ? lastUser.content : '');
    if (predicted) {
      TTS.setReplyLang(predicted);
      TTS.warmLang(predicted);
    }
  }

  abortFn = ChatAPI.chat(
    { messages: [...messages], model: modelSelect.value,
      reasoning: reasoningSelect.value, think: thinkChk.checked,
      outfit_context: Outfit.describe(), conversation_id: currentConversationId,
      idle: !!idle, ephemeral: !!ephemeral, client_time: localTimeString(),
      audio },
    {
      onDebug: (dbg) => {
        if (!isCurrent()) return;
        if (dbg && typeof dbg.system_prompt === 'string') {
          debugSystemPromptEl.textContent = dbg.system_prompt
            + (typeof dbg.live_context === 'string'
                ? '\n\n========== LIVE CONTEXT (trailing system message) ==========\n\n' + dbg.live_context
                : '');
        }
      },
      onStats: (s) => {
        if (!isCurrent()) return;
        if (window.DevHud) DevHud.setGenStats(s);
      },
      onToolStatus: (s) => {
        if (!isCurrent()) return;
        if (s && s.state === 'running') ui.setStatus('streaming', '🔧 ' + s.name + '…');
        else ui.setStatus('streaming', 'streaming');
        logToolStatus(s);
      },
      onSilence: () => {
        if (!isCurrent()) return;
        // she decided to say nothing, so whatever leaked into the bubble
        // first never happened. drop it and mark the turn instead.
        silenced = true;
        if (window.TTS) TTS.stop();
        hideFaceBubble();
        visible = '';
        shown = '';
        typing.remove();
        draft.className = 'msg silence';
        draft.textContent = (window.Names ? Names.getBot() : 'Jun') + ' says nothing.';
      },
      onFled: (info) => {
        if (!isCurrent()) return;
        startFleeLock((info.until || 0) * 1000, info.reason);
      },
      onThinking: (t) => {
        if (!isCurrent()) return;
        if (window.DevHud) DevHud.tickToken();
        appendRaw(t);
        pushThinking(t);
      },
      onToken: (tok) => {
        if (!isCurrent()) return;
        settleThinking();
        if (window.DevHud) DevHud.tickToken();
        appendRaw(tok);
        stream.push(tok);
      },
      onDone: async () => {
        if (!isCurrent()) return;
        stream.flush();
        names.flush();
        settleThinking();
        if (window.TTS) TTS.flush();
        typing.remove();
        if (silenced) {
          // the flushes above can still push held back bytes. none of it exists
          visible = '';
          shown = '';
          if (window.TTS) TTS.stop();
          messages.push({ role: 'assistant', content: '...' });
        } else if (visible.trim()) {
          messages.push({ role: 'assistant', content: visible });
          if (!ephemeral) addRatingControls(draft);
        } else draft.remove();
        finalize();
        ui.setStatus('idle', 'idle');
        updateEmptyState();
        scheduleAutoReset();
        armIdleAfterReply();
        loadMood();
        if (window.History && !ephemeral && currentConversationId) {
          History.compact(currentConversationId).catch(() => {});
        }
        if (window.History) await refreshSidebar();
      },
      onError: async (err) => {
        if (!isCurrent()) return;
        stream.flush();
        names.flush();
        if (window.TTS) TTS.flush();
        typing.remove();
        if (!visible.trim()) draft.remove();
        if (err.message === 'user_fled') {
          const info = err.data || {};
          startFleeLock((info.until || 0) * 1000, info.reason);
        } else if (err.message === 'audio_unsupported') {
          // refused before anything was written, so the turn leaves no trace
          // here either and the next one goes through whisper
          if (onAudioUnsupported) onAudioUnsupported();
          ui.toast('⚠ This model can\'t hear - falling back to transcription', 'error');
        } else if (err.status === 418) {
          setConsolidating(true);
          showConsolidatingBubble();
          setTimeout(syncConsolidationStatus, 3000);
        } else {
          ui.toast('⚠ ' + err.message, 'error');
        }
        if (err.status === 418) ui.setStatus('idle', 'idle');
        else ui.setStatus('error', 'error');
        finalize();
        updateEmptyState();
        scheduleAutoReset();
        armIdleAfterReply();
        if (window.History) await refreshSidebar();
      },
    }
  );

  function finalize(present = true) {
    abortFn = null;
    if (activeBubbleStream === bubbleStream) activeBubbleStream = null;
    if (present && shown.trim()) {
      if (!ephemeral) setLatestAssistantReply(shown);
      if (bubbleEnabled()) {
        renderBubble();
        if (!ephemeral) announceMobileReply(shown);
        scheduleFaceBubbleHide(shown, bubbleSource);
      }
    }
    if (window.VoiceMode && VoiceMode.isActive()) body.innerHTML = renderMarkdown(shown);
    renderVoiceDraft = null;
    setCancelActiveIdleNudge(null);
    stopActiveStream = null;
    sendBtn.disabled = consolidating || fleeActive();
    sendBtn.innerHTML = sendButtonIdleMarkup;
    sendBtn.setAttribute('aria-label', 'Send');
    sendBtn.removeEventListener('click', onClickStop);
  }
}

export function discardActiveResponse() {
  hideFaceBubble();
  if (stopActiveStream) {
    stopActiveStream(true);
    return;
  }
  if (!abortFn) return;
  chatGeneration++;
  abortFn();
  abortFn = null;
  if (window.TTS) TTS.stop();
  activeBubbleStream = null;
  setCancelActiveIdleNudge(null);
  renderVoiceDraft = null;
  sendBtn.disabled = consolidating || fleeActive();
  sendBtn.innerHTML = sendButtonIdleMarkup;
  sendBtn.setAttribute('aria-label', 'Send');
  ui.setStatus('idle', 'idle');
}

export const composer = document.querySelector('.composer');
if (composer) {
  composer.addEventListener('pointerdown', () => {
    if (consolidating) showConsolidatingBubble();
  });
}
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
chatInput.addEventListener('input', () => {
  reportActivity();
  if (abortFn) return;
  resetIdleNudge();
  scheduleIdleNudge(IDLE_AFTER_REPLY_MS);
});
window.addEventListener('pagehide', () => {
  navigator.sendBeacon('api/consolidate.php?action=activity&enabled=1');
});
setInterval(() => {
  if (abortFn || !currentConversationId) return;
  if (chatInput.value.trim() === '') return;
  resetIdleNudge();
  scheduleIdleNudge(IDLE_AFTER_REPLY_MS);
}, TYPING_POLL_MS);

const appMain = document.querySelector('.app-main');
const collapseBtn = document.getElementById('collapseSidebarBtn');
const expandBtn = document.getElementById('expandSidebarBtn');
if (appMain && localStorage.getItem('sidebar.collapsed') === '1') {
  appMain.classList.add('sidebar-collapsed');
}
[collapseBtn, expandBtn].filter(Boolean).forEach(btn => {
  btn.addEventListener('click', () => {
    if (!appMain) return;
    if (narrowSidebarQuery.matches) {
      setSidebarOpen(false);
      return;
    }
    const next = !appMain.classList.contains('sidebar-collapsed');
    appMain.classList.toggle('sidebar-collapsed', next);
    localStorage.setItem('sidebar.collapsed', next ? '1' : '0');
  });
});

document.querySelectorAll('.chip[data-prompt]').forEach(chip => {
  chip.addEventListener('click', () => {
    chatInput.value = chip.dataset.prompt;
    chatInput.focus();
  });
});

ui.setStatus('idle', 'idle');

function showBoot() {
  const bo = document.getElementById('bootOverlay');
  if (bo) {
    bo.removeAttribute('data-ready');
    bo.setAttribute('aria-hidden', 'false');
  }
  if (window.BootFX) BootFX.start();
}

(async function bootstrap() {
  const me = await Auth.me().catch(() => null);
  if (!me) {
    showAuthScreen();
    return;
  }
  currentUser = me.user || null;
  applyRoleGates(currentUser);

  // the avatar stack and the per feature scripts are useless to somebody who
  // never gets past the auth screen, so we only fetch them NOW.
  // devhud.js owns the Ctrl+Shift+D handler, so keeping it out of the list is
  // literally what stops a normal account from opening the HUD at all.
  await loadScripts([
    ['vendor/pixi.min.js', 'vendor/live2dcubismcore.min.js',
     'vendor/marked.min.js', 'vendor/purify.min.js?v=3',
     'js/actions.js?v=3', 'js/outfit.js?v=18', 'js/touch.js?v=3',
     'js/mods.js?v=11', 'js/tts.js?v=3', 'js/voice.js?v=8',
     'js/voicemode.js?v=3', 'js/trip-loader.js?v=3',
     ...(currentUser?.role === 'admin' ? ['js/devhud.js?v=3'] : []),
     'js/wardrobe-open-lines.js?v=3', 'js/wardrobe-reactions.js?v=3',
     'js/wardrobe-return-lines.js?v=3'],
    ['vendor/cubism4.min.js'],
  ]);
  // live2d.js is an ES module so it can't go in a loadScripts group, and it
  // rips PIXI.live2d apart the moment it runs. that's what the await is for.
  await import('./live2d.js?v=8');

  // both of these set up a global that loads late, so they can't run at module
  // scope anymore. they'd just silently do nothing before the load.
  marked.setOptions({ gfm: true, breaks: true });
  ModelTouch.init({
    sendEvent: sendTouchEvent,
    isBusy: () => !!abortFn,
    onTouch: () => {
      if (abortFn) return;
      resetIdleNudge();
      scheduleIdleNudge(IDLE_AFTER_REPLY_MS);
    },
  });

  // coming back from the wardrobe, the return cutscene REPLACES the boot
  // terminal. skipping BootFX.start also makes BootFX.finish a no-op later.
  const fromWardrobe = new URLSearchParams(location.search).get('from') === 'wardrobe';
  if (fromWardrobe) {
    history.replaceState(null, '', location.pathname);
    TripLoader.mount({ reverse: true });
    const bo = document.getElementById('bootOverlay');
    if (bo) {
      bo.setAttribute('data-ready', '1');
      bo.setAttribute('aria-hidden', 'true');
    }
  } else {
    // keep the shell hidden until the logged in boot overlay fades out
    showBoot();
  }

  const emailEl = document.getElementById('userEmail');
  if (me.user && emailEl) emailEl.textContent = me.user.email || '';

  // fill in the synced preferences BEFORE any module reads its local keys
  if (window.Prefs) await Prefs.pullFromServer();
  if (window.Names) { Names.load(); Names.decorate(); }
  wireNameSettings();

  const storedVolume = parseFloat(localStorage.getItem('audio.volume') || '1');
  const siteVolume = setSiteVolume(storedVolume);
  if (siteVolumeInput) {
    siteVolumeInput.value = String(Math.round(siteVolume * 100));
    updateSiteVolumeLabel();
    siteVolumeInput.addEventListener('input', () => {
      setSiteVolume(parseFloat(siteVolumeInput.value) / 100);
      updateSiteVolumeLabel();
    });
    siteVolumeInput.addEventListener('change', () => {
      const volume = setSiteVolume(parseFloat(siteVolumeInput.value) / 100);
      localStorage.setItem('audio.volume', String(volume));
      if (window.Prefs) Prefs.pushToServer();
    });
  }

  const savedReasoning = localStorage.getItem('reasoning_level');
  if (savedReasoning && [...reasoningSelect.options].some(o => o.value === savedReasoning)) {
    reasoningSelect.value = savedReasoning;
  }
  if (localStorage.getItem('think') !== null) {
    thinkChk.checked = localStorage.getItem('think') === '1';
  }
  if (localStorage.getItem('no_idle_nudges') !== null) {
    devNoIdleChk.checked = localStorage.getItem('no_idle_nudges') === '1';
  }
  syncThinkToggle();
  // lock the composer up front until the first status check answers, but
  // leave the banner alone. it only ever speaks for something the server
  // actually said is true, so a normal load never flashes a consolidation
  // notice and then takes it back.
  chatInput.disabled = true;
  sendBtn.disabled = true;
  await syncConsolidationStatus();
  // the wardrobe is the same session. time in there is NOT an absence.
  if (!fromWardrobe) await fetchWelcome();
  reportActivity(true);
  // fire this BEFORE Live2D.init, not after. it is one cheap GET that only
  // needs the session, and the empty state greeting is picked off these
  // three numbers. left behind the model load it sits on the neutral
  // baseline for however many seconds the .moc3 takes. she is not neutral.
  // setMood before init is fine, it just parks the values, and startIdle
  // calls applyMoodBaseline unconditionally once the model is up.
  loadMood();

  Actions.setLogger(logAction);
  Live2D.setOnMissingParam(logMissing);
  if (window.DevHud) DevHud.init();

  try {
    const live2dInfo = await Live2D.init({ stageEl, onStatus: (m) => {
      setStageStatus(m);
      if (fromWardrobe) TripLoader.setStage(m);
    } });
    setTimeout(() => setStageStatus(null), 1500);
    if (fromWardrobe) {
      TripLoader.setStage('Home again');
      TripLoader.finish();
    }
    Live2D.startIdle();
    playWelcome();

    await Actions.load('action_map.json');

    validateActionMap(live2dInfo.paramIds);

    await Outfit.load();
    Outfit.applyAll();
    const wBtn = document.getElementById('wardrobeBtn');
    let shopPrefetched = false;
    const prefetchShop = () => {
      if (shopPrefetched) return;
      shopPrefetched = true;
      for (const [href, as] of [['wardrobe.html', 'document'], ['wardrobe-cutscene.webm', 'video']]) {
        const link = document.createElement('link');
        link.rel = 'prefetch';
        link.as = as;
        link.href = href;
        document.head.appendChild(link);
      }
    };
    if (wBtn) {
      wBtn.addEventListener('pointerenter', prefetchShop);
      wBtn.addEventListener('focus', prefetchShop);
    }
    if (wBtn) wBtn.addEventListener('click', async () => {
      prefetchShop();
      ui.toggleDrawer(false);
      if (window.WardrobeReactions && !wBtn.disabled) {
        wBtn.disabled = true;
        try { await WardrobeReactions.playIntro(); } catch (e) {}
      }
      location.href = 'wardrobe.html';
    });
  } catch (e) {
    console.error(e);
    if (fromWardrobe) TripLoader.fail('Live2D load error: ' + e.message);
    setStageStatus('Live2D load error: ' + e.message, true);
    ui.toast('Live2D load error: ' + e.message, 'error');
    ui.setStatus('error', 'error');
  }

  await wireTts();

  await wireVoice();
  const karaokeBtn = document.getElementById('karaokeOpenBtn');
  if (karaokeBtn) {
    let karaokePrefetched = false;
    const prefetchKaraoke = () => {
      if (karaokePrefetched) return;
      karaokePrefetched = true;
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.as = 'document';
      link.href = 'karaoke.html';
      document.head.appendChild(link);
    };
    karaokeBtn.addEventListener('pointerenter', prefetchKaraoke, { once: true });
    karaokeBtn.addEventListener('focus', prefetchKaraoke, { once: true });
    karaokeBtn.addEventListener('click', () => {
      ui.toggleDrawer(false);
      location.href = 'karaoke.html';
    });
    try {
      const response = await fetch('/api/karaoke.php?action=health', { credentials: 'same-origin' });
      const health = response.ok ? await response.json() : null;
      if (health && health.sep) {
        karaokeBtn.disabled = false;
        karaokeBtn.title = health.device === 'cpu'
          ? 'Sing together (CPU - separation is slow)'
          : 'Sing together';
      } else {
        karaokeBtn.title = 'Unavailable: the karaoke sidecar is not running';
      }
    } catch (e) {
      karaokeBtn.title = 'Unavailable: could not reach the karaoke sidecar';
    }
  }

  const bootOverlay = document.getElementById('bootOverlay');
  const bootStatusLabel = document.querySelector('#bootStatus .boot-status-label');
  const bootHint = document.getElementById('bootHint');
  const setBoot = (label, hint, tone) => {
    if (label) {
      if (window.BootFX) BootFX.typeStatus(label);
      else if (bootStatusLabel) bootStatusLabel.textContent = label;
    }
    if (bootHint && hint != null) {
      bootHint.textContent = hint;
      if (tone) bootHint.setAttribute('data-tone', tone);
      else bootHint.removeAttribute('data-tone');
    }
  };
  const dismissBoot = () => {
    if (!bootOverlay) return;
    document.documentElement.removeAttribute('data-pre-auth');
    setBoot('Ready', 'Connected', 'ok');
    const hide = () => {
      bootOverlay.setAttribute('data-ready', '1');
      bootOverlay.setAttribute('aria-hidden', 'true');
    };
    if (window.BootFX && BootFX.finish) BootFX.finish(hide);
    else setTimeout(hide, 350);
  };

  async function waitForProvider() {
    let attempt = 0;
    const bot = window.Names ? Names.getBot() : 'Jun';
    const phases = [
      'Waking the model',
      'Brewing Coffee for ' + (window.Names ? Names.getPlayer() : 'Anon'),
      'Recharging ' + bot,
      bot + ' is taking its time',
    ];
    for (;;) {
      attempt++;
      try {
        const m = await ChatAPI.listModels();
        if (m && m.models && m.models.length) return m;
        setBoot('Pulling models', m && m.provider && m.provider !== 'ollama'
          ? 'No models reported by the provider yet - still booting?'
          : 'No models installed yet - `ollama pull <model>`', 'err');
      } catch (e) {
        const phase = phases[Math.min(attempt - 1, phases.length - 1)];
        setBoot(phase, bot + ' is still sleeping - retrying…', 'err');
      }
      await new Promise(r => setTimeout(r, Math.min(1000 + attempt * 250, 3000)));
    }
  }

  const m = await waitForProvider();
  applyProviderCapabilities(m.provider);
  // every Jun in the list starts with the same `hf.co/efficiencyx/`, so it
  // tells you nothing and shoves the part that does off the end of the box.
  // the value keeps the full name, that's what we send back.
  const shortName = (n) => n.replace(/^hf\.co\/[^/]+\//, '');
  modelSelect.innerHTML = m.models.map(n =>
    `<option value="${escapeHtml(n)}">${escapeHtml(shortName(n))}</option>`).join('');
  const prefer = [
    'hf.co/efficiencyx/Jun-LoRA-12B-GGUF:Q8_0',
    'hf.co/efficiencyx/Jun-LoRA-12B-GGUF:Q6_K',
    'hf.co/efficiencyx/Jun-LoRA-12B-GGUF:Q4_K_M',
    'hf.co/efficiencyx/Jun-LoRA-v4-E4B-GGUF:Q8_0',
    'hf.co/efficiencyx/Jun-LoRA-v4-E4B-GGUF:Q6_K',
    'hf.co/efficiencyx/Jun-LoRA-v4-E4B-GGUF:Q4_K_M',
    'hf.co/efficiencyx/Jun-LoRA-E2B-GGUF:Q8_0',
    'hf.co/efficiencyx/Jun-LoRA-E2B-GGUF:Q6_K',
    'hf.co/efficiencyx/Jun-LoRA-E2B-GGUF:Q4_K_M',
    'llama3.1:8b', 'llama3.1:latest',
  ];
  const isChat = (n) => !/embed/i.test(n);
  const saved = localStorage.getItem('model');
  const picked = (saved && m.models.includes(saved) ? saved : null)
    || (m.default_model && m.models.includes(m.default_model) ? m.default_model : null)
    || prefer.find(p => m.models.includes(p))
    || m.models.find(isChat)
    || m.models[0];
  if (picked) modelSelect.value = picked;
  dismissBoot();

  if (window.History) {
    try {
      let convs = await History.list();
      if (convs.length === 0) {
        const { id } = await History.create();
        convs = [{ id, title: null }];
      }
      await refreshSidebar();
      await loadConversation(convs[0].id);
    } catch (e) {
      console.warn('[History] init failed:', e.message);
    }
  }
})();

function validateActionMap(modelParamIds) {
  const known = new Set(modelParamIds);
  const referenced = new Set();
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('Param')) referenced.add(k);
      else if (k === '_param' && typeof v === 'string') referenced.add(v);
      else if (k === '_loop_param' && typeof v === 'string') referenced.add(v);
      else if (typeof v === 'object') walk(v);
    }
  }
  fetch('action_map.json', { cache: 'no-cache' }).then(r => r.json()).then(am => {
    walk(am);
    const missing = [...referenced].filter(p => !known.has(p));
    if (missing.length) {
      logAction('warn', `boot: ${missing.length} params missing in model: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}`);
      for (const p of missing) {
        const row = document.createElement('div');
        row.className = 'row warn';
        row.textContent = p;
        missingParamsEl.appendChild(row);
      }
    } else {
      logAction('ok', `boot: all ${referenced.size} mapped params exist`);
    }
  });
}
