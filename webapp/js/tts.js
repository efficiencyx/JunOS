// TTS client (kokoro / pockettts engines): sentence queue → fetch /tts → ordered AudioContext playback
// + AnalyserNode-driven ParamMouthOpen lipsync.
//
// Pipeline (per chat reply):
//   feed(textChunk) accumulates and emits sentences at . ! ? \n boundaries
//   each sentence becomes a Job with an id (monotonic) - kicked off in parallel
//   jobs play in submission order regardless of which finishes first
//   stop() aborts in-flight fetches, halts current source, releases the mouth

window.TTS = (function () {
  const TTS_URL = '/api/tts.php';

  let enabled = false;
  let engine = 'kokoro';
  let voice = 'af_heart';
  let speed = 1.0;
  let onLog = () => {};

  let audioCtx = null;
  let analyser = null;
  let analyserBuf = null;
  let masterGain = null;

  // Job queue. Each job: { id, text, abort, blobPromise, status }
  // status: 'queued' | 'pending' | 'ready' | 'playing' | 'done' | 'cancelled' | 'error'
  //   queued  - accepted, not yet fetched (waiting on the in-flight cap)
  //   pending - fetch/synthesis in flight
  let jobs = [];
  let nextId = 1;
  let playingJobId = 0;     // id currently playing, 0 if none
  let currentSource = null; // AudioBufferSourceNode in flight
  let rafId = 0;
  let sentenceBuf = '';     // text accumulated but not yet split into a chunk
  let chunkIndex = 0;       // chunks emitted this reply; 0 gets the fast split

  // Fires once the queue drains after Jun has been speaking, so callers can start
  // their idle clock from when she stops talking rather than when the text streamed.
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
    masterGain.gain.value = 1.0;
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.4;
    analyserBuf = new Float32Array(analyser.fftSize);
    // Graph: source -> analyser -> masterGain -> destination
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
  function setSpeed(s) { speed = Math.max(0.5, Math.min(2.0, s || 1.0)); }
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

  // Progressive chunking: tight for the reply's first chunk, sentences after.
  //
  // Nothing is audible until a chunk is both generated AND synthesized, and
  // Kokoro's synth time scales with output length - so a full opening sentence
  // ("Oh, I've been waiting all day for you to say that.") costs ~1.8s on CPU
  // before the first sample plays. Cutting chunk 0 at the first clause pays that
  // down proportionally.
  //
  // Only chunk 0. Kokoro synthesizes each chunk independently with no
  // cross-chunk context, so every fragment gets phrase-final intonation - falling
  // pitch, final lengthening. Cut at every comma and Jun reads the whole reply
  // like a shopping list. Chunk 0 is the only one with nothing covering it;
  // later chunks synthesize under the previous chunk's playback, so they can
  // afford to wait for a real sentence boundary and sound better for it.
  //
  // Trailing punctuation stays in the text: the comma cues Kokoro toward a
  // non-final contour, which is exactly what a mid-sentence cut wants.
  //
  // app.js strips [ACTION:...] blocks before feed(), so input here is plain text.
  const HARD_BREAK_RE = /[.!?\n]/;
  const SOFT_BREAK_RE = /[,;:—–]/g;
  const MIN_FIRST_WORDS = 3;   // "Oh," alone reads as a whole falling utterance
  const MAX_FIRST_WORDS = 8;   // escape hatch: opening clause with no punctuation

  function wordCount(s) {
    const m = s.match(/\S+/g);
    return m ? m.length : 0;
  }

  function cutAt(buf, i) {
    return { chunk: buf.slice(0, i + 1), rest: buf.slice(i + 1) };
  }

  // Returns { chunk, rest } or null if buf has no complete chunk yet.
  function nextChunk(buf, first) {
    const hard = buf.search(HARD_BREAK_RE);
    if (!first) return hard < 0 ? null : cutAt(buf, hard);

    // A hard break is always fair game, even at one word - "Oh!" is a complete
    // utterance and synthesizes with natural prosody.
    // For soft breaks, scan for the first one with enough words ahead of it, so
    // "Oh, my god, I missed you" cuts at "god," rather than at "Oh,".
    let soft = -1;
    SOFT_BREAK_RE.lastIndex = 0;
    let m;
    while ((m = SOFT_BREAK_RE.exec(buf))) {
      if (wordCount(buf.slice(0, m.index)) >= MIN_FIRST_WORDS) { soft = m.index; break; }
    }

    const cands = [hard, soft].filter(i => i >= 0);
    if (cands.length) return cutAt(buf, Math.min.apply(null, cands));

    // No usable break. Force a cut once enough *complete* words have arrived -
    // the trailing \s+ is what proves a word ended, so we never split
    // "unbeliev|able" mid-token and hand Kokoro a nonsense phoneme run.
    const re = /\S+\s+/g;
    let count = 0, end = 0;
    while ((m = re.exec(buf))) {
      end = m.index + m[0].length;
      if (++count >= MAX_FIRST_WORDS) return { chunk: buf.slice(0, end), rest: buf.slice(end) };
    }
    return null;
  }

  // Kokoro's G2P chokes on emojis (errors or produces phoneme garbage that
  // desyncs the queue), and any action-tag fragment ([A:...] or legacy
  // [ACTION:...]) that survived the stream-buffer would get read out loud.
  // Strip both, plus markdown noise.
  const ACTION_RE = /\[\s*A(?:CTIONS?)?\s*:[^\]]*\]?/gi;
  const MARKDOWN_NOISE_RE = /[*_~`#>]+/g;
  // \p{Extended_Pictographic} covers all emojis; ️ is the variation
  // selector that turns a few base glyphs into emoji form; ‍ is the
  // zero-width joiner used in compound emoji (👨‍👩‍👧). Stripping these
  // collapses an emoji sequence to nothing instead of leaving fragments.
  const EMOJI_RE = /[\p{Extended_Pictographic}️‍]/gu;

  function cleanForSpeech(s) {
    s = s.replace(ACTION_RE, '');
    s = s.replace(EMOJI_RE, '');
    s = s.replace(MARKDOWN_NOISE_RE, '');
    s = s.replace(/\s+/g, ' ').trim();
    // If only punctuation remains, don't bother synthesizing.
    if (!/[\p{L}\p{N}]/u.test(s)) return '';
    return s;
  }

  function feed(textChunk) {
    if (!enabled || !textChunk) return;
    sentenceBuf += textChunk;
    while (true) {
      const r = nextChunk(sentenceBuf, chunkIndex === 0);
      if (!r) break;
      sentenceBuf = r.rest;
      const clean = cleanForSpeech(r.chunk);
      // Only count a chunk that actually produced speech - a fragment that
      // cleans down to nothing (bare punctuation, a lone emoji) must not spend
      // the reply's one aggressive first cut.
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
    // End of reply. The next feed() starts a new one and gets a fresh fast first
    // chunk. (stop() resets too, for the interrupted case.)
    resetReply();
  }

  function resetReply() {
    chunkIndex = 0;
    firstChunkSynthed = false;
  }

  // Cap on concurrent synthesis requests. This is what makes the aggressive
  // first-chunk split above actually pay off, and the two must not be separated.
  //
  // /tts is a sync `def` on single-process uvicorn, so FastAPI runs requests in
  // its threadpool - concurrent ones genuinely execute at once and contend for
  // cores. Firing every chunk immediately (as this used to) means chunk 0 fights
  // chunks 1..N for CPU, and cutting chunks smaller makes that *worse*, not
  // better: more chunks, same cores, first word later.
  //
  // So: chunk 0 synthesizes alone and gets the whole box, then the window opens
  // for throughput so later chunks stay ahead of playback. Interacts with
  // OMP_NUM_THREADS in docker/tts.Dockerfile (each synth pins to 4 threads,
  // so 3 concurrent ≈ 12 cores) - drop this to 1 on a 4-core machine.
  const MAX_IN_FLIGHT = 3;
  let inFlight = 0;
  let firstChunkSynthed = false;   // has any chunk of this reply finished?

  function enqueue(text) {
    ensureCtx();
    // Chrome's autoplay policy leaves the context suspended until a gesture.
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});

    const id = nextId++;
    const job = {
      id, text,
      abort: new AbortController(),
      status: 'queued',
      audioBuffer: null,
    };
    jobs.push(job);
    speaking = true;
    kick();
  }

  // Start as many queued jobs as the cap allows, oldest first.
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
          body: JSON.stringify({ text: job.text, voice, speed, engine }),
          signal: job.abort.signal,
        });
        // 204 (nothing to say) is a 2xx, so it can't be caught under !res.ok.
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
        onLog('warn', `TTS error: ${e.message}`);
      } finally {
        inFlight = Math.max(0, inFlight - 1);
        // Open the window even if chunk 0 errored - otherwise one failure keeps
        // the whole reply serialized at cap 1. But NOT if it was cancelled: that
        // job belongs to a reply stop() already killed, and letting it through
        // would uncap the *next* reply's chunk 0 and undo the whole point.
        if (job.status !== 'cancelled') firstChunkSynthed = true;
        kick();
        pump();
      }
    })();
  }

  // Drive playback strictly in submission order. Skip jobs that errored;
  // wait (idle) for the head job to become 'ready' if it's still pending.
  function pump() {
    if (playingJobId) return;
    // Drop any leading already-resolved (done/cancelled/error) jobs.
    while (jobs.length && (jobs[0].status === 'done' || jobs[0].status === 'cancelled' || jobs[0].status === 'error')) {
      jobs.shift();
    }
    if (!jobs.length) { checkDrain(); return; }
    const head = jobs[0];
    if (head.status !== 'ready') return;  // still synthesizing
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
      // Remove from head if still there.
      const idx = jobs.indexOf(job);
      if (idx >= 0) jobs.splice(idx, 1);
      playingJobId = 0;
      if (!jobs.length || !jobs.some(j => j.status === 'playing' || j.status === 'ready' || j.status === 'pending')) {
        stopLipsyncLoop();
      }
      pump();
    };
    src.start();
  }

  // ── Output level history, for voice.js's barge-in threshold ────────────────
  // The mic hears whatever Jun is saying. Browser AEC removes most of it, but
  // the residual scales with how loud she currently is - so voice.js raises its
  // speech threshold in proportion to this rather than by a fixed amount.
  //
  // A ring, not a single value: the echo arriving at the mic lags what the
  // analyser sees by output buffer + acoustic path (~30-150ms, worse on
  // Bluetooth). Callers take the max over a window to cover that skew without
  // needing to know the exact delay. Entries age out on their own, so once
  // playback stops this returns 0 within the window - which also covers the AEC
  // tail after stop().
  const RMS_HISTORY_MS = 400;
  let rmsHistory = [];  // [{ t, rms }], oldest first

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
    // Sample here rather than relying on the lipsync loop having done it. That
    // loop is rAF-driven and stops dead in a hidden tab - but playback doesn't,
    // and neither does voice.js's worklet. Without this, a backgrounded tab
    // would report 0 while Jun is audibly talking, drop the echo-proportional
    // threshold to bare, and have her interrupt herself. voice.js polls this
    // ~32ms so the history stays dense enough for the max-over-window below.
    pushRms(computeRms());
    const cutoff = performance.now() - (windowMs || 200);
    let max = 0;
    for (let i = rmsHistory.length - 1; i >= 0; i--) {
      if (rmsHistory[i].t < cutoff) break;
      if (rmsHistory[i].rms > max) max = rmsHistory[i].rms;
    }
    return max;
  }

  // Duck rather than cut, for tentative barge-in: dropping ~9dB gives the VAD a
  // clean look at the mic to decide if you really are talking, and if you aren't,
  // Jun dips for 150ms instead of being cut off mid-word. voice.js calls stop()
  // only once the speech is confirmed.
  function duck(gain) {
    if (!masterGain) return;
    const g = Math.max(0, Math.min(1, gain));
    const t = audioCtx.currentTime;
    masterGain.gain.cancelScheduledValues(t);
    masterGain.gain.setTargetAtTime(g, t, 0.02);  // ~20ms, no click
  }

  // Lipsync: RMS of the analyser drives ParamMouthOpen.
  function startLipsyncLoop() {
    if (rafId) return;
    const tick = () => {
      rafId = 0;
      if (!analyser) return;
      const rms = computeRms();
      pushRms(rms);
      // Map RMS (~0..0.4 typical for speech) to mouth open (0..1) with a
      // mild expansion curve so soft consonants still register.
      const norm = Math.min(1, rms * 3.5);
      const shaped = Math.pow(norm, 0.7);
      if (window.Live2D && Live2D.setMouthOverride) Live2D.setMouthOverride(shaped);
      // Keep ticking while audio is playing OR another job is queued.
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
    // Clear any duck a barge-in left behind, so the next reply isn't quiet.
    duck(1);
    for (const j of jobs) {
      if (j.status === 'queued' || j.status === 'pending' || j.status === 'ready') {
        // 'queued' has no fetch to abort yet; marking it cancelled is enough to
        // keep kick() from ever starting it.
        try { j.abort.abort(); } catch (e) {}
        j.status = 'cancelled';
      }
    }
    jobs = [];
    // Don't zero inFlight here: the aborts above settle through startJob's
    // finally, which decrements. Zeroing would let it go negative.
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
    setEngine, setVoice, setSpeed,
    setLogger,
    listVoices,
    feed, flush, stop,
    isSpeaking, setOnAllDone,
    outputRms, duck,
  };
})();
