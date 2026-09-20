// ?v= is module identity. mismatched imports create two copies
// and cycles fail with "can't access lexical declaration before
// initialization". version changes must cover index.html, imports
// here, js/app/ and js/live2d/. immutable caching lasts a year:
// unchanged URLs keep stale imports, so renumber the whole graph.
// avoid example version numbers that a bulk renumber could
// rewrite.

import { showAuthScreen } from './app/auth-screen.js?v=11';
import { IDLE_AFTER_REPLY_MS, TYPING_POLL_MS, armIdleAfterReply, cancelActiveIdleNudge, cancelAutoReset, cancelIdleNudge, composerPlaceholder, consolidating, fleeActive, reportActivity, resetIdleNudge, scheduleAutoReset, scheduleIdleNudge, setCancelActiveIdleNudge, setConsolidating, showConsolidatingBubble, startFleeLock, syncConsolidationStatus } from './app/consolidation.js?v=10';
import { chatInput, debugSystemPromptEl, devNoIdleChk, messagesEl, messagesEmpty, missingParamsEl, mobileConversationTitle, modelSelect, narrowSidebarQuery, reasoningSelect, sendBtn, sendButtonIdleMarkup, sendButtonStopMarkup, siteVolumeInput, stageEl, thinkChk } from './app/dom.js?v=11';
import { announceMobileReply, faceBubble, hideFaceBubble, latestAssistantReply, restartFaceBubbleHide, scheduleFaceBubbleHide, scheduleFaceBubblePosition, setLatestAssistantReply, showFaceBubble } from './app/face-bubble.js?v=10';
import { appendRaw, logAction, logMissing, logToolStatus, setStageStatus } from './app/logging.js?v=10';
import { loadMood } from './app/mood.js?v=10';
import { applyProviderCapabilities, applyRoleGates, setSiteVolume, syncThinkToggle, updateSiteVolumeLabel, wireNameSettings } from './app/settings.js?v=10';
import { loadConversation, refreshSidebar, setSidebarOpen } from './app/sidebar.js?v=10';
import { makeNameFilter, makeStreamBuffer } from './app/stream-filters.js?v=10';
import { escapeHtml, localTimeString, phoneMode } from './app/util.js?v=10';
import { wireTts } from './app/wire-tts.js?v=10';
import { wireVoice } from './app/wire-voice.js?v=11';
import { WELCOME_TIERS, fetchWelcome, playWelcome, previewWelcome } from './app/welcome.js?v=10';

export const messages = [];
export let abortFn = null;
export let currentConversationId = null;
export let currentUser = null;

export function setCurrentConversationId(id) { currentConversationId = id; }

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

// the button handler passes the click event here, so anything
// that isn't {voice:true} is a typed turn
export function sendMessage(opts) {
  const voice = !!(opts && opts.voice === true);
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
  const bubble = appendMsg('user', text);
  const entry = { role: 'user', content: window.Names ? Names.canonicalize(text) : text };
  messages.push(entry);
  runChat({ idle: false, voice, onOverheard: voice ? () => dropUserTurn(bubble, entry) : null });
}

// she heard him talk to someone else. the turn never happened,
// on screen or in history, the server already dropped its row
function dropUserTurn(bubble, entry) {
  bubble.remove();
  const i = messages.indexOf(entry);
  if (i !== -1) messages.splice(i, 1);
  updateEmptyState();
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
  sendMessage({ voice: true });
}

// bubble says "spoken", history says <audio>. that string is ALSO
// what the server stores for the turn, both sides have to match
// or the next request replays a different conversation than the
// one on disk. setTranscript swaps both for whisper's text once it
// lands, she heard the wav live, everything after reads words.
export function sendAudioFromVoice(b64, onUnsupported) {
  if (stopActiveStream) stopActiveStream();
  resetIdleNudge();
  reportActivity();
  const bubble = appendMsg('user', '🎤 spoken message');
  const entry = { role: 'user', content: '<audio>' };
  const convId = currentConversationId;
  messages.push(entry);
  runChat({
    idle: false,
    audio: b64,
    onOverheard: () => dropUserTurn(bubble, entry),
    onAudioUnsupported: () => {
      dropUserTurn(bubble, entry);
      if (onUnsupported) onUnsupported();
    },
  });
  return {
    setTranscript(text) {
      if (!messages.includes(entry)) return;
      entry.content = text;
      bubble.textContent = '🎤 ' + text;
      if (convId == null) return;
      // chat.php inserts the <audio> row before it starts streaming,
      // whisper on CPU is slower than that, but a 404 here just means
      // it wasn't yet. one retry covers it.
      const post = () => fetch(`api/conversations.php?action=set_audio_text&id=${encodeURIComponent(convId)}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      post().then(r => { if (r.status === 404) setTimeout(post, 1500); }).catch(() => {});
    },
  };
}

// she called enter_shop / enter_karaoke. the page flips once her
// line is done playing, so the trip doesn't guillotine her
// mid-sentence. the floor is for TTS off, so the line is at least
// readable before it's gone.
function leaveFor(where) {
  const href = where === 'karaoke' ? 'karaoke.html' : 'wardrobe.html';
  const t0 = Date.now();
  const tick = () => {
    if ((window.TTS && TTS.isSpeaking()) || Date.now() - t0 < 1500) return setTimeout(tick, 250);
    location.href = href;
  };
  tick();
}

export function runChat({ idle, ephemeral, audio, voice, onOverheard, onAudioUnsupported }) {
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
  let overheard = false;
  let trip = '';
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

  // guess the reply's language off Anon's message so the pocket-tts
  // model can warm up while she writes. this ONLY picks the voice,
  // the guess never reaches the model, she works out Anon's
  // language from the conversation herself.
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
      outfit_context: Outfit.describe(),
      mod_items: window.Mods && Mods.itemNames ? Mods.itemNames() : [],
      conversation_id: currentConversationId,
      idle: !!idle, ephemeral: !!ephemeral, client_time: localTimeString(),
      audio, voice: !!voice,
      hear_all: !!(window.Voice && Voice.hearAll && Voice.hearAll()) },
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
      // deliberately NOT behind isCurrent(). the server has already
      // written this change, so dropping it because the user opened
      // another chat leaves the model wearing one thing and the
      // database saying another.
      onOutfit: (change) => Outfit.applyToolChange(change),
      onGo: (where) => { trip = where; },
      onSilence: (s) => {
        if (!isCurrent()) return;
        // she decided to say nothing, so whatever leaked into the bubble
        // first never happened. drop it and mark the turn instead.
        silenced = true;
        if (window.TTS) TTS.stop();
        hideFaceBubble();
        visible = '';
        shown = '';
        typing.remove();
        // overheard = he wasn't talking to her. no marker either, the
        // whole exchange goes, his bubble included
        if (s && s.overheard && onOverheard) {
          overheard = true;
          draft.remove();
          onOverheard();
          return;
        }
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
          // the flushes above can still push held back bytes. none of it
          // exists
          visible = '';
          shown = '';
          if (window.TTS) TTS.stop();
          if (!overheard) messages.push({ role: 'assistant', content: '...' });
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
        if (trip) leaveFor(trip);
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
          // here either. wire-voice decides what happens to the wav
          if (onAudioUnsupported) onAudioUnsupported();
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

  // load avatar features after auth. devhud.js owns Ctrl+Shift+D,
  // so only admins get that script.
  await loadScripts([
    ['vendor/pixi.min.js', 'vendor/live2dcubismcore.min.js',
     'vendor/marked.min.js', 'vendor/purify.min.js?v=4',
     'js/actions.js?v=4', 'js/outfit.js?v=21', 'js/touch.js?v=3',
     'js/mods.js?v=14', 'js/tts.js?v=3', 'js/voice.js?v=10',
     'js/voicemode.js?v=3', 'js/trip-loader.js?v=3',
     ...(currentUser?.role === 'admin' ? ['js/devhud.js?v=3'] : []),
     'js/wardrobe-open-lines.js?v=3', 'js/wardrobe-reactions.js?v=4',
     'js/wardrobe-return-lines.js?v=3'],
    ['vendor/cubism4.min.js', 'vendor/pixi-unsafe-eval.min.js'],
  ]);
  // live2d.js is an ES module so it can't go in a loadScripts
  // group, and it rips PIXI.live2d apart the moment it runs. that's
  // what the await is for.
  await import('./live2d.js?v=10');

  // both of these set up a global that loads late, so they can't
  // run at module scope anymore. they'd just silently do nothing
  // before the load.
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

  // coming back from the wardrobe, the return cutscene REPLACES the
  // boot terminal. skipping BootFX.start also makes BootFX.finish a
  // no-op later.
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
    showBoot();
  }

  const emailEl = document.getElementById('userEmail');
  if (me.user && emailEl) emailEl.textContent = me.user.email || '';

  // fill in the synced preferences BEFORE any module reads its
  // local keys
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
  // lock the composer up front until the first status check
  // answers, but leave the banner alone. it only ever speaks for
  // something the server actually said is true, so a normal load
  // never flashes a consolidation notice and then takes it back.
  chatInput.disabled = true;
  sendBtn.disabled = true;
  await syncConsolidationStatus();
  // the wardrobe is the same session. time in there is NOT an
  // absence.
  if (!fromWardrobe) await fetchWelcome();
  reportActivity(true);
  // fetch gauges before Live2D.init so the empty-state greeting
  // does not wait on .moc3 with neutral values. setMood can park
  // values before init, and startIdle applies the baseline.
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
  // hide the shared hf.co/efficiencyx/ prefix in labels only.
  // requests still need the full model name.
  const shortName = (n) => n.replace(/^hf\.co\/[^/]+\//, '');
  modelSelect.innerHTML = m.models.map(n =>
    `<option value="${escapeHtml(n)}">${escapeHtml(shortName(n))}</option>`).join('');
  const prefer = [
    'hf.co/efficiencyx/Jun-LoRA-12B-GGUF:Q8_0',
    'hf.co/efficiencyx/Jun-LoRA-12B-GGUF:Q6_K',
    'hf.co/efficiencyx/Jun-LoRA-12B-GGUF:Q4_K_M',
    'hf.co/efficiencyx/Jun-LoRA-E4B-GGUF:Q8_0',
    'hf.co/efficiencyx/Jun-LoRA-E4B-GGUF:Q6_K',
    'hf.co/efficiencyx/Jun-LoRA-E4B-GGUF:Q4_K_M',
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
