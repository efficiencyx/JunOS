// Bootstrap + chat loop. Streams tokens, parses [ACTION:...] inline,
// dispatches to Live2D as soon as a complete action block is seen.

(function () {
  const messagesEl = document.getElementById('messages');
  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const clearChatBtn = document.getElementById('clearChatBtn');
  const modelSelect = document.getElementById('modelSelect');
  const reasoningSelect = document.getElementById('reasoningSelect');
  const thinkChk = document.getElementById('thinkChk');
  const reloadPromptBtn = document.getElementById('reloadPromptBtn');
  const actionLogEl = document.getElementById('actionLog');
  const actionLogCount = document.getElementById('actionLogCount');
  const missingParamsEl = document.getElementById('missingParams');
  const rawStreamEl = document.getElementById('rawStream');
  const clearRawBtn = document.getElementById('clearRawBtn');
  const stageEl = document.getElementById('stage');
  const stageStatus = document.getElementById('stageStatus');
  const resetLive2DBtn = document.getElementById('resetLive2DBtn');
  const ttsChk = document.getElementById('ttsChk');
  const ttsVoiceSelect = document.getElementById('ttsVoiceSelect');
  const ttsSpeedInput = document.getElementById('ttsSpeed');

  const messages = []; // {role:'user'|'assistant', content:string}
  let logCount = 0;
  let abortFn = null;
  let autoResetTimer = null;

  const AUTO_RESET_MS = 3000;

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

  // Configure marked: GFM, line breaks → <br>, no auto-linking of headers etc.
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
    return el;
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

  // ---- Streaming buffer with inline [ACTION:...] extraction ---------------
  // Holds accumulated text, finds complete actions (closed by ']'), dispatches them
  // and removes them from the visible text. If a partial '[ACTION:' is at the tail
  // we keep it in the buffer until closed.
  // The marker we look for. We must hold back any tail that *could* be the start
  // of this marker so it isn't emitted as visible text.
  const MARK = '[ACTION:';
  const MARK_LC = MARK.toLowerCase();

  // Case-insensitive indexOf for MARK.
  function findMark(s, from = 0) {
    return s.toLowerCase().indexOf(MARK_LC, from);
  }

  // Returns the longest suffix of `s` that is a prefix of MARK (other than full match), case-insensitive.
  function pendingMarkerSuffix(s) {
    const max = Math.min(s.length, MARK.length - 1);
    const sl = s.toLowerCase();
    for (let n = max; n > 0; n--) {
      if (sl.endsWith(MARK_LC.slice(0, n))) return n;
    }
    return 0;
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

  // ---- Send flow ----------------------------------------------------------

  async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text || abortFn) return;

    cancelAutoReset();
    chatInput.value = '';
    appendMsg('user', text);
    messages.push({ role: 'user', content: text });

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
    let stopped = false;
    const onClickStop = () => {
      if (abortFn) abortFn();
      if (window.TTS) TTS.stop();
      stopped = true;
    };
    sendBtn.addEventListener('click', onClickStop, { once: true });

    appendRaw('--- ' + new Date().toLocaleTimeString() + ' ---\n');
    abortFn = Ollama.chat(
      { messages: [...messages], model: modelSelect.value,
        reasoning: reasoningSelect.value, think: thinkChk.checked,
        outfit_context: Outfit.describe() },
      {
        onToken: (tok) => { appendRaw(tok); stream.push(tok); },
        onDone: () => {
          stream.flush();
          if (window.TTS) TTS.flush();
          typing.remove();
          messages.push({ role: 'assistant', content: visible });
          finalize();
          scheduleAutoReset();
        },
        onError: (err) => {
          stream.flush();
          if (window.TTS) TTS.flush();
          typing.remove();
          appendMsg('error', '⚠ ' + err.message);
          finalize();
          scheduleAutoReset();
        },
      }
    );

    function finalize() {
      abortFn = null;
      sendBtn.disabled = false;
      sendBtn.textContent = 'Invia';
      sendBtn.removeEventListener('click', onClickStop);
    }
  }

  // ---- Wire UI ------------------------------------------------------------

  sendBtn.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  function appendRaw(text) {
    rawStreamEl.append(document.createTextNode(text));
    rawStreamEl.scrollTop = rawStreamEl.scrollHeight;
  }
  clearRawBtn.addEventListener('click', () => { rawStreamEl.textContent = ''; });

  clearChatBtn.addEventListener('click', () => {
    cancelAutoReset();
    if (window.TTS) TTS.stop();
    messages.length = 0;
    messagesEl.innerHTML = '';
    Live2D.resetIdle();
    Live2D.startIdle();
  });
  resetLive2DBtn.addEventListener('click', () => {
    cancelAutoReset();
    Live2D.resetIdle();
    Live2D.startIdle();
    logAction('ok', '↺ reset pose');
  });
  reloadPromptBtn.addEventListener('click', () => {
    // Server reads prompt fresh each request, so this is mostly a hint.
    logAction('ok', 'system prompt verrà riletto al prossimo invio');
  });

  // ---- Bootstrap ----------------------------------------------------------

  (async function bootstrap() {
    Actions.setLogger(logAction);
    Live2D.setOnMissingParam(logMissing);

    try {
      const live2dInfo = await Live2D.init({ stageEl, onStatus: (m) => setStageStatus(m) });
      setTimeout(() => setStageStatus(null), 1500);
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
      setStageStatus('Errore caricamento Live2D: ' + e.message, true);
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
        if (voices.length) logAction('ok', `TTS pronto: ${voices.length} voci`);
      } catch (e) {
        logAction('warn', 'TTS sidecar non raggiungibile (avvia tts/run.sh)');
      }

      if (ttsChk) {
        ttsChk.checked = savedEnabled;
        TTS.setEnabled(savedEnabled);
        ttsChk.addEventListener('change', () => {
          TTS.setEnabled(ttsChk.checked);
          localStorage.setItem('tts.enabled', ttsChk.checked ? '1' : '0');
        });
      }
      if (ttsVoiceSelect) {
        ttsVoiceSelect.addEventListener('change', () => {
          TTS.setVoice(ttsVoiceSelect.value);
          localStorage.setItem('tts.voice', ttsVoiceSelect.value);
        });
      }
      if (ttsSpeedInput) {
        ttsSpeedInput.addEventListener('change', () => {
          const s = parseFloat(ttsSpeedInput.value) || 1.0;
          TTS.setSpeed(s);
          localStorage.setItem('tts.speed', String(s));
        });
      }
    }

    try {
      const m = await Ollama.listModels();
      if (m.models && m.models.length) {
        modelSelect.innerHTML = m.models.map(n =>
          `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
        // Prefer qwen2.5 / llama3.1 if present.
        const prefer = ['qwen2.5:7b', 'qwen2.5:latest', 'llama3.1:8b', 'llama3.1:latest'];
        for (const p of prefer) {
          if (m.models.includes(p)) { modelSelect.value = p; break; }
        }
      } else {
        modelSelect.innerHTML = `<option value="qwen2.5:7b">qwen2.5:7b (default)</option>`;
      }
    } catch (e) {
      modelSelect.innerHTML = `<option value="qwen2.5:7b">qwen2.5:7b (default)</option>`;
      logAction('err', 'Ollama non raggiungibile (verifica `ollama serve`)');
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
        logAction('warn', `boot: ${missing.length} param mancanti nel modello: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}`);
        for (const p of missing) {
          const row = document.createElement('div');
          row.className = 'row warn';
          row.textContent = p;
          missingParamsEl.appendChild(row);
        }
      } else {
        logAction('ok', `boot: tutti i ${referenced.size} param mappati esistono`);
      }
    });
  }
})();
