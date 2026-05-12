// Kokoro TTS client: sentence queue → fetch /tts → ordered AudioContext playback
// + AnalyserNode-driven ParamMouthOpen lipsync.
//
// Pipeline (per chat reply):
//   feed(textChunk) accumulates and emits sentences at . ! ? \n boundaries
//   each sentence becomes a Job with an id (monotonic) — kicked off in parallel
//   jobs play in submission order regardless of which finishes first
//   stop() aborts in-flight fetches, halts current source, releases the mouth

window.TTS = (function () {
  const TTS_URL = '/api/tts.php';

  let enabled = false;
  let voice = 'af_heart';
  let speed = 1.0;
  let onLog = () => {};

  let audioCtx = null;
  let analyser = null;
  let analyserBuf = null;
  let masterGain = null;

  // Job queue. Each job: { id, text, abort, blobPromise, status }
  // status: 'pending' | 'ready' | 'playing' | 'done' | 'cancelled' | 'error'
  let jobs = [];
  let nextId = 1;
  let playingJobId = 0;        // id currently playing, 0 if none
  let currentSource = null;    // AudioBufferSourceNode in flight
  let rafId = 0;
  let sentenceBuf = '';        // text not yet split into a sentence

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

  function setVoice(v) { if (v) voice = v; }
  function setSpeed(s) { speed = Math.max(0.5, Math.min(2.0, s || 1.0)); }
  function setLogger(fn) { onLog = fn || (() => {}); }

  async function listVoices() {
    try {
      const r = await fetch(`${TTS_URL}?action=voices`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`http ${r.status}`);
      return await r.json();
    } catch (e) {
      onLog('warn', `TTS /voices fallita: ${e.message} (sidecar acceso?)`);
      return { voices: [], default: voice };
    }
  }

  // ---- Sentence splitting -------------------------------------------------
  // Cuts at . ! ? \n. We don't try to be clever about abbreviations — Kokoro
  // tolerates fragments and the user can pick a different splitting strategy
  // later if it matters. We avoid cutting inside an [ACTION:...] block, but
  // app.js already strips action blocks before calling feed(), so the input
  // here is plain visible text.
  const BREAK_RE = /([.!?\n])/;
  function pullSentences(s) {
    const out = [];
    let rest = s;
    while (true) {
      const m = rest.match(BREAK_RE);
      if (!m) break;
      const end = m.index + 1;
      const sentence = rest.slice(0, end).trim();
      if (sentence) out.push(sentence);
      rest = rest.slice(end);
    }
    return { sentences: out, remainder: rest };
  }

  // ---- Sanitize text before synthesis -------------------------------------
  // Kokoro's G2P chokes on emojis (errors or produces phoneme garbage that
  // desyncs the queue), and any [ACTION:...] fragment that survived the
  // stream-buffer would get read out loud. Strip both, plus markdown noise.
  const ACTION_RE = /\[ACTION:[^\]]*\]?/gi;
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
    const { sentences, remainder } = pullSentences(sentenceBuf);
    sentenceBuf = remainder;
    for (const s of sentences) {
      const clean = cleanForSpeech(s);
      if (clean) enqueue(clean);
    }
  }

  function flush() {
    if (!enabled) { sentenceBuf = ''; return; }
    const tail = sentenceBuf.trim();
    sentenceBuf = '';
    if (!tail) return;
    const clean = cleanForSpeech(tail);
    if (clean) enqueue(clean);
  }

  // ---- Job pipeline --------------------------------------------------------

  function enqueue(text) {
    ensureCtx();
    // Resume the AudioContext on first use (Chrome's autoplay policy).
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});

    const id = nextId++;
    const ctrl = new AbortController();
    const job = {
      id, text,
      abort: ctrl,
      status: 'pending',
      audioBuffer: null,
    };
    jobs.push(job);

    job.blobPromise = (async () => {
      try {
        const res = await fetch(`${TTS_URL}?action=tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice, speed }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          if (res.status === 204) { job.status = 'done'; return; }
          throw new Error(`TTS http ${res.status}`);
        }
        const arr = await res.arrayBuffer();
        if (job.status === 'cancelled') return;
        const buf = await audioCtx.decodeAudioData(arr);
        job.audioBuffer = buf;
        job.status = 'ready';
        pump();
      } catch (e) {
        if (e.name === 'AbortError') { job.status = 'cancelled'; return; }
        job.status = 'error';
        onLog('warn', `TTS errore: ${e.message}`);
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
    if (!jobs.length) return;
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

  // ---- Lipsync: RMS of analyser → ParamMouthOpen ---------------------------

  function startLipsyncLoop() {
    if (rafId) return;
    const tick = () => {
      rafId = 0;
      if (!analyser) return;
      analyser.getFloatTimeDomainData(analyserBuf);
      let sum = 0;
      for (let i = 0; i < analyserBuf.length; i++) {
        const v = analyserBuf[i];
        sum += v * v;
      }
      const rms = Math.sqrt(sum / analyserBuf.length);
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

  // ---- Stop / cleanup ------------------------------------------------------

  function stop() {
    sentenceBuf = '';
    for (const j of jobs) {
      if (j.status === 'pending' || j.status === 'ready') {
        try { j.abort.abort(); } catch (e) {}
        j.status = 'cancelled';
      }
    }
    jobs = [];
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
    setVoice, setSpeed,
    setLogger,
    listVoices,
    feed, flush, stop,
  };
})();
