import { armIdleAfterReply, cancelActiveIdleNudge, cancelAutoReset, cancelIdleNudge, composerPlaceholder, consolidating, fleeActive, reportActivity, resetIdleNudge, scheduleAutoReset, setCancelActiveIdleNudge, setConsolidating, showConsolidatingBubble, startFleeLock, syncConsolidationStatus } from './consolidation.js?v=19';
import { chatInput, debugSystemPromptEl, messagesEl, modelSelect, reasoningSelect, sendBtn, sendButtonIdleMarkup, sendButtonStopMarkup, thinkChk } from './dom.js?v=11';
import { announceMobileReply, hideFaceBubble, scheduleFaceBubbleHide, setLatestAssistantReply, showFaceBubble } from './face-bubble.js?v=18';
import { appendRaw, logToolStatus } from './logging.js?v=11';
import { loadMood } from './mood.js?v=18';
import { refreshSidebar } from './sidebar.js?v=19';
import { makeNameFilter, makeStreamBuffer } from './stream-filters.js?v=18';
import { localTimeString, phoneMode } from '../core/util.js?v=1';
import * as Names from '../core/names.js?v=1';
import * as ui from '../core/ui.js?v=1';
import * as ChatAPI from '../core/chat-api.js?v=2';
import * as Mods from '../mods/mods.js?v=3';
import * as Outfit from '../outfit/outfit.js?v=3';
import * as Cards from './cards.js?v=2';
import * as History from './history.js?v=1';
import * as TTS from '../voice/tts.js?v=2';
import * as Voice from '../voice/voice.js?v=2';
import * as VoiceMode from '../voice/voicemode.js?v=2';
import { DevHud, abortFn, currentConversationId, messages, setAbortFn, setRenderVoiceDraft, setStopActiveStream, stopActiveStream } from './session.js?v=1';
import { appendMsg, renderMarkdown, updateEmptyState } from './messages.js?v=1';

let chatGeneration = 0;
let activeBubbleStream = null;

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

// the button handler passes the click event here, so anything
// that isn't {voice:true} is a typed turn
export function sendMessage(opts) {
  const voice = !!(opts && opts.voice === true);
  const invite = opts && typeof opts.invite === 'string' ? opts.invite : '';
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
  const entry = { role: 'user', content: Names.canonicalize(text) };
  messages.push(entry);
  runChat({ idle: false, voice, invite, onOverheard: voice ? () => dropUserTurn(bubble, entry) : null });
}

// she heard him talk to someone else. the turn never happened,
// on screen or in history, the server already dropped its row
function dropUserTurn(bubble, entry) {
  bubble.remove();
  const i = messages.indexOf(entry);
  if (i !== -1) messages.splice(i, 1);
  updateEmptyState();
}

// onReply gets her visible text once the turn settles (empty on
// error or stop). the card table reads its hit/stand off it
export function sendTouchEvent(text, onReply) {
  if (abortFn || fleeActive()) return false;
  resetIdleNudge();
  reportActivity();
  messages.push({ role: 'user', content: text });
  runChat({ idle: false, ephemeral: true, onReply });
  return true;
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
      // chat.php inserts the <audio> row before it starts
      // streaming, and whisper on CPU is almost always slower than
      // that. a 404 here just means the row isn't there yet, one
      // retry covers it.
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

// she called enter_shop / enter_karaoke / go_out_to_eat. the page
// flips once her line is done playing, so the trip doesn't
// guillotine her mid-sentence. the 1.5s floor is for TTS off, so
// the line is at least readable before it's gone.
function leaveFor(where) {
  const href = { karaoke: 'karaoke.html', date: 'date.html' }[where] || 'wardrobe.html';
  const t0 = Date.now();
  const tick = () => {
    if (TTS.isSpeaking() || Date.now() - t0 < 1500) return setTimeout(tick, 250);
    location.href = href;
  };
  tick();
}

export function runChat({ idle, ephemeral, audio, voice, invite = '', onOverheard, onAudioUnsupported, onReply }) {
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
  let replied = false;
  const reply = (text) => {
    if (replied || !onReply) return;
    replied = true;
    onReply(text);
  };
  const bubbleSource = ephemeral ? 'ephemeral' : 'phone';
  const bubbleEnabled = () => !VoiceMode.isActive() && (ephemeral || phoneMode());
  const renderBubble = () => {
    if (!shown.trim() || !bubbleEnabled()) return;
    showFaceBubble(renderMarkdown(shown), bubbleSource);
  };
  const bubbleStream = { ephemeral: !!ephemeral, render: renderBubble, text: () => shown };
  activeBubbleStream = bubbleStream;
  const names = makeNameFilter(sub => {
    shown += sub;
    if (!VoiceMode.isActive()) {
      body.innerHTML = renderMarkdown(shown);
      body.appendChild(typing);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    renderBubble();
    TTS.feed(sub);
  });
  setRenderVoiceDraft(() => {
    body.innerHTML = renderMarkdown(shown);
    if (abortFn) body.appendChild(typing);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
  const stream = makeStreamBuffer(clean => {
    visible += clean;
    names.push(clean);
  });

  sendBtn.disabled = false;
  sendBtn.innerHTML = sendButtonStopMarkup;
  sendBtn.setAttribute('aria-label', 'Stop response');

  setStopActiveStream((discard = false) => {
    if (!isCurrent()) return;
    chatGeneration++;
    if (abortFn) abortFn();
    TTS.stop();
    typing.remove();
    if (!discard && visible.trim()) messages.push({ role: 'assistant', content: visible });
    else draft.remove();
    finalize(!discard);
    reply(discard ? '' : visible);
    ui.setStatus('idle', 'idle');
    updateEmptyState();
    if (!discard) {
      scheduleAutoReset();
      armIdleAfterReply();
    }
  });
  const onClickStop = () => stopActiveStream();
  sendBtn.addEventListener('click', onClickStop, { once: true });

  setCancelActiveIdleNudge(idle ? () => {
    if (!isCurrent()) return;
    chatGeneration++;
    if (abortFn) abortFn();
    TTS.stop();
    typing.remove();
    draft.remove();
    updateEmptyState();
    finalize(false);
  } : null);

  ui.setStatus('streaming', 'streaming');
  if (DevHud) DevHud.beginGen();
  appendRaw('--- ' + new Date().toLocaleTimeString() + (idle ? ' (idle nudge)' : '') + ' ---\n');

  // guess the reply's language off Anon's message so the pocket-tts
  // model can warm up while she writes. this ONLY picks the voice,
  // the guess never reaches the model, she works out Anon's
  // language from the conversation herself.
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const predicted = TTS.predictLang(lastUser ? lastUser.content : '');
  if (predicted) {
    TTS.setReplyLang(predicted);
    TTS.warmLang(predicted);
  }

  setAbortFn(ChatAPI.chat(
    { messages: [...messages], model: modelSelect.value,
      reasoning: reasoningSelect.value, think: thinkChk.checked,
      outfit_context: Outfit.describe(),
      mod_items: Mods.itemNames(),
      conversation_id: currentConversationId,
      idle: !!idle, ephemeral: !!ephemeral, client_time: localTimeString(),
      audio, voice: !!voice, invite,
      hear_all: !!Voice.hearAll() },
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
        if (DevHud) DevHud.setGenStats(s);
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
        TTS.stop();
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
        draft.textContent = Names.getBot() + ' says nothing.';
      },
      onFled: (info) => {
        if (!isCurrent()) return;
        startFleeLock((info.until || 0) * 1000, info.reason);
      },
      onThinking: (t) => {
        if (!isCurrent()) return;
        if (DevHud) DevHud.tickToken();
        appendRaw(t);
        pushThinking(t);
      },
      onToken: (tok) => {
        if (!isCurrent()) return;
        settleThinking();
        if (DevHud) DevHud.tickToken();
        appendRaw(tok);
        stream.push(tok);
      },
      onDone: async () => {
        if (!isCurrent()) return;
        stream.flush();
        names.flush();
        settleThinking();
        TTS.flush();
        typing.remove();
        if (silenced) {
          // the flushes above can still push held back bytes. none of it
          // exists
          visible = '';
          shown = '';
          TTS.stop();
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
        if (!ephemeral && currentConversationId) {
          History.compact(currentConversationId).catch(() => {});
        }
        reply(silenced ? '' : visible);
        await refreshSidebar();
        if (trip === 'cards') Cards.open();
        else if (trip) leaveFor(trip);
      },
      onError: async (err) => {
        if (!isCurrent()) return;
        stream.flush();
        names.flush();
        TTS.flush();
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
        reply('');
        updateEmptyState();
        scheduleAutoReset();
        armIdleAfterReply();
        await refreshSidebar();
      },
    }
  ));

  function finalize(present = true) {
    setAbortFn(null);
    if (activeBubbleStream === bubbleStream) activeBubbleStream = null;
    if (present && shown.trim()) {
      if (!ephemeral) setLatestAssistantReply(shown);
      if (bubbleEnabled()) {
        renderBubble();
        if (!ephemeral) announceMobileReply(shown);
        scheduleFaceBubbleHide(shown, bubbleSource);
      }
    }
    if (VoiceMode.isActive()) body.innerHTML = renderMarkdown(shown);
    setRenderVoiceDraft(null);
    setCancelActiveIdleNudge(null);
    setStopActiveStream(null);
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
  setAbortFn(null);
  TTS.stop();
  activeBubbleStream = null;
  setCancelActiveIdleNudge(null);
  setRenderVoiceDraft(null);
  sendBtn.disabled = consolidating || fleeActive();
  sendBtn.innerHTML = sendButtonIdleMarkup;
  sendBtn.setAttribute('aria-label', 'Send');
  ui.setStatus('idle', 'idle');
}

export function rerenderBubbleStream(isPhone) {
  if (activeBubbleStream && (isPhone || activeBubbleStream.ephemeral)) activeBubbleStream.render();
}
