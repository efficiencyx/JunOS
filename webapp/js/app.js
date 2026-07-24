(function () {
  const messagesEl = document.getElementById('messages');
  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const modelSelect = document.getElementById('modelSelect');
  const reasoningSelect = document.getElementById('reasoningSelect');
  const thinkChk = document.getElementById('thinkChk');
  const devNoIdleChk = document.getElementById('devNoIdleChk');
  const reloadPromptBtn = document.getElementById('reloadPromptBtn');
  const actionLogEl = document.getElementById('actionLog');
  const actionLogCount = document.getElementById('actionLogCount');
  const missingParamsEl = document.getElementById('missingParams');
  const rawStreamEl = document.getElementById('rawStream');
  const clearRawBtn = document.getElementById('clearRawBtn');
  const toolLogEl = document.getElementById('toolLog');
  const toolLogCount = document.getElementById('toolLogCount');
  const clearToolLogBtn = document.getElementById('clearToolLogBtn');
  const debugSystemPromptEl = document.getElementById('debugSystemPrompt');
  const consolidationBanner = document.getElementById('consolidationBanner');
  const consolidationTitle = document.getElementById('consolidationTitle');
  const consolidationSub = document.getElementById('consolidationSub');
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
  const moodPhrases = {
    affection: document.getElementById('moodAffectionPhrase'),
    trust: document.getElementById('moodTrustPhrase'),
    tension: document.getElementById('moodTensionPhrase'),
  };
  const MOOD_PHRASES = {
    affection: [
      [90, "i'm completely yours"], [80, 'i love you so much'], [70, 'i love you'],
      [60, "i'm so happy with you"], [50, 'i really like you'], [40, 'i like being with you'],
      [30, "you're growing on me"], [20, 'you seem nice'], [10, 'still getting to know you'],
      [0, 'who are you again?'],
    ],
    trust: [
      [90, "i'd trust you with anything"], [80, 'i trust you completely'], [70, 'i trust you'],
      [60, "i'm starting to rely on you"], [50, 'i want to trust you'], [40, "i'm still a little guarded"],
      [30, "i'm not sure about you yet"], [20, "you'll have to earn it"], [10, 'i barely know you'],
      [0, "i don't trust you"],
    ],
    tension: [
      [90, "i'm terrified"], [80, "i'm really scared"], [70, "i'm scared"],
      [60, 'this is too much'], [50, "i'm on edge"], [40, 'a little tense'],
      [30, 'slightly uneasy'], [20, 'mostly calm'], [10, 'i feel relaxed'],
      [0, 'totally at ease'],
    ],
  };
  const moodRefreshBtn = document.getElementById('moodRefreshBtn');
  const stageEl = document.getElementById('stage');
  const stageStatus = document.getElementById('stageStatus');
  const stageSkeleton = document.getElementById('stageSkeleton');
  const resetLive2DBtn = document.getElementById('resetLive2DBtn');
  const ttsChk = document.getElementById('ttsChk');
  const ttsEngineSelect = document.getElementById('ttsEngineSelect');
  const ttsVoiceSelect = document.getElementById('ttsVoiceSelect');
  const ttsLangSelect = document.getElementById('ttsLangSelect');
  const ttsLangRow = document.getElementById('ttsLangRow');
  const ttsSpeedInput = document.getElementById('ttsSpeed');
  const siteVolumeInput = document.getElementById('siteVolume');
  const voiceChk = document.getElementById('voiceChk');
  const voiceState = document.getElementById('voiceState');
  const voiceBargeChk = document.getElementById('voiceBargeChk');
  const voiceSilenceInput = document.getElementById('voiceSilence');
  const messagesEmpty = document.getElementById('messagesEmpty');
  const openSettingsBtn = document.getElementById('openSettingsBtn');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const drawerBackdrop = document.getElementById('drawerBackdrop');
  const mobileReplyStatus = document.getElementById('mobileReplyStatus');
  const mobileMenuBtn = document.getElementById('mobileMenuBtn');
  const mobileConversationTitle = document.getElementById('mobileConversationTitle');
  const conversationSidebar = document.getElementById('conversationSidebar');
  const sidebarBackdrop = document.getElementById('sidebarBackdrop');
  const sidebarBackground = [
    document.querySelector('.app-header'),
    document.querySelector('.chat-panel'),
    stageEl,
  ].filter(Boolean);
  const sendButtonIdleMarkup = sendBtn.innerHTML;
  const sendButtonStopMarkup = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
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

  const messages = []; // {role:'user'|'assistant', content:string}
  const conversationTitles = new Map();
  let logCount = 0;
  let abortFn = null;
  let autoResetTimer = null;
  let currentConversationId = null;
  let chatGeneration = 0;
  let conversationLoadGeneration = 0;
  let sidebarRefreshGeneration = 0;

  const AUTO_RESET_MS = 3000;

  const IDLE_AFTER_REPLY_MS = 60000;
  const IDLE_AFTER_JOIN_MS  = 45000;
  const TYPING_POLL_MS = 5000;
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
  let consolidating = false;
  let previousBusyLine = -1;
  let idleNudgeStreak = 0;
  let cancelActiveIdleNudge = null;
  let stopActiveStream = null;
  let renderVoiceDraft = null;
  let activeBubbleStream = null;
  let latestAssistantReply = '';
  let currentConversationTitle = 'New conversation';

  function cancelIdleNudge() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  function pickBusyLine() {
    let index = Math.floor(Math.random() * BUSY_LINES.length);
    if (index === previousBusyLine) index = (index + 1) % BUSY_LINES.length;
    previousBusyLine = index;
    const player = window.Names ? Names.getPlayer() : 'Anon';
    return escapeHtml(BUSY_LINES[index].replaceAll('${p}', player));
  }

  function showConsolidatingBubble() {
    showFaceBubble(pickBusyLine(), 'ephemeral');
  }

  function formatElapsed(seconds) {
    const whole = Math.max(0, Math.round(seconds));
    return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
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
        ? `She's keeping ${last.notes} note${last.notes === 1 ? '' : 's'} about you — Settings › Memory has the list.`
        : 'Nothing new this time that was worth writing down.');
    } else if (last.status === 'rejected') {
      setConsolidationBanner('warn', "Jun couldn't finish tidying",
        'What the model gave back did not look right, so she left her notes exactly as they were.');
    } else {
      setConsolidationBanner('warn', "Jun couldn't finish tidying",
        'Something broke partway through. Nothing was changed — she will try again after the next lull.');
    }
    if (consolidationOutcomeTimer) clearTimeout(consolidationOutcomeTimer);
    consolidationOutcomeTimer = setTimeout(() => {
      consolidationOutcomeTimer = null;
      hideConsolidationBanner();
    }, CONSOLIDATION_OUTCOME_MS);
  }

  function setConsolidating(locked, status) {
    const wasLocked = consolidating;
    consolidating = locked;
    chatInput.disabled = locked;
    sendBtn.disabled = locked;
    chatInput.placeholder = locked ? 'Jun is busy with her memory…' : 'Write to Jun…';

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

  function reportActivity(immediate = false) {
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

  async function syncConsolidationStatus() {
    if (consolidationStatusTimer) clearTimeout(consolidationStatusTimer);
    consolidationStatusTimer = null;
    const wasLocked = consolidating;
    try {
      const response = await fetch('api/consolidate.php?action=status', { credentials: 'same-origin' });
      const status = response.ok ? await response.json() : { locked: false };
      setConsolidating(!!status.locked, status);
      if (wasLocked && !status.locked) armIdleAfterReply();
    } catch (e) {
      setConsolidating(false);
    }
    // Only keep polling while she is actually busy; an unlocked tab learns about
    // a new lock from the 418 on its next send.
    if (consolidating) consolidationStatusTimer = setTimeout(syncConsolidationStatus, 3000);
  }

  function resetIdleNudge() {
    idleNudgeStreak = 0;
    cancelIdleNudge();
  }

  function scheduleIdleNudge(delayMs) {
    cancelIdleNudge();
    if (devNoIdleChk.checked) return;
    if (consolidating) return;
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

  function renderMarkdown(text) {
    if (!window.marked) return escapeHtml(text);
    const html = marked.parse(text || '');
    return window.DOMPurify ? DOMPurify.sanitize(html) : html;
  }

  function appendMsg(role, content) {
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

  function addRatingControls(message, turnId) {
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

    const submit = rating => {
      void fetch('api/rating.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ turn_id: turnId, rating }),
      });
    };
    up.addEventListener('click', () => {
      if (abortFn) return;
      submit(1);
      up.classList.add('selected');
      up.disabled = down.disabled = true;
      clearTimeout(rateTimer);
      fadeOutRate();
    });
    down.addEventListener('click', async () => {
      if (abortFn) return;
      submit(-1);
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

  const faceBubble = (() => {
    const el = document.createElement('div');
    el.className = 'face-bubble';
    el.tabIndex = 0;
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Jun reply');
    el.hidden = true;
    document.body.appendChild(el);
    return el;
  })();
  sidebarBackground.push(faceBubble);
  let faceBubbleRaf = 0;
  let lastFaceBubbleLeft = null;
  let lastFaceBubbleTop = null;
  let lastFaceBubbleWidth = null;
  let faceBubbleHideTimer = 0;
  let pendingFaceBubbleHide = null;
  let faceBubbleText = '';

  function phoneMode() {
    return !!(window.MobileViewport && MobileViewport.isPhone());
  }

  function visualRect() {
    if (window.MobileViewport && MobileViewport.getVisualRect) return MobileViewport.getVisualRect();
    return { left: 0, top: 0, width: innerWidth, height: innerHeight, right: innerWidth, bottom: innerHeight };
  }

  function positionFaceBubble() {
    const a = window.Live2D && Live2D.faceAnchor && Live2D.faceAnchor();
    if (!a) return;
    const viewport = visualRect();
    const stage = stageEl.getBoundingClientRect();
    const headerEl = document.querySelector('.app-header');
    const header = headerEl.getBoundingClientRect();
    const composer = document.querySelector('.composer-area').getBoundingClientRect();
    const phone = phoneMode();
    const mobileShell = window.matchMedia('(max-width: 900px)').matches;
    const headerStyle = mobileShell ? getComputedStyle(headerEl) : null;
    const sideInsetLeft = headerStyle ? Math.max(8, parseFloat(headerStyle.paddingLeft) || 0) : 8;
    const sideInsetRight = headerStyle ? Math.max(8, parseFloat(headerStyle.paddingRight) || 0) : 8;
    const safeLeft = Math.max(stage.left + 8, viewport.left + sideInsetLeft);
    const safeRight = Math.min(stage.right - 8, viewport.right - sideInsetRight);
    const safeTop = Math.max(stage.top + 40, viewport.top + (mobileShell ? header.height + 40 : 8));
    const safeBottom = Math.min(stage.bottom - 8, phone ? composer.top - 8 : viewport.bottom - 8);
    const avail = safeRight - safeLeft;
    const w = Math.max(phone ? 240 : 150, Math.min(phone ? Math.min(360, avail) : Math.min(330, avail), a.modelW * 0.6));
    const scale = w / 330;
    if (w !== lastFaceBubbleWidth) {
      lastFaceBubbleWidth = w;
      faceBubble.style.setProperty('--fb-w', w + 'px');
      faceBubble.style.setProperty('--fb-scale', String(scale));
    }
    const text = faceBubble.querySelector('.fb-text');
    if (text) {
      if (phone) {
        const name = faceBubble.querySelector('.fb-name');
        const nameH = (name ? name.offsetHeight : 0) + 10 * scale;
        const availH = Math.min(
          Math.max(140, a.y - 12 - safeTop),
          safeBottom - safeTop,
          viewport.height * 0.46,
        );
        text.style.maxHeight = Math.max(0, availH - nameH) + 'px';
      } else if (text.style.maxHeight) {
        text.style.maxHeight = '';
      }
    }
    const bw = faceBubble.offsetWidth, bh = faceBubble.offsetHeight;
    let left, top;
    if (phone) {
      left = a.x - bw / 2;
      top = a.y - bh - 12;
    } else {
      left = a.x - a.headW * 0.5 - bw;
      if (left < safeLeft) left = Math.min(a.x + a.headW * 0.5, safeRight - bw);
      top = a.y + a.modelH * 0.18;
    }
    left = Math.max(safeLeft, Math.min(left, safeRight - bw));
    top = Math.max(safeTop, Math.min(top, safeBottom - bh));
    if (left !== lastFaceBubbleLeft || top !== lastFaceBubbleTop) {
      lastFaceBubbleLeft = left;
      lastFaceBubbleTop = top;
      faceBubble.style.left = left + 'px';
      faceBubble.style.top = top + 'px';
    }
  }

  function scheduleFaceBubblePosition() {
    if (faceBubbleRaf) return;
    faceBubbleRaf = requestAnimationFrame(function tick() {
      faceBubbleRaf = faceBubble.hidden ? 0 : requestAnimationFrame(tick);
      positionFaceBubble();
    });
  }

  function showFaceBubble(html, source = 'ephemeral') {
    clearTimeout(faceBubbleHideTimer);
    pendingFaceBubbleHide = null;
    faceBubble.dataset.source = source;
    const botName = window.Names ? Names.getBot() : 'Jun';
    faceBubble.setAttribute('aria-label', `${botName} reply`);
    let name = faceBubble.querySelector('.fb-name');
    let txt = faceBubble.querySelector('.fb-text');
    if (!name || !txt) {
      faceBubble.textContent = '';
      name = document.createElement('div');
      name.className = 'fb-name';
      txt = document.createElement('div');
      txt.className = 'fb-text';
      faceBubble.append(name, txt);
    }
    name.textContent = botName;
    txt.innerHTML = html;
    if (faceBubble.hidden) {
      faceBubble.hidden = false;
      faceBubble.classList.remove('intro');
      void faceBubble.offsetWidth;
      faceBubble.classList.add('intro');
    }
    scheduleFaceBubblePosition();
  }

  function hideFaceBubble() {
    clearTimeout(faceBubbleHideTimer);
    faceBubbleHideTimer = 0;
    pendingFaceBubbleHide = null;
    faceBubble.hidden = true;
    faceBubble.classList.remove('intro');
    cancelAnimationFrame(faceBubbleRaf);
    faceBubbleRaf = 0;
  }

  function hideFaceBubbleAfterReading() {
    faceBubbleHideTimer = 0;
    const focused = document.activeElement;
    if (faceBubble.contains(focused)) {
      try {
        if (focused.matches(':focus-visible')) return;
      } catch (e) {
        return;
      }
    }
    hideFaceBubble();
  }

  function faceBubbleDelay(text, source) {
    if (source !== 'phone') return 10000;
    const rendered = faceBubble.querySelector('.fb-text');
    const words = (((rendered && rendered.textContent) || text).trim().match(/\S+/g) || []).length;
    return Math.max(6000, Math.min(30000, words * 240));
  }

  function startFaceBubbleHideTimer(text, source) {
    clearTimeout(faceBubbleHideTimer);
    pendingFaceBubbleHide = null;
    faceBubbleText = text;
    faceBubbleHideTimer = setTimeout(hideFaceBubbleAfterReading, faceBubbleDelay(text, source));
  }

  function scheduleFaceBubbleHide(text, source) {
    clearTimeout(faceBubbleHideTimer);
    pendingFaceBubbleHide = { text, source };
    faceBubbleText = text;
    if (window.TTS && TTS.isSpeaking && TTS.isSpeaking()) return;
    startFaceBubbleHideTimer(text, source);
  }

  function finishPendingFaceBubbleHide() {
    if (!pendingFaceBubbleHide || faceBubble.hidden) return;
    startFaceBubbleHideTimer(pendingFaceBubbleHide.text, pendingFaceBubbleHide.source);
  }

  function restartFaceBubbleHide() {
    if (faceBubble.hidden || !faceBubbleText) return;
    scheduleFaceBubbleHide(faceBubbleText, faceBubble.dataset.source || 'ephemeral');
  }

  function announceMobileReply(text) {
    if (!mobileReplyStatus || !phoneMode() || !text.trim()) return;
    mobileReplyStatus.textContent = '';
    requestAnimationFrame(() => {
      const botName = window.Names ? Names.getBot() : 'Jun';
      mobileReplyStatus.textContent = `${botName} replied: ${text}`;
    });
  }

  function setLatestAssistantReply(text) {
    latestAssistantReply = text.trim();
    if (mobileConversationTitle) {
      mobileConversationTitle.disabled = !latestAssistantReply || !phoneMode();
      mobileConversationTitle.title = latestAssistantReply ? 'Show latest reply' : currentConversationTitle;
    }
    setConversationTitle(currentConversationTitle);
  }

  function setConversationTitle(title) {
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

  let toolCallCount = 0;
  function logToolStatus(s) {
    if (!toolLogEl || !s || !s.name) return;
    if (toolCallCount === 0) toolLogEl.textContent = '';
    const row = document.createElement('div');
    row.className = 'row';
    const ts = new Date().toLocaleTimeString();
    if (s.state === 'running') {
      const args = s.args && Object.keys(s.args).length ? JSON.stringify(s.args) : '';
      row.innerHTML = `<span class="ts">${ts}</span> <span class="info">🔧 ${escapeHtml(s.name)}(${escapeHtml(args)})</span>`;
    } else {
      toolCallCount++;
      toolLogCount.textContent = toolCallCount;
      const ms = typeof s.duration_ms === 'number' ? ` ${s.duration_ms}ms` : '';
      const result = (s.result || '').trim() || '(empty result)';
      row.innerHTML = `<span class="ts">${ts}</span> <span class="ok">✓ ${escapeHtml(s.name)}${ms}</span> <span>→ ${escapeHtml(result)}</span>`;
    }
    toolLogEl.appendChild(row);
    toolLogEl.scrollTop = toolLogEl.scrollHeight;
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

  const MARK_RE = /\[\s*A(?:CTIONS?)?\s*:/i;
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
            const hold = pendingMarkerSuffix(buf);
            if (buf.length > hold) {
              onCleanText(buf.slice(0, buf.length - hold));
              buf = buf.slice(buf.length - hold);
            }
            break;
          }
          if (start > 0) {
            onCleanText(buf.slice(0, start));
            buf = buf.slice(start);
          }
          const end = buf.indexOf(']');
          if (end < 0) break; // wait for more
          const blob = buf.slice(0, end + 1);
          buf = buf.slice(end + 1);
          const acts = Actions.parseActions(blob);
          if (acts.length === 0) {
            logAction('warn', 'block non parsabile: ' + blob);
          } else {
            for (const a of acts) {
              Actions.applyAction(a);
              noteEmotionTint(a);
            }
          }
        }
      },
      flush() {
        if (buf.length) {
          const start = findMark(buf);
          if (start >= 0) onCleanText(buf.slice(0, start));
          else onCleanText(buf);
          buf = '';
        }
      },
    };
  }

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
    resetIdleNudge(); // Anon spoke - Jun is allowed to nudge again later
    reportActivity();
    chatInput.value = '';
    appendMsg('user', text);
    messages.push({ role: 'user', content: text });
    runChat({ idle: false });
  }

  function sendTouchEvent(text) {
    if (abortFn) return;
    resetIdleNudge();
    reportActivity();
    messages.push({ role: 'user', content: text });
    runChat({ idle: false, ephemeral: true });
  }

  const VOICE_STATE_LABELS = {
    idle: 'off',
    calibrating: 'listening to the room…',
    listening: 'listening',
    maybe: 'listening',      // too brief (~96ms) to be worth flickering the label
    speech: 'hearing you',
    thinking: 'transcribing…',
  };

  async function sttAvailable() {
    try {
      const r = await fetch('/api/stt.php?action=health', { credentials: 'same-origin' });
      if (!r.ok) return false;
      const d = await r.json();
      return !!d.stt;
    } catch (e) {
      return false;
    }
  }

  function sendFromVoice(text) {
    if (stopActiveStream) stopActiveStream();
    chatInput.value = text;
    sendMessage();
  }

  function runChat({ idle, ephemeral }) {
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
    let turnId = null;
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

    cancelActiveIdleNudge = idle ? () => {
      if (!isCurrent()) return;
      chatGeneration++;
      if (abortFn) abortFn();
      if (window.TTS) TTS.stop();
      typing.remove();
      draft.remove();
      updateEmptyState();
      finalize(false);
    } : null;

    ui.setStatus('streaming', 'streaming');
    if (window.DevHud) DevHud.beginGen();
    appendRaw('--- ' + new Date().toLocaleTimeString() + (idle ? ' (idle nudge)' : '') + ' ---\n');

    // Predict the reply's language from Anon's message so the pocket-tts model can
    // warm during generation. This only routes the voice - the prediction never
    // reaches the model, which mirrors Anon's language from the conversation itself.
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
        idle: !!idle, ephemeral: !!ephemeral, client_time: localTimeString() },
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
          if (typeof s?.turn_id === 'string') turnId = s.turn_id;
          if (window.DevHud) DevHud.setGenStats(s);
        },
        onToolStatus: (s) => {
          if (!isCurrent()) return;
          if (s && s.state === 'running') ui.setStatus('streaming', '🔧 ' + s.name + '…');
          else ui.setStatus('streaming', 'streaming');
          logToolStatus(s);
        },
        onThinking: (t) => { if (isCurrent()) { appendRaw(t); pushThinking(t); } },
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
          if (visible.trim()) {
            messages.push({ role: 'assistant', content: visible });
            if (!ephemeral && turnId) addRatingControls(draft, turnId);
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
          if (err.status === 418) {
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
      cancelActiveIdleNudge = null;
      stopActiveStream = null;
      sendBtn.disabled = consolidating;
      sendBtn.innerHTML = sendButtonIdleMarkup;
      sendBtn.setAttribute('aria-label', 'Send');
      sendBtn.removeEventListener('click', onClickStop);
    }
  }

  function discardActiveResponse() {
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
    cancelActiveIdleNudge = null;
    renderVoiceDraft = null;
    sendBtn.disabled = false;
    sendBtn.innerHTML = sendButtonIdleMarkup;
    sendBtn.setAttribute('aria-label', 'Send');
    ui.setStatus('idle', 'idle');
  }

  async function refreshSidebar() {
    if (!window.History) return;
    const ul = document.getElementById('conversationList');
    if (!ul) return;
    const refreshGeneration = ++sidebarRefreshGeneration;
    let convs;
    try { convs = await History.list(); } catch (e) { return; }
    if (refreshGeneration !== sidebarRefreshGeneration) return;
    ul.innerHTML = '';
    conversationTitles.clear();
    for (const c of convs) {
      const li = document.createElement('li');
      li.className = 'conv-item' + (c.id === currentConversationId ? ' active' : '');
      li.dataset.id = String(c.id);
      const title = c.title || 'New conversation';
      conversationTitles.set(c.id, title);
      li.innerHTML = `<button class="conv-open" type="button"><span class="conv-title">${escapeHtml(title)}</span></button>`
        + `<button class="conv-delete" type="button" title="Delete conversation" aria-label="Delete conversation">`
        + `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>`
        + `</button>`;
      const openBtn = li.querySelector('.conv-open');
      if (c.id === currentConversationId) openBtn.setAttribute('aria-current', 'page');
      openBtn.addEventListener('click', () => {
        setSidebarOpen(false);
        loadConversation(c.id);
      });
      const delBtn = li.querySelector('.conv-delete');
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteConversation(c.id, title);
      });
      ul.appendChild(li);
    }
    if (currentConversationId != null) setConversationTitle(conversationTitles.get(currentConversationId));
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
    if (id === currentConversationId) {
      discardActiveResponse();
      conversationLoadGeneration++;
    }
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
      const active = Number(el.dataset.id) === id;
      el.classList.toggle('active', active);
      const openBtn = el.querySelector('.conv-open');
      if (!openBtn) return;
      if (active) openBtn.setAttribute('aria-current', 'page');
      else openBtn.removeAttribute('aria-current');
    });
  }

  async function loadConversation(id) {
    discardActiveResponse();
    const loadGeneration = ++conversationLoadGeneration;
    currentConversationId = id;
    cancelAutoReset();
    hideFaceBubble();
    setLatestAssistantReply('');
    setConversationTitle(conversationTitles.get(id));
    resetIdleNudge(); // fresh context - let Jun nudge again
    reportActivity();
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
      if (loadGeneration !== conversationLoadGeneration || currentConversationId !== id) return;
      let latest = '';
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
          const shown = window.Names ? Names.apply(visible) : visible;
          el.innerHTML = renderMarkdown(shown);
          latest = shown;
          messages.push({ role: 'assistant', content: visible });
        }
      }
      setLatestAssistantReply(latest);
      setConversationTitle(conversationTitles.get(id));
    } catch (e) {
      if (loadGeneration !== conversationLoadGeneration || currentConversationId !== id) return;
      ui.toast('Failed to load conversation: ' + e.message, 'error');
    }
  }

  function syncThinkToggle() {
    thinkChk.disabled = reasoningSelect.value === 'auto';
  }
  reasoningSelect.addEventListener('change', syncThinkToggle);
  syncThinkToggle();

  function persistPref(key, value) {
    localStorage.setItem(key, value);
    if (window.Prefs) Prefs.pushToServer();
  }
  modelSelect.addEventListener('change', () => persistPref('model', modelSelect.value));
  reasoningSelect.addEventListener('change', () => persistPref('reasoning_level', reasoningSelect.value));
  thinkChk.addEventListener('change', () => persistPref('think', thinkChk.checked ? '1' : '0'));
  devNoIdleChk.addEventListener('change', () => {
    if (devNoIdleChk.checked) cancelIdleNudge();
    persistPref('no_idle_nudges', devNoIdleChk.checked ? '1' : '0');
  });

  sendBtn.addEventListener('click', sendMessage);
  const composer = document.querySelector('.composer');
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
    idleNudgeStreak = 0;
    scheduleIdleNudge(IDLE_AFTER_REPLY_MS);
  });
  window.addEventListener('pagehide', () => {
    navigator.sendBeacon('api/consolidate.php?action=activity&enabled=1');
  });
  setInterval(() => {
    if (abortFn || !currentConversationId) return;
    if (chatInput.value.trim() === '') return;
    idleNudgeStreak = 0;
    scheduleIdleNudge(IDLE_AFTER_REPLY_MS);
  }, TYPING_POLL_MS);

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
  clearToolLogBtn.addEventListener('click', () => {
    toolLogEl.textContent = 'No tool calls yet.';
    toolCallCount = 0;
    toolLogCount.textContent = '0';
  });

  const narrowSidebarQuery = window.matchMedia('(max-width: 900px)');
  let sidebarOpener = null;

  function setSidebarOpen(open) {
    if (!conversationSidebar || !sidebarBackdrop || !mobileMenuBtn) return;
    open = !!open && narrowSidebarQuery.matches;
    const wasOpen = document.body.classList.contains('sidebar-open');
    if (open && !wasOpen) sidebarOpener = document.activeElement;
    document.body.classList.toggle('sidebar-open', open);
    conversationSidebar.classList.toggle('mobile-open', open);
    sidebarBackdrop.classList.toggle('open', open);
    sidebarBackdrop.setAttribute('aria-hidden', String(!open));
    mobileMenuBtn.setAttribute('aria-expanded', String(open));
    mobileMenuBtn.setAttribute('aria-label', open ? 'Close conversations' : 'Open conversations');
    [...sidebarBackground, document.getElementById('toasts'), document.getElementById('devHud')]
      .filter(Boolean).forEach(element => {
      element.inert = open;
      if (open) element.setAttribute('aria-hidden', 'true');
      else element.removeAttribute('aria-hidden');
    });
    if (narrowSidebarQuery.matches) {
      conversationSidebar.setAttribute('aria-hidden', String(!open));
      conversationSidebar.inert = !open;
    } else {
      conversationSidebar.removeAttribute('aria-hidden');
      conversationSidebar.inert = false;
    }
    if (open) {
      const first = conversationSidebar.querySelector('button:not([disabled]), [href]');
      if (first) first.focus();
    } else if (wasOpen && sidebarOpener && sidebarOpener.focus && document.contains(sidebarOpener)) {
      sidebarOpener.focus();
      sidebarOpener = null;
    }
  }

  function syncSidebarLayout() {
    setSidebarOpen(false);
    if (!narrowSidebarQuery.matches && conversationSidebar) {
      conversationSidebar.removeAttribute('aria-hidden');
      conversationSidebar.inert = false;
    }
  }

  if (mobileMenuBtn) mobileMenuBtn.addEventListener('click', () => setSidebarOpen(true));
  if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', () => setSidebarOpen(false));
  if (mobileConversationTitle) {
    mobileConversationTitle.addEventListener('click', (event) => {
      if (!phoneMode() || !latestAssistantReply) return;
      showFaceBubble(renderMarkdown(latestAssistantReply), 'phone');
      announceMobileReply(latestAssistantReply);
      scheduleFaceBubbleHide(latestAssistantReply, 'phone');
      if (event.detail === 0) faceBubble.focus({ preventScroll: true });
    });
  }
  if (conversationSidebar) {
    conversationSidebar.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('sidebar-open')) {
        e.preventDefault();
        setSidebarOpen(false);
        return;
      }
      if (e.key !== 'Tab' || !document.body.classList.contains('sidebar-open')) return;
      const focusable = [...conversationSidebar.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
        .filter(el => !el.hidden && el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }
  if (narrowSidebarQuery.addEventListener) narrowSidebarQuery.addEventListener('change', syncSidebarLayout);
  else narrowSidebarQuery.addListener(syncSidebarLayout);
  syncSidebarLayout();

  const newChatBtn = document.getElementById('newChatBtn');
  if (newChatBtn) {
    newChatBtn.addEventListener('click', async () => {
      if (!window.History) return;
      reportActivity();
      setSidebarOpen(false);
      discardActiveResponse();
      const requestGeneration = ++conversationLoadGeneration;
      newChatBtn.disabled = true;
      try {
        const { id } = await History.create();
        await refreshSidebar();
        if (requestGeneration !== conversationLoadGeneration) return;
        await loadConversation(id);
      } catch (e) {
        if (requestGeneration !== conversationLoadGeneration) return;
        ui.toast('Failed to create conversation: ' + e.message, 'error');
      } finally {
        newChatBtn.disabled = false;
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
    logAction('ok', 'system prompt will be reloaded on next send');
  });

  function wireNameSettings() {
    const playerInput = document.getElementById('playerNameInput');
    const botInput = document.getElementById('botNameInput');
    if (!window.Names) return;
    if (playerInput) { playerInput.value = Names.getPlayer(); playerInput.placeholder = Names.DEFAULT_PLAYER; }
    if (botInput) { botInput.value = Names.getBot(); botInput.placeholder = Names.DEFAULT_BOT; }
    function commit() {
      if (playerInput) Names.setPlayer(playerInput.value);
      if (botInput) Names.setBot(botInput.value);
      if (playerInput) playerInput.value = Names.getPlayer();
      if (botInput) botInput.value = Names.getBot();
      if (window.Prefs) Prefs.pushToServer();
      if (!abortFn && currentConversationId != null) loadConversation(currentConversationId);
    }
    if (playerInput) playerInput.addEventListener('change', commit);
    if (botInput) botInput.addEventListener('change', commit);
  }

  if (openSettingsBtn) openSettingsBtn.addEventListener('click', () => {
    setSidebarOpen(false);
    ui.toggleDrawer(true);
  });
  if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', () => ui.toggleDrawer(false));
  if (drawerBackdrop) drawerBackdrop.addEventListener('click', () => ui.toggleDrawer(false));

  const userChipBtn = document.getElementById('userChipBtn');
  if (userChipBtn) userChipBtn.addEventListener('click', () => {
    setSidebarOpen(false);
    ui.toggleDrawer(true);
  });

  const settingsNavItems = document.querySelectorAll('.settings-navitem');
  const settingsPanels = document.querySelectorAll('.settings-panel');
  const settingsPanelTitle = document.getElementById('settingsPanelTitle');
  settingsNavItems.forEach((item, idx) => {
    item.addEventListener('click', () => {
      const key = item.dataset.panel;
      settingsNavItems.forEach((n) => {
        const on = n === item;
        n.classList.toggle('active', on);
        n.setAttribute('aria-selected', on ? 'true' : 'false');
        n.tabIndex = on ? 0 : -1;
      });
      settingsPanels.forEach((p) => { p.hidden = p.dataset.panel !== key; });
      const label = item.querySelector('span');
      if (settingsPanelTitle && label) settingsPanelTitle.textContent = label.textContent;
      if (key === 'developer') loadMood(); // pull fresh scores when the panel opens
      if (key === 'memory') loadMemories();
    });
    item.tabIndex = item.classList.contains('active') ? 0 : -1;
    item.addEventListener('keydown', (e) => {
      let target = -1;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') target = (idx + 1) % settingsNavItems.length;
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') target = (idx - 1 + settingsNavItems.length) % settingsNavItems.length;
      else if (e.key === 'Home') target = 0;
      else if (e.key === 'End') target = settingsNavItems.length - 1;
      if (target < 0) return;
      e.preventDefault();
      settingsNavItems[target].focus();
      settingsNavItems[target].click();
    });
  });

  function updateTtsSpeedLabel() {
    const out = document.getElementById('ttsSpeedVal');
    if (out && ttsSpeedInput) out.textContent = parseFloat(ttsSpeedInput.value).toFixed(2).replace(/0$/, '') + '×';
  }
  function setSiteVolume(value) {
    const volume = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
    if (window.TTS && TTS.setVolume) TTS.setVolume(volume);
    return volume;
  }
  function updateSiteVolumeLabel() {
    const out = document.getElementById('siteVolumeVal');
    if (out && siteVolumeInput) out.textContent = Math.round(parseFloat(siteVolumeInput.value) || 0) + '%';
  }
  function updateVoiceSilenceLabel() {
    const out = document.getElementById('voiceSilenceVal');
    if (out && voiceSilenceInput) out.textContent = voiceSilenceInput.value + ' ms';
  }

  function syncVoiceDeps() {
    const on = { tts: !!(ttsChk && ttsChk.checked), mic: !!(voiceChk && voiceChk.checked) };
    document.querySelectorAll('#settingsDrawer .set-row[data-dep]').forEach((row) => {
      row.classList.toggle('disabled', !on[row.dataset.dep]);
    });
  }
  syncVoiceDeps();

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

  const EMOTION_TINTS = {
    angry:       { hue: 5,   sat: 20,  light: -8, w: .85 },
    crying:      { hue: 205, sat: -16, light: -6, w: .8 },
    sad:         { hue: 215, sat: -18, light: -4, w: .7 },
    surprised:   { hue: 15,  sat: 12,  light: 2,  w: .6 },
    embarrassed: { hue: 335, sat: 14,  light: 2,  w: .85 },
    excited:     { hue: 350, sat: 16,  light: 4,  w: .7 },
    laughing:    { hue: 340, sat: 14,  light: 4,  w: .6 },
    happy:       { hue: 330, sat: 10,  light: 3,  w: .5 },
    smug:        { hue: 300, sat: 8,   light: 0,  w: .45 },
    pout:        { hue: 250, sat: -6,  light: -2, w: .4 },
    sleepy:      { hue: 235, sat: -25, light: -6, w: .5 },
  };
  const TINT_EASE_MS = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200;
  const tint = { hue: 0, sat: 0, light: 0, w: 0 };
  const tintGoal = { hue: 0, sat: 0, light: 0, w: 0 };
  const moodBaseline = { affection: 50, trust: 50, tension: 30 };
  let tintFrame = 0;
  let lastTintTs = 0;

  const shortestArc = (a, b) => ((b - a) % 360 + 540) % 360 - 180;

  function noteEmotionTint(action) {
    let entry = null;
    let scale = 1;
    if (action.name === 'emote') {
      entry = EMOTION_TINTS[action.kwargs.type];
    } else if (action.name === 'brow') {
      const key = action.kwargs.emotion === 'worried' ? 'sad' : action.kwargs.emotion;
      entry = EMOTION_TINTS[key];
      scale = 0.55;
    } else if (action.name === 'blush') {
      entry = EMOTION_TINTS.embarrassed;
      const intensity = parseFloat(action.kwargs.intensity);
      scale = 0.45 * (isNaN(intensity) ? 0.5 : intensity);
    } else if (action.name === 'shocked') {
      entry = EMOTION_TINTS.surprised;
    } else if (action.name === 'heart_eyes') {
      entry = EMOTION_TINTS.embarrassed;
    }
    if (!entry) return;
    tintGoal.hue = entry.hue;
    tintGoal.sat = entry.sat;
    tintGoal.light = entry.light;
    tintGoal.w = entry.w * scale;
    startTintLoop();
  }

  function startTintLoop() {
    if (tintFrame) return;
    lastTintTs = 0;
    tintFrame = requestAnimationFrame(stepTint);
  }

  function stepTint(ts) {
    const dt = lastTintTs ? Math.min(100, ts - lastTintTs) : 16;
    lastTintTs = ts;
    tintGoal.w *= Math.exp(-dt / 2600);
    const k = TINT_EASE_MS ? 1 - Math.exp(-dt / TINT_EASE_MS) : 1;
    tint.hue += shortestArc(tint.hue, tintGoal.hue) * k;
    tint.sat += (tintGoal.sat - tint.sat) * k;
    tint.light += (tintGoal.light - tint.light) * k;
    tint.w += (tintGoal.w - tint.w) * k;
    paintAccent();
    if (tint.w > 0.004) {
      tintFrame = requestAnimationFrame(stepTint);
    } else {
      tint.w = 0;
      paintAccent();
      tintFrame = 0;
    }
  }

  function moodAccent(affection, trust, tension) {
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const a = clamp(affection / 100, 0, 1);
    const t = clamp(trust / 100, 0, 1);
    const x = clamp(tension / 100, 0, 1);
    const calm = 214 + a * 96;                   // distant blue → loving rose
    // tension pulls the whole accent toward the tension gauge colour (#ff7a55
    // in styles.css); at 100 it lands exactly on it, whatever affection/trust say.
    let hue = (calm + shortestArc(calm, 13) * x + 360) % 360;
    let sat = clamp((60 + t * 28) * (1 - x) + 100 * x, 42, 100);
    let light = clamp(74 * (1 - x) + 67 * x, 62, 78);
    if (tint.w > 0) {
      hue = (hue + shortestArc(hue, tint.hue) * tint.w + 360) % 360;
      sat = clamp(sat + tint.sat * tint.w, 38, 100);
      light = clamp(light + tint.light * tint.w, 56, 82);
    }
    return {
      accent: `hsl(${hue} ${sat}% ${light}%)`,
      accent2: `hsl(${hue + 16} ${clamp(sat + 6, 42, 100)}% ${clamp(light + 7, 62, 86)}%)`,
      soft: `hsl(${hue} ${sat}% ${light}% / .12)`,
    };
  }
  function paintAccent() {
    const c = moodAccent(moodBaseline.affection, moodBaseline.trust, moodBaseline.tension);
    const root = document.documentElement.style;
    root.setProperty('--accent', c.accent);
    root.setProperty('--accent-2', c.accent2);
    root.setProperty('--accent-soft', c.soft);
  }
  function applyMoodAccent(vals) {
    moodBaseline.affection = vals.affection ?? 50;
    moodBaseline.trust = vals.trust ?? 50;
    moodBaseline.tension = vals.tension ?? 30;
    paintAccent();
  }
  function currentMood() {
    const dflt = { affection: 50, trust: 50, tension: 30 };
    const v = {};
    for (const k of ['affection', 'trust', 'tension']) {
      v[k] = moodInputs[k] ? (parseInt(moodInputs[k].value, 10) || 0) : dflt[k];
    }
    return v;
  }
  function setMoodFill(k) {
    const input = moodInputs[k];
    if (!input) return;
    const min = Number(input.min);
    const max = Number(input.max);
    const t = (Number(input.value) - min) / (max - min);
    const row = input.closest('.mood-row') || input;
    const gauge = getComputedStyle(row).getPropertyValue('--gauge').trim();
    row.style.setProperty('--fill', t * 100 + '%');
    row.style.setProperty('--fill-color',
      `color-mix(in srgb, ${gauge} ${Math.round((0.25 + 0.75 * t) * 100)}%, var(--track-empty))`);
    row.style.setProperty('--glow',
      `color-mix(in srgb, ${gauge} ${Math.round(Math.max(0, t - 0.35) / 0.65 * 100)}%, transparent)`);
    setMoodPhrase(k, Number(input.value));
  }
  function setMoodPhrase(k, value) {
    const el = moodPhrases[k];
    if (!el) return;
    const band = (MOOD_PHRASES[k] || []).find(([min]) => value >= min);
    const text = band ? band[1] : '';
    const next = (text ? text.padEnd(30, '\u2003') : '').repeat(6);
    if (el.textContent === next) return;
    el.textContent = next;
  }
  function renderMood(state) {
    for (const k of ['affection', 'trust', 'tension']) {
      if (state && typeof state[k] === 'number') {
        if (moodInputs[k]) {
          moodInputs[k].value = state[k];
          setMoodFill(k);
        }
        if (moodVals[k]) moodVals[k].textContent = state[k];
      }
    }
    applyMoodAccent(currentMood());
    if (window.Live2D && Live2D.setMood) Live2D.setMood(state);
  }
  async function loadMood() {
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
    setMoodFill(k);
    moodInputs[k].addEventListener('input', () => {
      if (moodVals[k]) moodVals[k].textContent = moodInputs[k].value;
      setMoodFill(k);
      const live = {};
      for (const j of ['affection', 'trust', 'tension']) {
        if (moodInputs[j]) live[j] = parseInt(moodInputs[j].value, 10) || 0;
      }
      applyMoodAccent(live);
      if (window.Live2D && Live2D.setMood) Live2D.setMood(live);
    });
    moodInputs[k].addEventListener('change', pushMood);
  }
  applyMoodAccent(currentMood());
  if (moodRefreshBtn) moodRefreshBtn.addEventListener('click', loadMood);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.body.classList.contains('sidebar-open')) {
      setSidebarOpen(false);
      return;
    }
    const d = document.getElementById('settingsDrawer');
    if (d && d.classList.contains('open')) ui.toggleDrawer(false);
  });

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

  const authScreen = document.getElementById('authScreen');
  const authTabLogin = document.getElementById('authTabLogin');
  const authTabSignup = document.getElementById('authTabSignup');
  const authFormLogin = document.getElementById('authFormLogin');
  const authFormSignup = document.getElementById('authFormSignup');
  const signOutBtn = document.getElementById('signOutBtn');

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
    const me = await Auth.me().catch(() => null);
    if (!me) {
      showAuthScreen();
      return;
    }

    // The avatar stack and the per-feature scripts are worthless to a visitor
    // who never gets past the auth screen, so they are fetched only now.
    await loadScripts([
      ['vendor/pixi.min.js', 'vendor/live2dcubismcore.min.js',
       'vendor/marked.min.js', 'vendor/purify.min.js',
       'js/actions.js?v=10', 'js/outfit.js?v=34', 'js/touch.js?v=12',
       'js/mods.js?v=10', 'js/tts.js?v=15', 'js/voice.js?v=2',
       'js/voicemode.js?v=3', 'js/devhud.js?v=3', 'js/trip-loader.js?v=3',
       'js/wardrobe-open-lines.js?v=3', 'js/wardrobe-reactions.js?v=18',
       'js/wardrobe-return-lines.js?v=3'],
      ['vendor/cubism4.min.js'],
      ['js/live2d.js?v=29'],
    ]);

    // Both of these configure a lazily-loaded global, so they cannot run at
    // module scope any more - they would silently no-op before the load.
    marked.setOptions({ gfm: true, breaks: true });
    ModelTouch.init({
      sendEvent: sendTouchEvent,
      isBusy: () => !!abortFn,
      onTouch: () => {
        if (abortFn) return;
        idleNudgeStreak = 0;
        scheduleIdleNudge(IDLE_AFTER_REPLY_MS);
      },
    });

    // Coming back from the wardrobe, the return cutscene replaces the boot
    // terminal: skipping BootFX.start also makes BootFX.finish a no-op later.
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
      // Keep the shell hidden until the authenticated boot overlay fades out.
      showBoot();
    }

    const emailEl = document.getElementById('userEmail');
    if (me.user && emailEl) emailEl.textContent = me.user.email || '';

    // Hydrate synced preferences before modules read their local keys.
    if (window.Prefs) await Prefs.pullFromServer();
    if (window.Names) Names.load();
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
    // Pre-lock the composer until the first status check answers, but leave the
    // banner alone: it only ever speaks for a state the server confirmed, so a
    // normal load never flashes a consolidation notice it is about to retract.
    chatInput.disabled = true;
    sendBtn.disabled = true;
    await syncConsolidationStatus();
    reportActivity(true);

    Actions.setLogger(logAction);
    Live2D.setOnMissingParam(logMissing);
    if (window.DevHud) DevHud.init();

    try {
      const live2dInfo = await Live2D.init({ stageEl, onStatus: (m) => {
        setStageStatus(m);
        if (fromWardrobe) TripLoader.setStage(m);
      } });
      setTimeout(() => {
        setStageStatus(null);
        if (stageSkeleton) stageSkeleton.classList.add('hidden');
      }, 1500);
      if (fromWardrobe) {
        TripLoader.setStage('Home again');
        TripLoader.finish();
      }
      Live2D.startIdle();
      loadMood();

      await Actions.load('action_map.json');

      validateActionMap(live2dInfo.paramIds);

      Outfit.load();
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
      if (stageSkeleton) stageSkeleton.classList.add('hidden');
      if (fromWardrobe) TripLoader.fail('Live2D load error: ' + e.message);
      setStageStatus('Live2D load error: ' + e.message, true);
      ui.toast('Live2D load error: ' + e.message, 'error');
      ui.setStatus('error', 'error');
    }

    if (window.TTS) {
      TTS.setLogger(logAction);
      if (TTS.setOnAllDone) TTS.setOnAllDone(() => {
        finishPendingFaceBubbleHide();
        scheduleIdleNudge(IDLE_AFTER_REPLY_MS);
      });
      const savedEnabled = localStorage.getItem('tts.enabled') === '1';
      const savedVoice = localStorage.getItem('tts.voice') || '';
      const savedLang = localStorage.getItem('tts.lang') || '';
      const savedSpeed = parseFloat(localStorage.getItem('tts.speed') || '1.0');
      const savedEngine = localStorage.getItem('tts.engine') || 'kokoro';
      TTS.setSpeed(savedSpeed);
      if (ttsSpeedInput) ttsSpeedInput.value = String(savedSpeed);
      updateTtsSpeedLabel();

      let engines = {};
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

      // Language only applies to pocket-tts; the row stays hidden for engines that
      // don't advertise a `languages` list.
      function populateLanguages(engineKey, preferred) {
        const info = engines[engineKey] || {};
        const baseLangs = info.languages || [];
        if (ttsLangRow) ttsLangRow.hidden = baseLangs.length === 0;
        if (!baseLangs.length) { TTS.setLang(''); return ''; }
        // 'auto' is a client-side pseudo-language: TTS detects each reply's language
        // and sends a concrete id. It's the default so routing works out of the box.
        const langs = [{ id: 'auto', label: 'Auto-detect' }, ...baseLangs];
        const ids = langs.map(l => l.id);
        const def = (preferred && ids.includes(preferred)) ? preferred : 'auto';
        if (ttsLangSelect) {
          ttsLangSelect.innerHTML = langs.map(l =>
            `<option value="${escapeHtml(l.id)}">${escapeHtml(l.label || l.id)}</option>`).join('');
          ttsLangSelect.value = def;
        }
        TTS.setLang(def);
        return def;
      }

      try {
        const v = await TTS.listVoices();
        engines = v.engines || {};
        if (ttsEngineSelect) {
          const ENGINE_LABELS = { kokoro: 'Kokoro', pockettts: 'Pocket-TTS' };
          ttsEngineSelect.innerHTML = Object.keys(engines).map(k =>
            `<option value="${escapeHtml(k)}">${escapeHtml(ENGINE_LABELS[k] || k)}</option>`).join('');
        }
        const engineKey = engines[savedEngine] ? savedEngine
          : (engines[v.default_engine] ? v.default_engine : Object.keys(engines)[0] || 'kokoro');
        TTS.setEngine(engineKey);
        if (ttsEngineSelect) ttsEngineSelect.value = engineKey;
        const def = populateVoices(engineKey, savedVoice);
        populateLanguages(engineKey, savedLang);
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
          const def = populateVoices(engineKey, '');
          localStorage.setItem('tts.voice', def);
          const langDef = populateLanguages(engineKey, localStorage.getItem('tts.lang') || '');
          if (langDef) localStorage.setItem('tts.lang', langDef);
          if (window.Prefs) Prefs.pushToServer();
        });
      }

      if (ttsChk) {
        ttsChk.checked = savedEnabled;
        TTS.setEnabled(savedEnabled);
        ttsChk.addEventListener('change', () => {
          TTS.setEnabled(ttsChk.checked);
          if (!ttsChk.checked) finishPendingFaceBubbleHide();
          localStorage.setItem('tts.enabled', ttsChk.checked ? '1' : '0');
          syncVoiceDeps();
          if (window.Prefs) Prefs.pushToServer();
        });
        syncVoiceDeps();
      }
      if (ttsVoiceSelect) {
        ttsVoiceSelect.addEventListener('change', () => {
          TTS.setVoice(ttsVoiceSelect.value);
          localStorage.setItem('tts.voice', ttsVoiceSelect.value);
          if (window.Prefs) Prefs.pushToServer();
        });
      }
      if (ttsLangSelect) {
        ttsLangSelect.addEventListener('change', () => {
          TTS.setLang(ttsLangSelect.value);
          localStorage.setItem('tts.lang', ttsLangSelect.value);
          if (window.Prefs) Prefs.pushToServer();
        });
      }
      if (ttsSpeedInput) {
        ttsSpeedInput.addEventListener('input', updateTtsSpeedLabel);
        ttsSpeedInput.addEventListener('change', () => {
          const s = parseFloat(ttsSpeedInput.value) || 1.0;
          TTS.setSpeed(s);
          localStorage.setItem('tts.speed', String(s));
          if (window.Prefs) Prefs.pushToServer();
        });
      }
    }

    if (window.Voice && voiceChk) {
      Voice.setLogger(logAction);
      Voice.setOnTranscript(sendFromVoice);
      Voice.setOnBargeIn(() => { if (stopActiveStream) stopActiveStream(); });
      const voiceOverlayStatus = document.getElementById('voiceOverlayStatus');
      Voice.setOnState((s) => {
        if (voiceState) {
          voiceState.textContent = VOICE_STATE_LABELS[s] || s;
          voiceState.dataset.state = s;
        }
        if (voiceOverlayStatus) {
          voiceOverlayStatus.textContent = VOICE_STATE_LABELS[s] || s;
          voiceOverlayStatus.dataset.state = s;
        }
      });

      if (window.VoiceMode) {
        VoiceMode.init({
          sttAvailable,
          onEnter: hideFaceBubble,
          onExitMidStream: () => { if (renderVoiceDraft) renderVoiceDraft(); },
        });
      }

      const sup = Voice.support();
      const sttOk = await sttAvailable();
      if (!sup.ok || !sttOk) {
        voiceChk.disabled = true;
        const why = !sup.ok
          ? (sup.reason === 'insecure_context'
              ? 'needs HTTPS (or localhost) - see TLS_MODE in .env'
              : sup.reason === 'no_getusermedia'
                ? 'no microphone API in this browser'
                : 'no AudioWorklet in this browser')
          : 'sidecar has no speech-to-text (rebuild the tts image)';
        if (voiceState) voiceState.textContent = 'unavailable';
        const voiceModeBtn = document.getElementById('voiceModeBtn');
        if (voiceModeBtn) { voiceModeBtn.disabled = true; voiceModeBtn.title = `Voice mode unavailable: ${why}`; }
        logAction('warn', `Voice mode unavailable: ${why}`);
      } else {
        const savedBarge = localStorage.getItem('voice.bargein') !== '0';
        const savedSilence = parseInt(localStorage.getItem('voice.silence_ms') || '700', 10);
        Voice.setBargeIn(savedBarge);
        Voice.setSilenceMs(savedSilence);
        if (voiceBargeChk) voiceBargeChk.checked = savedBarge;
        if (voiceSilenceInput) voiceSilenceInput.value = String(savedSilence);
        updateVoiceSilenceLabel();

        // A hot mic is an explicit per-session choice, never a synced preference.
        voiceChk.checked = false;
        voiceChk.addEventListener('change', async () => {
          if (voiceChk.checked) {
            try {
              await Voice.enable();
              syncVoiceDeps();
            } catch (e) {
              voiceChk.checked = false;
              syncVoiceDeps();
              ui.toast('⚠ Mic blocked - check the browser permission', 'error');
            }
          } else {
            Voice.disable();
            syncVoiceDeps();
          }
        });

        if (voiceBargeChk) {
          voiceBargeChk.addEventListener('change', () => {
            Voice.setBargeIn(voiceBargeChk.checked);
            localStorage.setItem('voice.bargein', voiceBargeChk.checked ? '1' : '0');
            if (window.Prefs) Prefs.pushToServer();
          });
        }
        if (voiceSilenceInput) {
          voiceSilenceInput.addEventListener('input', updateVoiceSilenceLabel);
          voiceSilenceInput.addEventListener('change', () => {
            const ms = parseInt(voiceSilenceInput.value, 10) || 700;
            Voice.setSilenceMs(ms);
            localStorage.setItem('voice.silence_ms', String(ms));
            if (window.Prefs) Prefs.pushToServer();
          });
        }
      }
    }

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
      const phases = [
        'Waking the model',
        'Brewing Coffee for Anon',
        'Recharging Jun',
        'Jun is taking its time',
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
          setBoot(phase, 'Jun is still sleeping - retrying…', 'err');
        }
        await new Promise(r => setTimeout(r, Math.min(1000 + attempt * 250, 3000)));
      }
    }

    const m = await waitForProvider();
    modelSelect.innerHTML = m.models.map(n =>
      `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
    const prefer = [
      'hf.co/efficiencyx/Jun-LoRA-v4-12B-GGUF:Q8_0',
      'hf.co/efficiencyx/Jun-LoRA-v4-12B-GGUF:Q6_K',
      'hf.co/efficiencyx/Jun-LoRA-v4-12B-GGUF:Q5_K_M',
      'hf.co/efficiencyx/Jun-LoRA-v4-12B-GGUF:Q4_K_M',
      'hf.co/efficiencyx/Jun-LoRA-v4-12B-GGUF:Q3_K_M',
      'hf.co/efficiencyx/Jun-LoRA-v4-E4B-GGUF:Q8_0',
      'hf.co/efficiencyx/Jun-LoRA-v4-E4B-GGUF:Q6_K',
      'hf.co/efficiencyx/Jun-LoRA-v4-E4B-GGUF:Q4_K_M',
      'hf.co/efficiencyx/Jun-LoRA-v4-E2B-GGUF:Q8_0',
      'hf.co/efficiencyx/Jun-LoRA-v4-E2B-GGUF:Q6_K',
      'hf.co/efficiencyx/Jun-LoRA-v4-E2B-GGUF:Q4_K_M',
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
})();
