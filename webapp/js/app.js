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
  const stageEl = document.getElementById('stage');
  const stageStatus = document.getElementById('stageStatus');
  const stageSkeleton = document.getElementById('stageSkeleton');
  const resetLive2DBtn = document.getElementById('resetLive2DBtn');
  const ttsChk = document.getElementById('ttsChk');
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
  // reply can't trip it early. 30s after a reply lands, or 45s after the app is
  // ready / a conversation is opened. Capped so Jun doesn't keep talking to an
  // empty room forever — resets when Anon interacts.
  const IDLE_AFTER_REPLY_MS = 30000;
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
      // Anon has a half-written message sitting in the box — he's composing, not
      // idle. Don't talk over him; check again later.
      if (chatInput.value.trim() !== '') { scheduleIdleNudge(delayMs); return; }
      idleNudgeStreak++;
      runChat({ idle: true });
    }, delayMs);
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

  // Inline [ACTION:...] extraction from the streaming text. Accumulate text, dispatch
  // complete actions (closed by ']'), and hold back any tail that could be the start of
  // a marker so it isn't emitted as visible text until we know whether it's an action.
  // Whitespace-tolerant: accepts [ACTION:, [ ACTION:, [ACTION :, [ ACTION :, any case.
  const MARK_RE = /\[\s*ACTION\s*:/i;
  // Trailing partial that could still grow into MARK_RE. Anchored at end-of-string.
  const PARTIAL_RE = /\[\s*(?:A(?:C(?:T(?:I(?:O(?:N\s*:?)?)?)?)?)?)?$/i;

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
          // Drop a dangling unclosed [ACTION:..., emit everything else.
          const start = findMark(buf);
          if (start >= 0) onCleanText(buf.slice(0, start));
          else onCleanText(buf);
          buf = '';
        }
      },
    };
  }

  function sendMessage() {
    const text = chatInput.value.trim();
    if (!text) return;
    // If a stream is in flight, only an *idle nudge* may be interrupted — abort it
    // so Anon's real message wins. A genuine reply in progress is left alone.
    if (abortFn) {
      if (!cancelActiveIdleNudge) return;
      cancelActiveIdleNudge();
    }
    resetIdleNudge(); // Anon spoke — Jun is allowed to nudge again later
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
    const typing = document.createElement('span');
    typing.className = 'typing';
    draft.appendChild(typing);

    let visible = '';
    const stream = makeStreamBuffer(clean => {
      visible += clean;
      draft.innerHTML = renderMarkdown(visible);
      draft.appendChild(typing);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      if (window.TTS) TTS.feed(clean);
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
    appendRaw('--- ' + new Date().toLocaleTimeString() + (idle ? ' (idle nudge)' : '') + ' ---\n');
    abortFn = Ollama.chat(
      { messages: [...messages], model: modelSelect.value,
        reasoning: reasoningSelect.value, think: thinkChk.checked,
        outfit_context: Outfit.describe(), conversation_id: currentConversationId,
        idle: !!idle, client_time: localTimeString() },
      {
        onDebug: (dbg) => {
          if (dbg && typeof dbg.system_prompt === 'string') {
            debugSystemPromptEl.textContent = dbg.system_prompt;
          }
        },
        onToken: (tok) => { appendRaw(tok); stream.push(tok); },
        onDone: async () => {
          stream.flush();
          if (window.TTS) TTS.flush();
          typing.remove();
          if (visible.trim()) messages.push({ role: 'assistant', content: visible });
          else draft.remove();
          finalize();
          ui.setStatus('idle', 'idle');
          updateEmptyState();
          scheduleAutoReset();
          scheduleIdleNudge(IDLE_AFTER_REPLY_MS);
          if (window.History) await refreshSidebar();
        },
        onError: async (err) => {
          stream.flush();
          if (window.TTS) TTS.flush();
          typing.remove();
          if (!visible.trim()) draft.remove();
          ui.toast('⚠ ' + err.message, 'error');
          ui.setStatus('error', 'error');
          finalize();
          updateEmptyState();
          scheduleAutoReset();
          scheduleIdleNudge(IDLE_AFTER_REPLY_MS);
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
    resetIdleNudge(); // fresh context — let Jun nudge again
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
          el.innerHTML = renderMarkdown(visible);
          messages.push({ role: 'assistant', content: visible });
        }
      }
    } catch (e) {
      ui.toast('Failed to load conversation: ' + e.message, 'error');
    }
  }

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

  // Settings drawer
  if (openSettingsBtn) openSettingsBtn.addEventListener('click', () => ui.toggleDrawer(true));
  if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', () => ui.toggleDrawer(false));
  if (drawerBackdrop) drawerBackdrop.addEventListener('click', () => ui.toggleDrawer(false));

  const userChipBtn = document.getElementById('userChipBtn');
  if (userChipBtn) userChipBtn.addEventListener('click', () => ui.toggleDrawer(true));

  // Sidebar collapse toggle (persists across reloads)
  const appMain = document.querySelector('.app-main');
  const collapseBtn = document.getElementById('collapseSidebarBtn');
  if (appMain && localStorage.getItem('sidebar.collapsed') === '1') {
    appMain.classList.add('sidebar-collapsed');
  }
  if (collapseBtn) {
    collapseBtn.addEventListener('click', () => {
      if (!appMain) return;
      const next = !appMain.classList.contains('sidebar-collapsed');
      appMain.classList.toggle('sidebar-collapsed', next);
      localStorage.setItem('sidebar.collapsed', next ? '1' : '0');
    });
  }

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
        const msgs = { invalid_credentials: 'Wrong email or password.', rate_limit_exceeded: 'Too many attempts — wait a minute.' };
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
        const msgs = { email_taken: 'That email is already registered.', invalid_email: 'Invalid email address.', password_too_short: 'Password must be at least 8 characters.', adult_consent_required: 'You must confirm you are 18 or older.', rate_limit_exceeded: 'Too many attempts — wait a minute.' };
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
  }

  (async function bootstrap() {
    // Check session before anything else — redirect to auth screen if not logged in.
    const me = await Auth.me().catch(() => null);
    if (!me) {
      showAuthScreen();
      return;
    }

    // Session confirmed: reveal the app shell and the AI-provider boot overlay.
    // Unlogged visitors never reach this, so they never see provider loading.
    document.documentElement.removeAttribute('data-pre-auth');
    showBoot();

    // Populate sidebar user chip from session.
    const emailEl = document.getElementById('userEmail');
    const avatarEl = document.getElementById('userAvatar');
    if (me.user && emailEl) emailEl.textContent = me.user.email || '';
    if (me.user && avatarEl) avatarEl.textContent = (me.user.email || '?').charAt(0);

    // Pull server-side preferences into localStorage before any module reads
    // tracked keys (Outfit, TTS), so a second browser picks up A's settings.
    if (window.Prefs) await Prefs.pullFromServer();

    Actions.setLogger(logAction);
    Live2D.setOnMissingParam(logMissing);

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
      const savedEnabled = localStorage.getItem('tts.enabled') === '1';
      const savedVoice = localStorage.getItem('tts.voice') || '';
      const savedSpeed = parseFloat(localStorage.getItem('tts.speed') || '1.0');
      TTS.setSpeed(savedSpeed);
      if (ttsSpeedInput) ttsSpeedInput.value = String(savedSpeed);

      try {
        const v = await TTS.listVoices();
        const voices = v.voices || [];
        const def = savedVoice || v.default || (voices[0] || 'af_heart');
        if (ttsVoiceSelect) {
          ttsVoiceSelect.innerHTML = voices.map(name =>
            `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
          if (voices.includes(def)) ttsVoiceSelect.value = def;
        }
        TTS.setVoice(def);
        if (voices.length) logAction('ok', `TTS ready: ${voices.length} voices`);
      } catch (e) {
        logAction('warn', 'TTS sidecar unreachable (start tts/run.sh)');
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
      if (bootStatusLabel && label) bootStatusLabel.textContent = label;
      if (bootHint && hint != null) {
        bootHint.textContent = hint;
        if (tone) bootHint.setAttribute('data-tone', tone);
        else bootHint.removeAttribute('data-tone');
      }
    };
    const dismissBoot = () => {
      if (!bootOverlay) return;
      setBoot('Ready', 'Connected', 'ok');
      setTimeout(() => {
        bootOverlay.setAttribute('data-ready', '1');
        bootOverlay.setAttribute('aria-hidden', 'true');
      }, 350);
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
          setBoot('Pulling models', 'No models installed yet — `ollama pull <model>`', 'err');
        } catch (e) {
          const phase = phases[Math.min(attempt - 1, phases.length - 1)];
          setBoot(phase, 'Jun is still sleeping — retrying…', 'err');
        }
        await new Promise(r => setTimeout(r, Math.min(1000 + attempt * 250, 3000)));
      }
    }

    const m = await waitForOllama();
    modelSelect.innerHTML = m.models.map(n =>
      `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
    const prefer = ['Jun-14B:Q4_K_M', 'hf.co/efficiencyx/jun-14b:Q4_K_M', 'llama3.1:8b', 'llama3.1:latest'];
    const isChat = (n) => !/embed/i.test(n);
    const picked = prefer.find(p => m.models.includes(p)) || m.models.find(isChat) || m.models[0];
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
