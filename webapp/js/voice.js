// Hands-free voice input: mic → VAD → whisper → app.js sendMessage().
//
// The counterpart to tts.js. That module owns the *playback* AudioContext (its
// analyser drives Jun's mouth); this one owns a separate 16kHz capture context.
// They must stay separate - feeding the mic into tts.js's analyser would make
// Jun lipsync your voice.
//
// Flow per turn:
//   mic-worklet.js reports RMS every ~32ms and buffers PCM (with 300ms pre-roll)
//   the state machine below decides speech-start / end-of-turn from that RMS
//   on end-of-turn: worklet hands back the utterance → WAV → /api/stt.php
//   transcript → onTranscript() → app.js drops it in the input and sends
//
// Barge-in: while Jun is speaking we raise the threshold in proportion to her
// own output level (TTS.outputRms), because the mic hears her too and browser
// AEC only removes most of it. See NOTES ON ECHO at the bottom.

window.Voice = (function () {
  const STT_URL = '/api/stt.php';
  const SAMPLE_RATE = 16000;   // what whisper wants; browser resamples for us

  // ── Tuning ─────────────────────────────────────────────────────────────────
  const PRE_ROLL_MS = 300;
  const MAX_UTTERANCE_MS = 30000;
  const EMA_ALPHA = 0.2;

  const CALIBRATE_MS = 1500;   // must not overlap TTS; AEC needs ~200-500ms to converge
  const FLOOR_MIN = 0.003;     // guards a dead/muted mic (floor→0 → threshold→0 → always "speech")
  const FLOOR_MAX = 0.05;      // guards a loud room from making Jun undetectable-quiet
  const OPEN_MULT = 3.5;       // ≈ +11dB over the noise floor
  const OPEN_MIN = 0.015;
  const CLOSE_RATIO = 0.55;    // hysteresis: prevents chatter mid-word

  const START_FRAMES = 3;      // ~96ms at the worklet's 32ms cadence
  const START_FRAMES_TTS = 6;  // ~200ms while Jun talks - see NOTES ON ECHO
  const ECHO_COEFF = 1.8;      // threshold bump per unit of Jun's output level
  const SILENCE_MS = 700;      // end-of-turn hangover
  const MIN_SPEECH_MS = 250;   // shorter than this is a cough/click, not a turn
  const CONFIRM_MS = 250;      // duck at speech-start, cut for real after this

  // ── State ──────────────────────────────────────────────────────────────────
  let enabled = false;
  let bargeIn = true;
  let silenceMs = SILENCE_MS;

  let stream = null;
  let micCtx = null;
  let node = null;
  let srcNode = null;

  let state = 'idle';          // idle | calibrating | listening | maybe | speech | tail
  let noiseFloor = 0.01;
  let openThresh = OPEN_MIN;
  let closeThresh = OPEN_MIN * CLOSE_RATIO;

  let calibSamples = [];
  let calibUntil = 0;
  let aboveCount = 0;
  let speechStartedAt = 0;
  let confirmed = false;
  let lastLoudAt = 0;

  let onTranscript = () => {};
  let onState = () => {};
  let onBargeIn = () => {};
  let onLog = () => {};
  let ttsWasSpeaking = false;

  function setOnTranscript(fn) { onTranscript = fn || (() => {}); }
  function setOnState(fn) { onState = fn || (() => {}); }
  function setOnBargeIn(fn) { onBargeIn = fn || (() => {}); }
  function setLogger(fn) { onLog = fn || (() => {}); }
  function isEnabled() { return enabled; }
  function getState() { return state; }
  function setBargeIn(v) { bargeIn = !!v; }
  function setSilenceMs(v) { silenceMs = Math.max(300, Math.min(2000, v | 0)); }

  function setState(s) {
    if (state === s) return;
    state = s;
    onState(s);
  }

  // ── Capability probe ───────────────────────────────────────────────────────
  // getUserMedia only exists in a secure context. http://localhost qualifies, so
  // a dev box is fine - but the stack defaults to TLS_MODE=off on :80, so over a
  // LAN IP `navigator.mediaDevices` is simply *undefined* rather than throwing.
  // Report that as its own case; "click allow" is useless advice there.
  function support() {
    if (!window.isSecureContext) return { ok: false, reason: 'insecure_context' };
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return { ok: false, reason: 'no_getusermedia' };
    }
    if (!window.AudioWorkletNode) return { ok: false, reason: 'no_audioworklet' };
    return { ok: true };
  }

  // ── Mic setup ──────────────────────────────────────────────────────────────
  async function ensureMic() {
    if (node) return;

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
        // Deliberately OFF. AGC continuously rescales input, so the noise floor
        // we calibrate decays out from under us as AGC ramps gain during silence
        // - absolute thresholds stop meaning anything. Whisper handles level
        // variation fine; a drifting VAD is much worse.
        autoGainControl: { ideal: false },
        channelCount: 1,
      },
    });

    // `ideal` constraints fail silently, so check what we actually got rather
    // than what we asked for. Without AEC, barge-in on speakers will self-trigger.
    const settings = (stream.getAudioTracks()[0] || {}).getSettings
      ? stream.getAudioTracks()[0].getSettings() : {};
    if (settings.echoCancellation !== true) {
      onLog('warn', 'Mic echo cancellation unavailable - use headphones, or Jun may interrupt herself.');
    }

    micCtx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    await micCtx.audioWorklet.addModule('/js/mic-worklet.js');

    srcNode = micCtx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(micCtx, 'mic-processor', {
      numberOfOutputs: 0,
      processorOptions: { preRollMs: PRE_ROLL_MS, maxMs: MAX_UTTERANCE_MS, alpha: EMA_ALPHA },
    });
    node.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'rms') onRms(m.rms);
      else if (m.type === 'pcm') onPcm(m.pcm);
      else if (m.type === 'overflow') onLog('warn', 'Voice: 30s cap hit, sending what I have.');
    };
    // No connect() to destination - that would play your own mic back at you.
    // A worklet with numberOfOutputs:0 still runs from the source connection.
    srcNode.connect(node);
  }

  async function enable() {
    if (enabled) return;
    const s = support();
    if (!s.ok) { onLog('warn', `Voice unavailable: ${s.reason}`); throw new Error(s.reason); }
    await ensureMic();
    if (micCtx.state === 'suspended') await micCtx.resume();
    enabled = true;
    startCalibration();
  }

  function disable() {
    enabled = false;
    setState('idle');
    if (node) { try { node.port.postMessage({ type: 'stop', discard: true }); } catch (e) {} }
    if (srcNode) { try { srcNode.disconnect(); } catch (e) {} srcNode = null; }
    if (node) { try { node.disconnect(); } catch (e) {} node = null; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (micCtx) { micCtx.close().catch(() => {}); micCtx = null; }
  }

  // ── Calibration ────────────────────────────────────────────────────────────
  function startCalibration() {
    // Never calibrate over Jun's voice: we'd measure her as the room's noise
    // floor and end up deaf for the rest of the session.
    if (window.TTS && TTS.isSpeaking()) { setTimeout(startCalibration, 200); return; }
    calibSamples = [];
    calibUntil = performance.now() + CALIBRATE_MS;
    setState('calibrating');
  }

  function finishCalibration() {
    if (calibSamples.length) {
      // p95, not mean: sparse noise (a fan tick, distant traffic) barely moves a
      // mean, then trips the threshold in use. p95 sits just under the real peaks.
      const sorted = calibSamples.slice().sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
      noiseFloor = Math.max(FLOOR_MIN, Math.min(FLOOR_MAX, p95));
    }
    openThresh = Math.max(noiseFloor * OPEN_MULT, OPEN_MIN);
    closeThresh = openThresh * CLOSE_RATIO;
    onLog('info', `Voice ready (floor ${noiseFloor.toFixed(4)}, open ${openThresh.toFixed(4)})`);
    setState('listening');
  }

  // ── VAD state machine ──────────────────────────────────────────────────────
  function onRms(rms) {
    if (!enabled) return;
    const now = performance.now();

    if (state === 'calibrating') {
      calibSamples.push(rms);
      if (now >= calibUntil) finishCalibration();
      return;
    }

    const speakingNow = !!(window.TTS && TTS.isSpeaking());

    // Jun just stopped: her echo tail is still in the room and our thresholds
    // were elevated for it. Drop any half-formed detection rather than let the
    // tail read as the start of your turn.
    if (ttsWasSpeaking && !speakingNow) { aboveCount = 0; if (state === 'maybe') setState('listening'); }
    ttsWasSpeaking = speakingNow;

    // Half-duplex: the mic is off while she talks, full stop. Abandon anything
    // in progress rather than just refusing to start - a turn caught mid-speech
    // when she began would otherwise skip the silence check below and hang until
    // she finished (or the worklet's 30s cap fired).
    if (speakingNow && !bargeIn) {
      if (state === 'speech') node.port.postMessage({ type: 'stop', discard: true });
      if (state !== 'listening') { aboveCount = 0; setState('listening'); }
      return;
    }

    // While she's talking, everything gets stricter: the threshold rises with
    // her current level (residual echo scales with output), and the debounce
    // doubles. A false barge-in guillotines her mid-sentence, which is far more
    // jarring than a 200ms-late interrupt.
    let open = openThresh;
    let needFrames = START_FRAMES;
    if (speakingNow) {
      open += ECHO_COEFF * TTS.outputRms(200);
      needFrames = START_FRAMES_TTS;
    }

    switch (state) {
      case 'listening':
        if (rms > open) { aboveCount = 1; setState('maybe'); }
        break;

      case 'maybe':
        if (rms > open) {
          if (++aboveCount >= needFrames) {
            speechStartedAt = now;
            lastLoudAt = now;
            confirmed = false;
            node.port.postMessage({ type: 'start' });
            setState('speech');
            // Tentative: duck rather than cut. If this turns out to be a false
            // positive we restore in ~150ms and she's only dipped, not stopped.
            if (speakingNow) TTS.duck(0.35);
          }
        } else {
          aboveCount = 0;
          setState('listening');
        }
        break;

      case 'speech':
        if (rms > closeThresh) lastLoudAt = now;
        // Real speech, not a click - now actually cut her off.
        if (!confirmed && now - speechStartedAt >= CONFIRM_MS) {
          confirmed = true;
          if (window.TTS && TTS.isSpeaking()) TTS.stop();
          // Fires even when she isn't speaking: the reply may be streaming
          // silently (thinking, or a tool call), and you talking over that still
          // means "stop, listen to me". app.js aborts the stream from here.
          onBargeIn();
        }
        if (now - lastLoudAt >= silenceMs) finalize(now);
        break;
    }
  }

  function finalize(now) {
    const spoken = (now - speechStartedAt) - silenceMs;
    setState('thinking');
    if (spoken < MIN_SPEECH_MS) {
      // Too short to be a turn. Discard, and undo a duck if we caused one.
      node.port.postMessage({ type: 'stop', discard: true });
      if (!confirmed && window.TTS) TTS.duck(1);
      setState('listening');
      return;
    }
    node.port.postMessage({ type: 'stop', discard: false });  // → onPcm
  }

  // ── Upload ─────────────────────────────────────────────────────────────────
  async function onPcm(pcm) {
    if (!pcm || !pcm.length) { resume(); return; }
    try {
      const res = await fetch(`${STT_URL}?action=stt`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: encodeWav(pcm, SAMPLE_RATE),
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`STT http ${res.status}`);
      const data = await res.json();
      const text = (data.text || '').trim();
      // Silently drop empties. Whisper returns "" for breath, keyboard noise, a
      // door - and sending those would have Jun answer nothing, repeatedly.
      if (text) onTranscript(text);
    } catch (e) {
      onLog('warn', `Voice: ${e.message}`);
    } finally {
      // Always, on every path. We deliberately go deaf for the ~500ms of the STT
      // fetch (you've only just stopped talking, and it stops one turn racing the
      // next), but staying that way would mean never hearing you again.
      resume();
    }
  }

  // Back to listening. Note this happens while Jun is still generating and
  // speaking - that's required, not incidental: barge-in only exists because the
  // mic stays live through her whole reply.
  function resume() {
    if (!enabled) return;
    aboveCount = 0;
    setState('listening');
  }

  // 16kHz mono PCM16 WAV. ~20 lines beats pulling in a library, and beats
  // MediaRecorder: webm/opus can't carry the pre-roll without splicing an EBML
  // header onto non-contiguous clusters. 32KB/s over loopback is free.
  function encodeWav(samples, rate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    str(0, 'RIFF');
    v.setUint32(4, 36 + samples.length * 2, true);
    str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true);          // fmt chunk size
    v.setUint16(20, 1, true);           // PCM
    v.setUint16(22, 1, true);           // mono
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true);    // byte rate
    v.setUint16(32, 2, true);           // block align
    v.setUint16(34, 16, true);          // bits per sample
    str(36, 'data');
    v.setUint32(40, samples.length * 2, true);
    let off = 44;
    for (let i = 0; i < samples.length; i++, off += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
  }

  return {
    support, enable, disable, isEnabled, getState, resume,
    setBargeIn, setSilenceMs,
    setOnTranscript, setOnState, setOnBargeIn, setLogger,
  };
})();

// ── NOTES ON ECHO ────────────────────────────────────────────────────────────
// getUserMedia({echoCancellation:true}) engages the browser's AEC, whose
// reference signal is the mix rendered to the *output device* - which includes
// tts.js's WebAudio output. So Jun's voice does get cancelled from the mic. That
// is how every browser voice assistant works, and it's why barge-in is possible
// at all here.
//
// AEC still fails on, in rough order of likelihood:
//   - Output routed somewhere other than the OS default sink. AEC references the
//     default render device; on PipeWire/PulseAudio this misroute is common.
//   - Loud speakers. AEC models a *linear* echo path; drive cheap laptop speakers
//     past ~75% and the clipping distortion survives cancellation.
//   - Bluetooth. 100-200ms path delay exceeds the filter length in some configs.
//   - Clock drift between mic and speaker on different devices.
//
// Hence the belt-and-braces above: the echo-proportional threshold and the
// duck-then-confirm sequence both work even with AEC off entirely. If it's still
// self-triggering, the ladder is: raise ECHO_COEFF toward 3.0 → setBargeIn(false)
// (half-duplex, mic ignored while she talks) → wear headphones, which is the only
// answer that is actually 100% reliable.
