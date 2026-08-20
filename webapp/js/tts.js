window.TTS = (function () {
  const TTS_URL = '/api/tts.php';

  let enabled = false;
  let engine = 'kokoro';
  let voice = 'af_heart';
  // lang is a pocket-tts thing. Kokoro ignores it completely, and
  // autoLang just lets the reply text pick one.
  let lang = 'english';
  let autoLang = false;
  let speed = 1.0;
  let volume = 1.0;
  let duckLevel = 1.0;
  let onLog = () => {};

  let audioCtx = null;
  let analyser = null;
  let analyserBuf = null;
  let masterGain = null;

  let jobs = [];
  let nextId = 1;
  let playingJobId = 0;
  let currentSource = null;
  let rafId = 0;
  let sentenceBuf = '';
  let chunkIndex = 0;

  let speaking = false;
  let onAllDone = () => {};
  function setOnAllDone(fn) { onAllDone = fn || (() => {}); }
  function isSpeaking() {
    return playingJobId !== 0 ||
      jobs.some(j => j.status === 'queued' || j.status === 'pending' ||
                     j.status === 'ready' || j.status === 'playing');
  }
  function checkDrain() {
    if (speaking && !isSpeaking()) { speaking = false; onAllDone(); }
  }

  function ensureCtx() {
    if (audioCtx) return audioCtx;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = volume * duckLevel;
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.4;
    analyserBuf = new Float32Array(analyser.fftSize);
    analyser.connect(masterGain);
    masterGain.connect(audioCtx.destination);
    return audioCtx;
  }

  function setEnabled(b) {
    enabled = !!b;
    if (!enabled) stop();
  }
  function isEnabled() { return enabled; }

  function setEngine(e) { if (e) engine = e; }
  function setVoice(v) { if (v) voice = v; }
  // 'auto' turns detection on per reply, a real id pins that language. the
  // detector only ever hands back ids the sidecar knows, so 'auto' NEVER
  // leaves this file.
  function setLang(l) {
    if (!l) return;
    if (l === 'auto') { autoLang = true; return; }
    autoLang = false; lang = l;
  }
  function setSpeed(s) { speed = Math.max(0.5, Math.min(2.0, s || 1.0)); }
  function applyOutputGain() {
    if (!masterGain || !audioCtx) return;
    const t = audioCtx.currentTime;
    masterGain.gain.cancelScheduledValues(t);
    masterGain.gain.setTargetAtTime(volume * duckLevel, t, 0.02);
  }
  function setVolume(v) {
    volume = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 1));
    applyOutputGain();
  }
  function setLogger(fn) { onLog = fn || (() => {}); }

  async function listVoices() {
    try {
      const r = await fetch(`${TTS_URL}?action=voices`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`http ${r.status}`);
      return await r.json();
    } catch (e) {
      onLog('warn', `TTS /voices failed: ${e.message} (sidecar running?)`);
      return { engines: {}, default_engine: engine };
    }
  }

  // only the FIRST chunk gets split early. audio comes out sooner and we
  // don't make every sentence sound like it's ending. Jun's playful "~" is
  // always a break, so each bit between tildes becomes its own utterance
  // and the voice can fall at the end instead of running into the next one
  const HARD_BREAK_RE = /[.!?~\n]/;
  // only real punctuation breaks a chunk. keep dashes OUT, an ASCII hyphen
  // lands mid-word ("co-op", Jun's "H-hey" stutters) and putting it in the
  // class between the colon and an en dash silently made a range over every
  // letter, which cut the first chunk at whatever character followed the
  // third word. took a while to find that one
  const SOFT_BREAK_RE = /[,;:]/g;
  // "Oh," on its own reads as a whole falling utterance. wait for
  // three words before the first soft split.
  const MIN_FIRST_WORDS = 3;

  function wordCount(s) {
    const m = s.match(/\S+/g);
    return m ? m.length : 0;
  }

  function cutAt(buf, i) {
    return { chunk: buf.slice(0, i + 1), rest: buf.slice(i + 1) };
  }

  // a run of dots is her trailing off, not the end of a sentence. break
  // inside it and we get lone "." chunks, cleanForSpeech throws those away,
  // and the pause the engines give "..." is just gone. so a single dot at
  // the end waits for the next token, it might be the first of three.
  function hardBreak(buf) {
    for (let i = 0; i < buf.length; i++) {
      if (!HARD_BREAK_RE.test(buf[i])) continue;
      if (buf[i] === '.') {
        let end = i;
        while (buf[end + 1] === '.') end++;
        if (end > i) { i = end; continue; }
        if (i === buf.length - 1) return -1;
      }
      return i;
    }
    return -1;
  }

  function nextChunk(buf, first) {
    const hard = hardBreak(buf);
    if (!first) return hard < 0 ? null : cutAt(buf, hard);

    let soft = -1;
    SOFT_BREAK_RE.lastIndex = 0;
    let m;
    while ((m = SOFT_BREAK_RE.exec(buf))) {
      if (wordCount(buf.slice(0, m.index)) >= MIN_FIRST_WORDS) { soft = m.index; break; }
    }

    const cands = [hard, soft].filter(i => i >= 0);
    if (cands.length) return cutAt(buf, Math.min.apply(null, cands));

    return null;
  }

  const ACTION_RE = /\[\s*A(?:CTIONS?)?\s*:[^\]]*\]?/gi;
  const MARKDOWN_NOISE_RE = /[*_~`#>]+/g;
  const EMOJI_RE = /[\p{Extended_Pictographic}️‍]/gu;
  // pocket-tts reads a stutter start as the NAME of the letter, so "H-hey"
  // comes out "aitch hey". amazing. so we drop them. same letter both sides
  // of the hyphen is a stutter, different letters like T-shirt, x-ray or
  // co-op we leave alone.
  const STUTTER_RE = /([a-z])-(?=\1)/gi;

  function cleanForSpeech(s) {
    s = s.replace(ACTION_RE, '');
    s = s.replace(EMOJI_RE, '');
    s = s.replace(MARKDOWN_NOISE_RE, '');
    if (engine === 'pockettts') s = s.replace(STUTTER_RE, '');
    s = s.replace(/\s+/g, ' ').trim();
    if (!/[\p{L}\p{N}]/u.test(s)) return '';
    return s;
  }

  // pick the pocket-tts language off the reply itself. a dumb stopword
  // check is genuinely enough to tell the six pocket languages apart on a
  // sentence or two, and it needs zero libraries. keys are the sidecar's
  // language ids. we strip accents before matching so "tres" hits the
  // accented spelling too (those forms are folded into the ASCII lists),
  // and a few characters that give a strong hint get their own score.
  const STOPWORDS = {
    english: 'the and you that is are was were this with have not but what your they for can will here there about just like know really yeah',
    french_24l: 'je tu vous nous est sont les une des pas ne que qui pour dans avec mais tres oui bonjour merci moi toi etre fait comme cette suis',
    german_24l: 'der die das und ist sind nicht ich du wir ein eine mit auf fur aber auch wie was sehr ja mehr noch schon hier jetzt dich mich bitte danke',
    italian: 'il lo gli le un una che non sono per con mio tuo sei ma piu molto come cosa ecco si anche questo adesso grazie ciao bene fare degli della dello nella sulla quello allora ancora niente qualcosa insieme davvero proprio magari quindi comunque cioe sempre dimmi senti guarda faccio voglio sto stai vado dai amore cosi perche pero quando dove tutto tanto oggi domani forse certo vero mi ti ho hai',
    portuguese: 'os as um uma que nao voce para com meu sua mas mais muito como isso sim entao obrigado ola tudo bem agora fazer aqui tao',
    spanish_24l: 'el los las un una que no es con para mi tu pero mas muy como qué si esto esta hola gracias ahora aqui bien hacer tan muchas',
  };
  const STOP = Object.fromEntries(
    Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v.split(' '))]));
  const DETECT_LOCK_CHARS = 40;

  function detectLang(text) {
    const raw = text.toLowerCase();
    const toks = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[a-z]+/g) || [];
    if (toks.length < 2) return null;
    const score = { english: 0, french_24l: 0, german_24l: 0, italian: 0, portuguese: 0, spanish_24l: 0 };
    for (const t of toks) for (const k in STOP) if (STOP[k].has(t)) score[k]++;
    if (/ß/.test(raw)) score.german_24l += 2;
    if (/[ñ¿¡]/.test(raw)) score.spanish_24l += 2;
    if (/[ãõ]/.test(raw)) score.portuguese += 2;
    const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
    const [bestLang, bestScore] = ranked[0];
    // null means we genuinely have no idea yet, so the caller keeps the
    // language it already had instead of yeeting to English off one "no"
    // or "la" or "ok"
    if (bestScore < 2 || bestScore <= ranked[1][1]) return null;
    if (bestLang === 'english') return 'english';
    if (bestScore - score.english >= 2) return bestLang;
    return null;
  }

  // conversation's language is the fallback. one short reply must
  // NEVER reset an Italian chat to English.
  let lastLang = 'english';
  let detectBuf = '';
  let replyLang = null;
  let replyLangLocked = false;

  // guess off your message so the caller can start loading the right
  // pocket-tts model while Jun is still writing. can't tell? keep the
  // language the conversation is already in. not English.
  function predictLang(text) {
    if (!enabled || !autoLang || engine !== 'pockettts') return null;
    return detectLang(text || '') || lastLang;
  }

  function warmLang(l) {
    if (!enabled || !autoLang || engine !== 'pockettts' || !l) return;
    fetch(`${TTS_URL}?action=warm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang: l, voice, engine }),
    }).catch(() => {});
  }

  function setReplyLang(l) {
    if (!autoLang || engine !== 'pockettts') return;
    replyLang = l || lastLang;
    replyLangLocked = false;
  }

  // check the guess against the reply we actually got. only a clear
  // disagreement in the first words changes the language, and once locked
  // it Never moves again, so one foreign word mid-reply can't trigger a
  // model reload.
  function updateDetect(text) {
    if (!autoLang || engine !== 'pockettts' || replyLangLocked) return;
    detectBuf += ' ' + text;
    const guess = detectLang(detectBuf);
    if (guess) {
      if (guess !== replyLang) { replyLang = guess; warmLang(guess); }
      if (detectBuf.length >= DETECT_LOCK_CHARS) replyLangLocked = true;
    }
  }

  function effectiveLang() {
    if (!autoLang || engine !== 'pockettts') return lang;
    return replyLang || lastLang;
  }

  function feed(textChunk) {
    if (!enabled || !textChunk) return;
    sentenceBuf += textChunk;
    while (true) {
      const r = nextChunk(sentenceBuf, chunkIndex === 0);
      if (!r) break;
      sentenceBuf = r.rest;
      const clean = cleanForSpeech(r.chunk);
      if (clean) { enqueue(clean); chunkIndex++; }
    }
  }

  function flush() {
    if (!enabled) { sentenceBuf = ''; resetReply(); return; }
    const tail = sentenceBuf.trim();
    sentenceBuf = '';
    if (tail) {
      const clean = cleanForSpeech(tail);
      if (clean) { enqueue(clean); chunkIndex++; }
    }
    resetReply();
  }

  function resetReply() {
    chunkIndex = 0;
    firstChunkSynthed = false;
    if (replyLang) lastLang = replyLang;
    detectBuf = '';
    replyLangLocked = false;
  }

  // first chunk gets the machine to itself. later ones can overlap
  const MAX_IN_FLIGHT = 3;
  let inFlight = 0;
  let firstChunkSynthed = false;

  function enqueue(text, hooks) {
    ensureCtx();
    // chrome's autoplay rules keep the context asleep until you click something
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});

    updateDetect(text);
    const id = nextId++;
    const job = {
      id, text,
      // each chunk keeps the language it started with. a later guess
      // must not rewrite one already in flight
      lang: effectiveLang(),
      abort: new AbortController(),
      status: 'queued',
      audioBuffer: null,
      hooks: hooks || null,
    };
    jobs.push(job);
    speaking = true;
    kick();
  }

  function kick() {
    const cap = firstChunkSynthed ? MAX_IN_FLIGHT : 1;
    for (const job of jobs) {
      if (inFlight >= cap) break;
      if (job.status === 'queued') startJob(job);
    }
  }

  function startJob(job) {
    job.status = 'pending';
    inFlight++;

    job.blobPromise = (async () => {
      try {
        const res = await fetch(`${TTS_URL}?action=tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: job.text, voice, speed, engine, lang: job.lang }),
          signal: job.abort.signal,
        });
        // 204 (nothing to say) is still a 2xx, so !res.ok won't catch it
        if (res.status === 204) { job.status = 'done'; return; }
        if (!res.ok) throw new Error(`TTS http ${res.status}`);
        const arr = await res.arrayBuffer();
        if (job.status === 'cancelled') return;
        const buf = await audioCtx.decodeAudioData(arr);
        job.audioBuffer = buf;
        job.status = 'ready';
      } catch (e) {
        if (e.name === 'AbortError') { job.status = 'cancelled'; return; }
        job.status = 'error';
        if (job.hooks && job.hooks.onError) job.hooks.onError(e);
        onLog('warn', `TTS error: ${e.message}`);
      } finally {
        inFlight = Math.max(0, inFlight - 1);
        // open the window even when chunk 0 failed, or one error pins the
        // whole reply at cap 1. but NOT when it was cancelled. that job
        // belongs to a reply stop() already killed, and letting it through
        // uncaps the *next* reply's chunk 0 and undoes the entire point.
        if (job.status !== 'cancelled') firstChunkSynthed = true;
        kick();
        pump();
      }
    })();
  }

  function pump() {
    if (playingJobId) return;
    while (jobs.length && (jobs[0].status === 'done' || jobs[0].status === 'cancelled' || jobs[0].status === 'error')) {
      jobs.shift();
    }
    if (!jobs.length) { checkDrain(); return; }
    const head = jobs[0];
    if (head.status !== 'ready') return;
    playJob(head);
  }

  function playJob(job) {
    if (!job.audioBuffer) { job.status = 'done'; jobs.shift(); pump(); return; }
    playingJobId = job.id;
    job.status = 'playing';

    const src = audioCtx.createBufferSource();
    src.buffer = job.audioBuffer;
    src.connect(analyser);
    currentSource = src;

    if (!rafId) startLipsyncLoop();

    src.onended = () => {
      if (currentSource === src) currentSource = null;
      job.status = 'done';
      const idx = jobs.indexOf(job);
      if (idx >= 0) jobs.splice(idx, 1);
      playingJobId = 0;
      if (!jobs.length || !jobs.some(j => j.status === 'playing' || j.status === 'ready' || j.status === 'pending')) {
        stopLipsyncLoop();
      }
      if (job.hooks && job.hooks.onDone) job.hooks.onDone();
      pump();
    };
    if (job.hooks && job.hooks.onStart) job.hooks.onStart();
    src.start();
  }

  function speak(text, hooks) {
    if (!enabled || !cleanForSpeech(text)) return false;
    stop();
    enqueue(cleanForSpeech(text), hooks);
    return true;
  }

  // the mic hears whatever Jun is saying. browser AEC eats most of it, but
  // what's left scales with how loud she is right NOW, so voice.js raises
  // its speech threshold by that much instead of some fixed step.
  //
  // a ring buffer, not one value. the echo reaching the mic lags what the
  // analyser sees by the output buffer plus the trip through the air, call
  // it 30-150ms and worse on bluetooth. callers take the max over a window
  // so they never have to know the real delay. old entries fall out on
  // their own, so once playback stops this is 0 again inside the window,
  // which conveniently also covers the AEC tail after stop().
  const RMS_HISTORY_MS = 400;
  let rmsHistory = [];

  function computeRms() {
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(analyserBuf);
    let sum = 0;
    for (let i = 0; i < analyserBuf.length; i++) {
      const v = analyserBuf[i];
      sum += v * v;
    }
    return Math.sqrt(sum / analyserBuf.length);
  }

  function pushRms(rms) {
    const now = performance.now();
    rmsHistory.push({ t: now, rms });
    const cutoff = now - RMS_HISTORY_MS;
    while (rmsHistory.length && rmsHistory[0].t < cutoff) rmsHistory.shift();
  }

  function outputRms(windowMs) {
    // take the sample HERE instead of trusting the lipsync loop to have done
    // it. that loop runs on rAF and stops dead in a hidden tab. playback does
    // not. neither does voice.js's worklet. so without this a backgrounded
    // tab reports 0 while Jun is obviously talking, the echo threshold falls
    // to nothing, and she cuts herself off. voice.js asks every ~32ms so the
    // history stays thick enough for the max below.
    pushRms(computeRms());
    const cutoff = performance.now() - (windowMs || 200);
    let max = 0;
    for (let i = rmsHistory.length - 1; i >= 0; i--) {
      if (rmsHistory[i].t < cutoff) break;
      if (rmsHistory[i].rms > max) max = rmsHistory[i].rms;
    }
    return max * volume * duckLevel;
  }

  // duck instead of cutting while barge-in is still a maybe. dropping ~9dB
  // gives the VAD a clean look at the mic to figure out if you're actually
  // talking, and if you aren't, Jun just goes quiet for 150ms instead of
  // getting chopped mid word. voice.js only calls stop() once it's sure.
  function duck(gain) {
    duckLevel = Math.max(0, Math.min(1, gain));
    applyOutputGain();
  }

  function startLipsyncLoop() {
    if (rafId) return;
    const tick = () => {
      rafId = 0;
      if (!analyser) return;
      const rms = computeRms();
      pushRms(rms);
      const norm = Math.min(1, rms * 3.5);
      const shaped = Math.pow(norm, 0.7);
      if (window.Live2D && Live2D.setMouthOverride) Live2D.setMouthOverride(shaped);
      if (currentSource || jobs.length) rafId = requestAnimationFrame(tick);
      else stopLipsyncLoop();
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopLipsyncLoop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (window.Live2D && Live2D.setMouthOverride) Live2D.setMouthOverride(null);
  }

  function stop() {
    sentenceBuf = '';
    speaking = false;
    duck(1);
    for (const j of jobs) {
      if (j.status === 'queued' || j.status === 'pending' || j.status === 'ready') {
        try { j.abort.abort(); } catch (e) {}
        j.status = 'cancelled';
      }
    }
    jobs = [];
    // do NOT zero inFlight here. the aborts above come back through
    // startJob's finally which already takes one off. zeroing sends it
    // negative. don't ask.
    resetReply();
    playingJobId = 0;
    if (currentSource) {
      try { currentSource.onended = null; currentSource.stop(); } catch (e) {}
      try { currentSource.disconnect(); } catch (e) {}
      currentSource = null;
    }
    stopLipsyncLoop();
  }

  return {
    setEnabled, isEnabled,
    setEngine, setVoice, setLang, setSpeed, setVolume,
    setLogger,
    listVoices,
    feed, flush, stop, speak,
    isSpeaking, setOnAllDone,
    outputRms, duck,
    predictLang, warmLang, setReplyLang,
  };
})();
