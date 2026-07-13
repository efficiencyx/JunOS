// Bootstrap + chat loop. Streams tokens, parses [ACTION:...] inline,
// dispatches to Live2D as soon as a complete action block is seen.

(function () {
  const messagesEl = document.getElementById('messages');
  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const modelSelect = document.getElementById('modelSelect');
  const reasoningSelect = document.getElementById('reasoningSelect');
  const thinkChk = document.getElementById('thinkChk');
  const reloadPromptBtn = document.getElementById('reloadPromptBtn');
  const actionLogEl = document.getElementById('actionLog');
  const actionLogCount = document.getElementById('actionLogCount');
  const missingParamsEl = document.getElementById('missingParams');
  const rawStreamEl = document.getElementById('rawStream');
  const clearRawBtn = document.getElementById('clearRawBtn');
  const debugSystemPromptEl = document.getElementById('debugSystemPrompt');
  const moodInputs = {
    affection: document.getElementById('moodAffection'),
    trust: document.getElementById('moodTrust'),
    tension: document.getElementById('moodTension'),
  };
  const moodVals = {
    affection: document.getElementById('moodAffectionVal'),
    trust: document.getElementById('moodTrustVal'),
    tension: document.getElementById('moodTensionVal'),
  };
  const moodRefreshBtn = document.getElementById('moodRefreshBtn');
  const stageEl = document.getElementById('stage');
  const stageStatus = document.getElementById('stageStatus');
  const stageSkeleton = document.getElementById('stageSkeleton');
  const resetLive2DBtn = document.getElementById('resetLive2DBtn');
  const ttsChk = document.getElementById('ttsChk');
  const ttsEngineSelect = document.getElementById('ttsEngineSelect');
  const ttsVoiceSelect = document.getElementById('ttsVoiceSelect');
  const ttsSpeedInput = document.getElementById('ttsSpeed');
  const messagesEmpty = document.getElementById('messagesEmpty');
  const openSettingsBtn = document.getElementById('openSettingsBtn');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const drawerBackdrop = document.getElementById('drawerBackdrop');

  const messages = []; // {role:'user'|'assistant', content:string}
  let logCount = 0;
  let abortFn = null;
  let autoResetTimer = null;
  let currentConversationId = null;

  const AUTO_RESET_MS = 3000;

  // Idle nudge: if Anon goes quiet, prompt Jun to speak first. The reply timer is
  // armed only once the model finishes streaming (in onDone/onError), so a long
  // reply can't trip it early. 60s after a reply lands, or 45s after the app is
  // ready / a conversation is opened. Capped so Jun doesn't keep talking to an
  // empty room forever - resets when Anon interacts.
  const IDLE_AFTER_REPLY_MS = 60000;
  const IDLE_AFTER_JOIN_MS  = 45000;
  const TYPING_POLL_MS = 5000;
  const MAX_IDLE_NUDGES = 3;
  let idleTimer = null;
  let idleNudgeStreak = 0;
  // Set while an *idle nudge* is streaming: lets a real user send abort it cleanly
  // (rather than being swallowed) so Anon's message wins instead of doubling up.
  let cancelActiveIdleNudge = null;

  function cancelIdleNudge() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  function resetIdleNudge() {
    idleNudgeStreak = 0;
    cancelIdleNudge();
  }

  function scheduleIdleNudge(delayMs) {
    cancelIdleNudge();
    if (!currentConversationId) return;          // need a conversation to speak in
    if (idleNudgeStreak >= MAX_IDLE_NUDGES) return; // gave up until Anon interacts
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (abortFn) return;                 // a stream is running; it re-arms on done
      if (document.hidden) { scheduleIdleNudge(delayMs); return; } // tab hidden, recheck later
      // Anon has a half-written message sitting in the box - he's composing, not
      // idle. Don't talk over him; check again later.
      if (chatInput.value.trim() !== '') { scheduleIdleNudge(delayMs); return; }
      idleNudgeStreak++;
      runChat({ idle: true });
    }, delayMs);
  }

  // Start the post-reply idle clock from when Jun *stops talking*, not when the text
  // finished streaming: with TTS on (and especially with thinking, where replies run
  // long) she keeps speaking for many seconds after the stream ends, which would
  // otherwise eat most of the idle window. When she's still speaking, defer to the
  // TTS drain callback below; otherwise arm immediately as before.
  function armIdleAfterReply() {
    if (window.TTS && TTS.isSpeaking && TTS.isSpeaking()) return;
    scheduleIdleNudge(IDLE_AFTER_REPLY_MS);
  }

  function cancelAutoReset() {
    if (autoResetTimer) { clearTimeout(autoResetTimer); autoResetTimer = null; }
  }

  function scheduleAutoReset() {
    cancelAutoReset();
    autoResetTimer = setTimeout(() => {
      autoResetTimer = null;
      Live2D.resetIdle();
      Live2D.startIdle();
      logAction('ok', '↺ auto reset pose (idle)');
    }, AUTO_RESET_MS);
  }

  if (window.marked) {
    marked.setOptions({ gfm: true, breaks: true });
  }

  function renderMarkdown(text) {
    if (!window.marked) return escapeHtml(text);
    const html = marked.parse(text || '');
    return window.DOMPurify ? DOMPurify.sanitize(html) : html;
  }

  function appendMsg(role, content) {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
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

  function updateEmptyState() {
    if (!messagesEmpty) return;
    if (messagesEl.children.length > 0) {
      messagesEmpty.classList.add('hidden');
    } else {
      messagesEmpty.classList.remove('hidden');
    }
  }

  function logAction(level, text) {
    logCount++;
    actionLogCount.textContent = logCount;
    const row = document.createElement('div');
    row.className = 'row';
    const ts = new Date().toLocaleTimeString();
    row.innerHTML = `<span class="ts">${ts}</span> <span class="${level}">${escapeHtml(text)}</span>`;
    actionLogEl.appendChild(row);
    actionLogEl.scrollTop = actionLogEl.scrollHeight;
  }

  function logMissing(param) {
    const row = document.createElement('div');
    row.className = 'row warn';
    row.textContent = `param mancante: ${param}`;
    missingParamsEl.appendChild(row);
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function setStageStatus(text, isError) {
    if (!text) { stageStatus.classList.add('hidden'); return; }
    stageStatus.classList.remove('hidden');
    stageStatus.classList.toggle('error', !!isError);
    stageStatus.textContent = text;
  }

  // Inline action-tag extraction from the streaming text. Accumulate text, dispatch
  // complete actions (closed by ']'), and hold back any tail that could be the start of
  // a marker so it isn't emitted as visible text until we know whether it's an action.
  // Whitespace-tolerant and case-insensitive. Accepts the compact [A: marker plus the
  // legacy [ACTION: / [ACTIONS: forms still present in stored history and the fine-tune.
  const MARK_RE = /\[\s*A(?:CTIONS?)?\s*:/i;
  // Trailing partial that could still grow into MARK_RE. Anchored at end-of-string.
  const PARTIAL_RE = /\[\s*(?:A(?:C(?:T(?:I(?:O(?:N(?:S)?)?)?)?)?)?\s*)?$/i;

  function findMark(s, from = 0) {
    const m = s.slice(from).match(MARK_RE);
    return m ? from + m.index : -1;
  }

  function pendingMarkerSuffix(s) {
    const m = s.match(PARTIAL_RE);
    return m ? m[0].length : 0;
  }

  function makeStreamBuffer(onCleanText) {
    let buf = '';
    return {
      push(chunk) {
        buf += chunk;
        while (true) {
          const start = findMark(buf);
          if (start < 0) {
            // No marker yet. Emit what we have, except a possible partial marker tail.
            const hold = pendingMarkerSuffix(buf);
            if (buf.length > hold) {
              onCleanText(buf.slice(0, buf.length - hold));
              buf = buf.slice(buf.length - hold);
            }
            break;
          }
          // Emit text before the marker.
          if (start > 0) {
            onCleanText(buf.slice(0, start));
            buf = buf.slice(start);
          }
          // buf starts with MARK. Look for closing ']'.
          const end = buf.indexOf(']');
          if (end < 0) break; // wait for more
          const blob = buf.slice(0, end + 1);
          buf = buf.slice(end + 1);
          const acts = Actions.parseActions(blob);
          if (acts.length === 0) {
            // Malformed but well-bracketed: log so we can see it, don't show in chat.
            logAction('warn', 'block non parsabile: ' + blob);
          } else {
            for (const a of acts) Actions.applyAction(a);
          }
        }
      },
      flush() {
        if (buf.length) {
          // Drop a dangling unclosed action tag, emit everything else.
          const start = findMark(buf);
          if (start >= 0) onCleanText(buf.slice(0, start));
          else onCleanText(buf);
          buf = '';
        }
      },
    };
  }

  // Second stage after makeStreamBuffer: resolve {f_playerName}/{f_botName} to the
  // user's chosen names. Buffers a trailing partial placeholder across chunks so a
  // split token (e.g. "{f_play" + "erName}") substitutes cleanly and never flashes
  // its raw form in the chat or gets read aloud by TTS.
  function makeNameFilter(emit) {
    let buf = '';
    return {
      push(chunk) {
        buf += chunk;
        const hold = window.Names ? Names.pendingPartial(buf) : 0;
        if (buf.length > hold) {
          const out = buf.slice(0, buf.length - hold);
          emit(window.Names ? Names.apply(out) : out);
          buf = buf.slice(buf.length - hold);
        }
      },
      flush() {
        if (buf.length) {
          emit(window.Names ? Names.apply(buf) : buf);
          buf = '';
        }
      },
    };
  }

  function sendMessage() {
    const text = chatInput.value.trim();
    if (!text) return;
    // If a stream is in flight, only an *idle nudge* may be interrupted - abort it
    // so Anon's real message wins. A genuine reply in progress is left alone.
    if (abortFn) {
      if (!cancelActiveIdleNudge) return;
      cancelActiveIdleNudge();
    }
    resetIdleNudge(); // Anon spoke - Jun is allowed to nudge again later
    chatInput.value = '';
    appendMsg('user', text);
    messages.push({ role: 'user', content: text });
    runChat({ idle: false });
  }

  // Core streaming loop. `idle` requests are unprompted (no user turn): the backend
  // injects a stage-direction so Jun speaks first, and we don't add a user bubble.
  function runChat({ idle }) {
    if (abortFn) return;
    cancelIdleNudge();
    cancelAutoReset();

    const draft = appendMsg('assistant', '');
    // Reply text renders into its own body element so the thinking panel above it
    // survives the per-token innerHTML rewrite.
    const body = document.createElement('div');
    body.className = 'msg-body';
    draft.appendChild(body);
    const typing = document.createElement('span');
    typing.className = 'typing';
    body.appendChild(typing);

    // Lazily created the first time a thinking token arrives (only when Think is on).
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

    // `visible` is the raw, action-stripped text WITH {f_*} name placeholders left
    // intact - that's what we store in history so the model keeps seeing the
    // placeholders it was trained on. `shown` is the name-resolved text that the
    // user actually reads and hears; the name filter substitutes between them.
    let visible = '';
    let shown = '';
    const names = makeNameFilter(sub => {
      shown += sub;
      body.innerHTML = renderMarkdown(shown);
      body.appendChild(typing);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      if (window.TTS) TTS.feed(sub);
    });
    const stream = makeStreamBuffer(clean => {
      visible += clean;
      names.push(clean);
    });

    sendBtn.disabled = true;
    sendBtn.textContent = 'Stop';
    const onClickStop = () => {
      if (abortFn) abortFn();
      if (window.TTS) TTS.stop();
    };
    sendBtn.addEventListener('click', onClickStop, { once: true });

    // Idle nudges are interruptible: if Anon sends while this is streaming, drop the
    // half-rendered nudge bubble and clean up so his message takes over.
    cancelActiveIdleNudge = idle ? () => {
      if (abortFn) abortFn();
      if (window.TTS) TTS.stop();
      typing.remove();
      draft.remove();
      updateEmptyState();
      finalize();
    } : null;

    ui.setStatus('streaming', 'streaming');
    if (window.DevHud) DevHud.beginGen();
    appendRaw('--- ' + new Date().toLocaleTimeString() + (idle ? ' (idle nudge)' : '') + ' ---\n');
    abortFn = Ollama.chat(
      { messages: [...messages], model: modelSelect.value,
        reasoning: reasoningSelect.value, think: thinkChk.checked,
        outfit_context: Outfit.describe(), conversation_id: currentConversationId,
        idle: !!idle, client_time: localTimeString() },
      {
        onDebug: (dbg) => {
          if (dbg && typeof dbg.system_prompt === 'string') {
            debugSystemPromptEl.textContent = dbg.system_prompt
              + (typeof dbg.live_context === 'string'
                  ? '\n\n========== LIVE CONTEXT (trailing system message) ==========\n\n' + dbg.live_context
                  : '');
          }
        },
        onStats: (s) => { if (window.DevHud) DevHud.setGenStats(s); },
        onThinking: (t) => { appendRaw(t); pushThinking(t); },
        onToken: (tok) => { settleThinking(); if (window.DevHud) DevHud.tickToken(); appendRaw(tok); stream.push(tok); },
        onDone: async () => {
          stream.flush();
          names.flush();
          settleThinking();
          if (window.TTS) TTS.flush();
          typing.remove();
          if (visible.trim()) messages.push({ role: 'assistant', content: visible });
          else draft.remove();
          finalize();
          ui.setStatus('idle', 'idle');
          updateEmptyState();
          scheduleAutoReset();
          armIdleAfterReply();
          // Jun may have nudged her mood this turn; refresh the dev panel if open.
          if (moodInputs.affection && moodInputs.affection.offsetParent !== null) loadMood();
          if (window.History) await refreshSidebar();
        },
        onError: async (err) => {
          stream.flush();
          names.flush();
          if (window.TTS) TTS.flush();
          typing.remove();
          if (!visible.trim()) draft.remove();
          ui.toast('⚠ ' + err.message, 'error');
          ui.setStatus('error', 'error');
          finalize();
          updateEmptyState();
          scheduleAutoReset();
          armIdleAfterReply();
          if (window.History) await refreshSidebar();
        },
      }
    );

    function finalize() {
      abortFn = null;
      cancelActiveIdleNudge = null;
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
      sendBtn.removeEventListener('click', onClickStop);
    }
  }

  async function refreshSidebar() {
    if (!window.History) return;
    const ul = document.getElementById('conversationList');
    if (!ul) return;
    let convs;
    try { convs = await History.list(); } catch (e) { return; }
    ul.innerHTML = '';
    for (const c of convs) {
      const li = document.createElement('li');
      li.className = 'conv-item' + (c.id === currentConversationId ? ' active' : '');
      li.dataset.id = String(c.id);
      const title = c.title || 'New conversation';
      li.innerHTML = `<span class="conv-title">${escapeHtml(title)}</span>`
        + `<button class="conv-delete" type="button" title="Delete conversation" aria-label="Delete conversation">`
        + `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>`
        + `</button>`;
      li.addEventListener('click', () => loadConversation(c.id));
      const delBtn = li.querySelector('.conv-delete');
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteConversation(c.id, title);
      });
      ul.appendChild(li);
    }
  }

  async function deleteConversation(id, title) {
    if (!window.History) return;
    const ok = await ui.confirm({
      title: 'Delete chat',
      message: `Do you want to delete Jun's memory of "${title}"?`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    try {
      await History.delete(id);
      if (id === currentConversationId) {
        const convs = await History.list();
        if (convs.length > 0) {
          await refreshSidebar();
          await loadConversation(convs[0].id);
        } else {
          const { id: newId } = await History.create();
          await refreshSidebar();
          await loadConversation(newId);
        }
      } else {
        await refreshSidebar();
      }
    } catch (e) {
      ui.toast('Failed to delete conversation: ' + e.message, 'error');
    }
  }

  function markSidebarActive(id) {
    document.querySelectorAll('#conversationList .conv-item').forEach(el => {
      el.classList.toggle('active', Number(el.dataset.id) === id);
    });
  }

  async function loadConversation(id) {
    currentConversationId = id;
    cancelAutoReset();
    resetIdleNudge(); // fresh context - let Jun nudge again
    if (window.TTS) TTS.stop();
    messages.length = 0;
    messagesEl.innerHTML = '';
    updateEmptyState();
    Live2D.resetIdle();
    Live2D.startIdle();
    markSidebarActive(id);
    scheduleIdleNudge(IDLE_AFTER_JOIN_MS);
    if (!window.History) return;
    try {
      const rows = await History.load(id);
      for (const row of rows) {
        if (row.role === 'user') {
          appendMsg('user', row.content);
          messages.push({ role: 'user', content: row.content });
        } else if (row.role === 'assistant') {
          const el = appendMsg('assistant', '');
          let visible = '';
          const sb = makeStreamBuffer(clean => { visible += clean; });
          sb.push(row.content);
          sb.flush();
          // Render with names resolved; keep the raw placeholders in history.
          el.innerHTML = renderMarkdown(window.Names ? Names.apply(visible) : visible);
          messages.push({ role: 'assistant', content: visible });
        }
      }
    } catch (e) {
      ui.toast('Failed to load conversation: ' + e.message, 'error');
    }
  }

  // In "auto" mode the server decides whether to think, so the manual Think
  // toggle does nothing - grey it out to make that obvious.
  function syncThinkToggle() {
    thinkChk.disabled = reasoningSelect.value === 'auto';
  }
  reasoningSelect.addEventListener('change', syncThinkToggle);
  syncThinkToggle();

  // Persist model settings so they survive reloads / follow the account.
  function persistPref(key, value) {
    localStorage.setItem(key, value);
    if (window.Prefs) Prefs.pushToServer();
  }
  modelSelect.addEventListener('change', () => persistPref('model', modelSelect.value));
  reasoningSelect.addEventListener('change', () => persistPref('reasoning_level', reasoningSelect.value));
  thinkChk.addEventListener('change', () => persistPref('think', thinkChk.checked ? '1' : '0'));

  sendBtn.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  // Typing counts as activity: reset the streak and push the idle nudge back.
  chatInput.addEventListener('input', () => {
    if (abortFn) return;
    idleNudgeStreak = 0;
    scheduleIdleNudge(IDLE_AFTER_REPLY_MS);
  });
  // Poll every 5s: while a draft is sitting in the box, Anon is mid-composition,
  // so keep pushing the nudge back rather than interrupting them.
  setInterval(() => {
    if (abortFn || !currentConversationId) return;
    if (chatInput.value.trim() === '') return;
    idleNudgeStreak = 0;
    scheduleIdleNudge(IDLE_AFTER_REPLY_MS);
  }, TYPING_POLL_MS);

  // Human-readable local time from the user's browser (its clock + timezone),
  // sent to the backend so the model's "current time" matches the user, not the server.
  function localTimeString() {
    try {
      return new Date().toLocaleString(undefined, {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
      });
    } catch (e) {
      return new Date().toString();
    }
  }

  function appendRaw(text) {
    rawStreamEl.append(document.createTextNode(text));
    rawStreamEl.scrollTop = rawStreamEl.scrollHeight;
  }
  clearRawBtn.addEventListener('click', () => { rawStreamEl.textContent = ''; });

  const newChatBtn = document.getElementById('newChatBtn');
  if (newChatBtn) {
    newChatBtn.addEventListener('click', async () => {
      if (!window.History) return;
      try {
        const { id } = await History.create();
        await refreshSidebar();
        await loadConversation(id);
      } catch (e) {
        ui.toast('Failed to create conversation: ' + e.message, 'error');
      }
    });
  }

  resetLive2DBtn.addEventListener('click', () => {
    cancelAutoReset();
    Live2D.resetIdle();
    Live2D.startIdle();
    logAction('ok', '↺ reset pose');
  });

  reloadPromptBtn.addEventListener('click', () => {
    // Server reads prompt fresh each request, so this is mostly a hint.
    logAction('ok', 'system prompt will be reloaded on next send');
  });

  // Persona name fields: prefill from the current names, persist + sync on change,
  // and re-render the open conversation so existing bubbles pick up the new name.
  // Called once during bootstrap, after Names.load().
  function wireNameSettings() {
    const playerInput = document.getElementById('playerNameInput');
    const botInput = document.getElementById('botNameInput');
    if (!window.Names) return;
    if (playerInput) { playerInput.value = Names.getPlayer(); playerInput.placeholder = Names.DEFAULT_PLAYER; }
    if (botInput) { botInput.value = Names.getBot(); botInput.placeholder = Names.DEFAULT_BOT; }
    function commit() {
      if (playerInput) Names.setPlayer(playerInput.value);
      if (botInput) Names.setBot(botInput.value);
      // Reflect normalization (blank reverts to the default cast).
      if (playerInput) playerInput.value = Names.getPlayer();
      if (botInput) botInput.value = Names.getBot();
      if (window.Prefs) Prefs.pushToServer();
      // Repaint already-rendered bubbles with the new names; skip mid-stream.
      if (!abortFn && currentConversationId != null) loadConversation(currentConversationId);
    }
    if (playerInput) playerInput.addEventListener('change', commit);
    if (botInput) botInput.addEventListener('change', commit);
  }

  // Settings drawer
  if (openSettingsBtn) openSettingsBtn.addEventListener('click', () => ui.toggleDrawer(true));
  if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', () => ui.toggleDrawer(false));
  if (drawerBackdrop) drawerBackdrop.addEventListener('click', () => ui.toggleDrawer(false));

  const userChipBtn = document.getElementById('userChipBtn');
  if (userChipBtn) userChipBtn.addEventListener('click', () => ui.toggleDrawer(true));

  // Settings modal: switch category panels via the left nav.
  const settingsNavItems = document.querySelectorAll('.settings-navitem');
  const settingsPanels = document.querySelectorAll('.settings-panel');
  const settingsPanelTitle = document.getElementById('settingsPanelTitle');
  settingsNavItems.forEach((item) => {
    item.addEventListener('click', () => {
      const key = item.dataset.panel;
      settingsNavItems.forEach((n) => {
        const on = n === item;
        n.classList.toggle('active', on);
        n.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      settingsPanels.forEach((p) => { p.hidden = p.dataset.panel !== key; });
      const label = item.querySelector('span');
      if (settingsPanelTitle && label) settingsPanelTitle.textContent = label.textContent;
      if (key === 'developer') loadMood(); // pull fresh scores when the panel opens
      if (key === 'memory') loadMemories();
    });
  });

  // Memory panel: list / add / delete the durable notes memory_write saves.
  const memoryList = document.getElementById('memoryList');
  const memoryCount = document.getElementById('memoryCount');
  async function loadMemories() {
    if (!memoryList) return;
    memoryList.textContent = 'Loading…';
    try {
      const r = await fetch('/api/memory.php', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('http ' + r.status);
      renderMemories((await r.json()).memories || []);
    } catch (e) {
      memoryList.textContent = 'Could not load memories.';
    }
  }
  function renderMemories(items) {
    if (memoryCount) memoryCount.textContent = items.length;
    memoryList.replaceChildren();
    if (!items.length) {
      memoryList.textContent = 'No memories yet. Ask Jun to remember something, or add one below.';
      return;
    }
    for (const m of items.slice().reverse()) {
      const row = document.createElement('div');
      row.className = 'memory-item';
      const meta = document.createElement('div');
      meta.className = 'memory-meta';
      const date = m.created_at ? new Date(m.created_at * 1000).toLocaleDateString() : '';
      meta.textContent = `${date} · ${m.category}`;
      const text = document.createElement('div');
      text.className = 'memory-text';
      text.textContent = m.memory;
      const del = document.createElement('button');
      del.className = 'ghost memory-del';
      del.title = 'Delete this memory';
      del.setAttribute('aria-label', 'Delete memory');
      del.textContent = '✕';
      del.addEventListener('click', async () => {
        del.disabled = true;
        try {
          const r = await fetch('/api/memory.php', {
            method: 'DELETE',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: m.id, created_at: m.created_at }),
          });
          if (!r.ok) throw new Error('http ' + r.status);
        } catch (e) {
          logAction('err', 'failed to delete memory');
        }
        loadMemories(); // reload either way: ids shift after any change
      });
      row.append(meta, text, del);
      memoryList.appendChild(row);
    }
  }
  const memoryAddBtn = document.getElementById('memoryAddBtn');
  const memoryAddInput = document.getElementById('memoryAddInput');
  const memoryAddCategory = document.getElementById('memoryAddCategory');
  async function addMemory() {
    const memory = (memoryAddInput?.value || '').trim();
    if (!memory) return;
    try {
      const r = await fetch('/api/memory.php', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ memory, category: (memoryAddCategory?.value || '').trim() || 'general' }),
      });
      if (!r.ok) throw new Error('http ' + r.status);
      memoryAddInput.value = '';
    } catch (e) {
      logAction('err', 'failed to add memory');
    }
    loadMemories();
  }
  if (memoryAddBtn) memoryAddBtn.addEventListener('click', addMemory);
  if (memoryAddInput) memoryAddInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addMemory(); });
  const memoryClearBtn = document.getElementById('memoryClearBtn');
  if (memoryClearBtn) memoryClearBtn.addEventListener('click', async () => {
    if (!window.confirm('Delete ALL saved memories? This cannot be undone.')) return;
    try {
      const r = await fetch('/api/memory.php', {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      if (!r.ok) throw new Error('http ' + r.status);
    } catch (e) {
      logAction('err', 'failed to clear memories');
    }
    loadMemories();
  });

  // Mood switcher (developer panel): show the live relationship scores and let a
  // dev override them. GET on open / after each reply, PUT (debounced) on drag.
  function renderMood(state) {
    for (const k of ['affection', 'trust', 'tension']) {
      if (state && typeof state[k] === 'number') {
        if (moodInputs[k]) moodInputs[k].value = state[k];
        if (moodVals[k]) moodVals[k].textContent = state[k];
      }
    }
  }
  async function loadMood() {
    if (!moodInputs.affection) return;
    try {
      const r = await fetch('/api/relationship.php', { credentials: 'same-origin' });
      if (r.ok) renderMood(await r.json());
    } catch (e) { /* offline: leave sliders as-is */ }
  }
  let moodPushTimer = null;
  function pushMood() {
    const body = {};
    for (const k of ['affection', 'trust', 'tension']) {
      body[k] = moodInputs[k] ? parseInt(moodInputs[k].value, 10) || 0 : 0;
    }
    if (moodPushTimer) clearTimeout(moodPushTimer);
    moodPushTimer = setTimeout(async () => {
      try {
        const r = await fetch('/api/relationship.php', {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (r.ok) renderMood(await r.json()); // reflect server-side clamping
      } catch (e) { /* drop; next drag retries */ }
    }, 300);
  }
  for (const k of ['affection', 'trust', 'tension']) {
    if (!moodInputs[k]) continue;
    moodInputs[k].addEventListener('input', () => {
      if (moodVals[k]) moodVals[k].textContent = moodInputs[k].value;
    });
    moodInputs[k].addEventListener('change', pushMood);
  }
  if (moodRefreshBtn) moodRefreshBtn.addEventListener('click', loadMood);

  // Escape closes the settings modal.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const d = document.getElementById('settingsDrawer');
    if (d && d.classList.contains('open')) ui.toggleDrawer(false);
  });

  // Sidebar collapse toggle (persists across reloads)
  const appMain = document.querySelector('.app-main');
  const collapseBtn = document.getElementById('collapseSidebarBtn');
  const expandBtn = document.getElementById('expandSidebarBtn');
  if (appMain && localStorage.getItem('sidebar.collapsed') === '1') {
    appMain.classList.add('sidebar-collapsed');
  }
  [collapseBtn, expandBtn].filter(Boolean).forEach(btn => {
    btn.addEventListener('click', () => {
      if (!appMain) return;
      const next = !appMain.classList.contains('sidebar-collapsed');
      appMain.classList.toggle('sidebar-collapsed', next);
      localStorage.setItem('sidebar.collapsed', next ? '1' : '0');
    });
  });

  // Example prompt chips
  document.querySelectorAll('.chip[data-prompt]').forEach(chip => {
    chip.addEventListener('click', () => {
      chatInput.value = chip.dataset.prompt;
      chatInput.focus();
    });
  });

  ui.setStatus('idle', 'idle');

  // Auth gate
  const authScreen = document.getElementById('authScreen');
  const authTabLogin = document.getElementById('authTabLogin');
  const authTabSignup = document.getElementById('authTabSignup');
  const authFormLogin = document.getElementById('authFormLogin');
  const authFormSignup = document.getElementById('authFormSignup');
  const signOutBtn = document.getElementById('signOutBtn');

  // Flavor the auth terminal after the user's OS: macOS Terminal, Windows
  // PowerShell, or a Linux (Ubuntu) shell. Purely cosmetic - data-os drives CSS.
  function detectOS() {
    const p = (navigator.userAgentData && navigator.userAgentData.platform)
      || navigator.platform || navigator.userAgent || '';
    const s = p.toLowerCase();
    if (/mac|iphone|ipad|ipod/.test(s)) return 'mac';
    if (/win/.test(s)) return 'windows';
    return 'linux';
  }
  (function flavorTerminals() {
    const os = detectOS();
    const authTitles = { mac: 'jun - -zsh - 80×24', windows: 'Windows PowerShell', linux: 'jun@junbuntu: ~' };
    const bootTitles = { mac: 'jun - boot - 80×24', windows: 'Windows PowerShell', linux: 'jun@junbuntu: ~/boot' };
    const names = { mac: 'macOS', windows: 'Windows', linux: 'Linux' };

    const authTerm = document.getElementById('authTerm');
    if (authTerm) {
      authTerm.setAttribute('data-os', os);
      const t = document.getElementById('authTermTitle');
      if (t) t.textContent = authTitles[os];
      const n = authTerm.querySelector('.auth-os-name');
      if (n) n.textContent = names[os];
    }

    const bootTerm = document.querySelector('.boot-term');
    if (bootTerm) {
      bootTerm.setAttribute('data-os', os);
      const bt = bootTerm.querySelector('.term-title');
      if (bt) bt.textContent = bootTitles[os];
    }
  })();

  function showAuthScreen() {
    if (authScreen) authScreen.hidden = false;
    // Dismiss the boot overlay so it doesn't sit on top of the auth UI.
    const bo = document.getElementById('bootOverlay');
    if (bo) {
      bo.setAttribute('data-ready', '1');
      bo.setAttribute('aria-hidden', 'true');
    }
  }

  function hideAuthScreen() {
    if (authScreen) authScreen.hidden = true;
  }

  if (authTabLogin && authTabSignup) {
    authTabLogin.addEventListener('click', () => {
      authTabLogin.classList.add('active');
      authTabLogin.setAttribute('aria-selected', 'true');
      authTabSignup.classList.remove('active');
      authTabSignup.setAttribute('aria-selected', 'false');
      authFormLogin.hidden = false;
      authFormSignup.hidden = true;
    });
    authTabSignup.addEventListener('click', () => {
      authTabSignup.classList.add('active');
      authTabSignup.setAttribute('aria-selected', 'true');
      authTabLogin.classList.remove('active');
      authTabLogin.setAttribute('aria-selected', 'false');
      authFormSignup.hidden = false;
      authFormLogin.hidden = true;
    });
  }

  function setAuthError(id, msg) {
    const el = document.getElementById(id);
    if (!el) return;
    if (msg) { el.textContent = msg; el.hidden = false; }
    else { el.hidden = true; el.textContent = ''; }
  }

  if (authFormLogin) {
    authFormLogin.addEventListener('submit', async (e) => {
      e.preventDefault();
      setAuthError('loginError', '');
      const email = document.getElementById('loginEmail').value.trim();
      const password = document.getElementById('loginPassword').value;
      const btn = document.getElementById('loginBtn');
      btn.disabled = true;
      try {
        const r = await Auth.login(email, password);
        if (r.ok) { location.reload(); return; }
        const j = await r.json().catch(() => ({}));
        const msgs = { invalid_credentials: 'Wrong email or password.', rate_limit_exceeded: 'Too many attempts - wait a minute.' };
        setAuthError('loginError', msgs[j.error] || 'Login failed.');
      } catch { setAuthError('loginError', 'Network error.'); }
      btn.disabled = false;
    });
  }

  if (authFormSignup) {
    authFormSignup.addEventListener('submit', async (e) => {
      e.preventDefault();
      setAuthError('signupError', '');
      const email = document.getElementById('signupEmail').value.trim();
      const password = document.getElementById('signupPassword').value;
      const adultConsent = document.getElementById('signupAdult').checked;
      const btn = document.getElementById('signupBtn');
      btn.disabled = true;
      try {
        const r = await Auth.signup(email, password, adultConsent);
        if (r.ok) { location.reload(); return; }
        const j = await r.json().catch(() => ({}));
        const msgs = { email_taken: 'That email is already registered.', invalid_email: 'Invalid email address.', password_too_short: 'Password must be at least 8 characters.', adult_consent_required: 'You must confirm you are 18 or older.', rate_limit_exceeded: 'Too many attempts - wait a minute.' };
        setAuthError('signupError', msgs[j.error] || 'Sign up failed.');
      } catch { setAuthError('signupError', 'Network error.'); }
      btn.disabled = false;
    });
  }

  if (signOutBtn) {
    signOutBtn.addEventListener('click', async () => {
      if (window.Prefs) Prefs.clearLocal();
      await Auth.logout();
      location.reload();
    });
  }

  function showBoot() {
    const bo = document.getElementById('bootOverlay');
    if (bo) {
      bo.removeAttribute('data-ready');
      bo.setAttribute('aria-hidden', 'false');
    }
    if (window.BootFX) BootFX.start();
  }

  (async function bootstrap() {
    // Check session before anything else - redirect to auth screen if not logged in.
    const me = await Auth.me().catch(() => null);
    if (!me) {
      showAuthScreen();
      return;
    }

    // Session confirmed: show the boot overlay. The app shell stays hidden
    // (data-pre-auth) underneath it until dismissBoot reveals it, so the app
    // never flickers through the overlay's fade-in. Unlogged visitors never
    // reach this, so they never see provider loading.
    showBoot();

    // Populate sidebar user chip from session.
    const emailEl = document.getElementById('userEmail');
    if (me.user && emailEl) emailEl.textContent = me.user.email || '';

    // Pull server-side preferences into localStorage before any module reads
    // tracked keys (Outfit, TTS), so a second browser picks up A's settings.
    if (window.Prefs) await Prefs.pullFromServer();
    if (window.Names) Names.load();
    wireNameSettings();

    // Restore saved model settings (model itself is restored by the picker once
    // Ollama's installed list is known, below).
    const savedReasoning = localStorage.getItem('reasoning_level');
    if (savedReasoning && [...reasoningSelect.options].some(o => o.value === savedReasoning)) {
      reasoningSelect.value = savedReasoning;
    }
    if (localStorage.getItem('think') !== null) {
      thinkChk.checked = localStorage.getItem('think') === '1';
    }
    syncThinkToggle();

    Actions.setLogger(logAction);
    Live2D.setOnMissingParam(logMissing);
    if (window.DevHud) DevHud.init();

    try {
      const live2dInfo = await Live2D.init({ stageEl, onStatus: (m) => setStageStatus(m) });
      setTimeout(() => {
        setStageStatus(null);
        if (stageSkeleton) stageSkeleton.classList.add('hidden');
      }, 1500);
      // Default calm idle: breathing, blinking, subtle limb sway.
      Live2D.startIdle();

      await Actions.load('action_map.json');

      // Validate action_map params against model.
      validateActionMap(live2dInfo.paramIds);

      // Dump drawables so we can tune outfit color patterns to actual names.
      if (Live2D.listDrawables) {
        const ids = Live2D.listDrawables();
        console.log(`[Outfit] ${ids.length} drawables in model:`, ids);
      }

      // Outfit panel: load saved state, build checkboxes, push to model.
      Outfit.load();
      Outfit.buildUI(
        document.getElementById('outfitControls'),
        document.getElementById('outfitResetBtn'),
      );
      Outfit.applyAll();
      const wBtn = document.getElementById('wardrobeBtn');
      if (wBtn) wBtn.addEventListener('click', () => { location.href = 'wardrobe.html'; });
    } catch (e) {
      console.error(e);
      if (stageSkeleton) stageSkeleton.classList.add('hidden');
      setStageStatus('Live2D load error: ' + e.message, true);
      ui.toast('Live2D load error: ' + e.message, 'error');
      ui.setStatus('error', 'error');
    }

    // TTS bootstrap: load voice list from sidecar, restore prefs, wire UI.
    if (window.TTS) {
      TTS.setLogger(logAction);
      // Once Jun finishes speaking a reply, start the idle clock from there.
      if (TTS.setOnAllDone) TTS.setOnAllDone(() => scheduleIdleNudge(IDLE_AFTER_REPLY_MS));
      const savedEnabled = localStorage.getItem('tts.enabled') === '1';
      const savedVoice = localStorage.getItem('tts.voice') || '';
      const savedSpeed = parseFloat(localStorage.getItem('tts.speed') || '1.0');
      const savedEngine = localStorage.getItem('tts.engine') || 'kokoro';
      TTS.setSpeed(savedSpeed);
      if (ttsSpeedInput) ttsSpeedInput.value = String(savedSpeed);

      let engines = {};
      // Fill the voice dropdown for one engine and pick a voice for it.
      // `preferred` wins if it's one of the engine's voices, else the engine default.
      function populateVoices(engineKey, preferred) {
        const info = engines[engineKey] || { voices: [], default: '' };
        const voices = info.voices || [];
        const def = (preferred && voices.includes(preferred)) ? preferred
          : (voices.includes(info.default) ? info.default : (voices[0] || ''));
        if (ttsVoiceSelect) {
          ttsVoiceSelect.innerHTML = voices.map(name =>
            `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
          if (def) ttsVoiceSelect.value = def;
        }
        TTS.setVoice(def);
        return def;
      }

      try {
        const v = await TTS.listVoices();
        engines = v.engines || {};
        const engineKey = engines[savedEngine] ? savedEngine
          : (engines[v.default_engine] ? v.default_engine : Object.keys(engines)[0] || 'kokoro');
        TTS.setEngine(engineKey);
        if (ttsEngineSelect) ttsEngineSelect.value = engineKey;
        const def = populateVoices(engineKey, savedVoice);
        const count = (engines[engineKey] && engines[engineKey].voices || []).length;
        if (count) logAction('ok', `TTS ready: ${engineKey}, ${count} voices (default ${def})`);
      } catch (e) {
        logAction('warn', 'TTS sidecar unreachable (start tts/run.sh)');
      }

      if (ttsEngineSelect) {
        ttsEngineSelect.addEventListener('change', () => {
          const engineKey = ttsEngineSelect.value;
          TTS.setEngine(engineKey);
          localStorage.setItem('tts.engine', engineKey);
          // Switching engine resets to that engine's default voice.
          const def = populateVoices(engineKey, '');
          localStorage.setItem('tts.voice', def);
          if (window.Prefs) Prefs.pushToServer();
        });
      }

      if (ttsChk) {
        ttsChk.checked = savedEnabled;
        TTS.setEnabled(savedEnabled);
        ttsChk.addEventListener('change', () => {
          TTS.setEnabled(ttsChk.checked);
          localStorage.setItem('tts.enabled', ttsChk.checked ? '1' : '0');
          if (window.Prefs) Prefs.pushToServer();
        });
      }
      if (ttsVoiceSelect) {
        ttsVoiceSelect.addEventListener('change', () => {
          TTS.setVoice(ttsVoiceSelect.value);
          localStorage.setItem('tts.voice', ttsVoiceSelect.value);
          if (window.Prefs) Prefs.pushToServer();
        });
      }
      if (ttsSpeedInput) {
        ttsSpeedInput.addEventListener('change', () => {
          const s = parseFloat(ttsSpeedInput.value) || 1.0;
          TTS.setSpeed(s);
          localStorage.setItem('tts.speed', String(s));
          if (window.Prefs) Prefs.pushToServer();
        });
      }
    }

    // Boot overlay: poll Ollama until reachable, then fade out.
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
      // Reveal the app shell underneath the still-opaque overlay, so the
      // zoom/fade-out hands straight off to the app (no flicker before it).
      document.documentElement.removeAttribute('data-pre-auth');
      setBoot('Ready', 'Connected', 'ok');
      const hide = () => {
        bootOverlay.setAttribute('data-ready', '1');
        bootOverlay.setAttribute('aria-hidden', 'true');
      };
      // Once the log + "Ready" have shown, zoom into the terminal, then dismiss.
      if (window.BootFX && BootFX.finish) BootFX.finish(hide);
      else setTimeout(hide, 350);
    };

    async function waitForOllama() {
      let attempt = 0;
      const phases = [
        'Waking the model',
        'Brewing Coffee for Anon',
        'Recharging Jun',
        'Jun is taking its time',
      ];
      for (;;) {
        attempt++;
        try {
          const m = await Ollama.listModels();
          if (m && m.models && m.models.length) return m;
          setBoot('Pulling models', 'No models installed yet - `ollama pull <model>`', 'err');
        } catch (e) {
          const phase = phases[Math.min(attempt - 1, phases.length - 1)];
          setBoot(phase, 'Jun is still sleeping - retrying…', 'err');
        }
        await new Promise(r => setTimeout(r, Math.min(1000 + attempt * 250, 3000)));
      }
    }

    const m = await waitForOllama();
    modelSelect.innerHTML = m.models.map(n =>
      `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
    const prefer = [
      'hf.co/efficiencyx/Jun-Lora-v2-GGUF:Q8_0',
      'hf.co/efficiencyx/Jun-Lora-v2-GGUF:Q6_K',
      'hf.co/efficiencyx/Jun-Lora-v2-GGUF:Q4_K_M',
      'hf.co/efficiencyx/Jun-LoRA-V3-E4B-GGUF:Q8_0',
      'hf.co/efficiencyx/Jun-LoRA-V3-E4B-GGUF:Q6_K',
      'hf.co/efficiencyx/Jun-LoRA-V3-E4B-GGUF:Q4_K_M',
      'hf.co/efficiencyx/Jun-LoRA-v3-E2B-GGUF:Q8_0',
      'hf.co/efficiencyx/Jun-LoRA-v3-E2B-GGUF:Q6_K',
      'hf.co/efficiencyx/Jun-LoRA-v3-E2B-GGUF:Q4_K_M',
      'llama3.1:8b', 'llama3.1:latest',
    ];
    const isChat = (n) => !/embed/i.test(n);
    // A previously chosen model wins, as long as it's still installed.
    const saved = localStorage.getItem('model');
    const picked = (saved && m.models.includes(saved) ? saved : null)
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
    fetch('action_map.json').then(r => r.json()).then(am => {
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
})();
