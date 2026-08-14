// Capture stays seperate from TTS playback, or your own mic ends up
// Driving her mouth.

window.Voice = (function () {
  const STT_URL = '/api/stt.php';
  const SAMPLE_RATE = 16000;   // what whisper wants; browser resamples for us

  const PRE_ROLL_MS = 300;
  const MAX_UTTERANCE_MS = 30000;
  const EMA_ALPHA = 0.2;

  const CALIBRATE_MS = 1500;   // must not overlap TTS, AEC needs ~200-500ms to settle
  const FLOOR_MIN = 0.003;     // a dead or muted mic gives floor 0, threshold 0, all reads as "speech"
  const FLOOR_MAX = 0.05;      // caps the floor so a loud room can't lift the open threshold above speech
  const OPEN_MULT = 3.5;       // ~ +11dB over the noise floor
  const OPEN_MIN = 0.015;
  const CLOSE_RATIO = 0.55;    // close lower than we open, or it Flaps mid-word

  const START_FRAMES = 3;      // ~96ms at the worklet's 32ms cadence
  const START_FRAMES_TTS = 6;  // ~200ms while Jun talks - see NOTES ON ECHO
  const ECHO_COEFF = 1.8;      // threshold bump per unit of Jun's output level
  const SILENCE_MS = 700;      // end-of-turn hangover
  const MIN_SPEECH_MS = 250;   // shorter than this is a cough/click, not a turn
  const CONFIRM_MS = 250;      // duck at speech-start, cut for real after this

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
  let onAudio = null;
  let onState = () => {};
  let onBargeIn = () => {};
  let onLog = () => {};
  let ttsWasSpeaking = false;

  function setOnTranscript(fn) { onTranscript = fn || (() => {}); }
  // Set this and the wav goes straight to the chat model. return false from it
  // and the turn falls back to whisper, one turn at a time.
  function setOnAudio(fn) { onAudio = fn || null; }
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

  // getUserMedia only works in a secure context. localhost is ok so your
  // dev box is fine, but we ship TLS_MODE=off on :80, and over a LAN IP
  // `navigator.mediaDevices` is just *undefined*, it doesn't even throw.
  // so it gets its own case. telling someone to "click allow" when no
  // prompt ever shows up helps Nobody.
  function support() {
    if (!window.isSecureContext) return { ok: false, reason: 'insecure_context' };
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return { ok: false, reason: 'no_getusermedia' };
    }
    if (!window.AudioWorkletNode) return { ok: false, reason: 'no_audioworklet' };
    return { ok: true };
  }

  async function ensureMic() {
    if (node) return;

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
        // Deliberately off. AGC is the mic's automatic volume, it turns
        // the gain up when the room is silent, so the same noise gets a
        // different level minute to minute. the floor we measure at
        // startup doesn't match what the mic sends NOW, so all the
        // thresholds we build from it are Wrong. Whisper is fine with
        // level changes, the VAD is not.
        autoGainControl: { ideal: false },
        channelCount: 1,
      },
    });

    // `ideal` constraints fail without saying anything, so check what we
    // got, don't trust what we asked for. with no AEC and speakers on
    // she Interrupts herself.
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
    // No connect() to destination, that would play your own mic back
    // at you. a worklet with numberOfOutputs:0 still runs from the
    // source connection.
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

  function startCalibration() {
    // Never calibrate over Jun's voice. we would take her voice as the
    // room noise, put the threshold above her, and stay Deaf for the
    // rest of the session.
    if (window.TTS && TTS.isSpeaking()) { setTimeout(startCalibration, 200); return; }
    calibSamples = [];
    calibUntil = performance.now() + CALIBRATE_MS;
    setState('calibrating');
  }

  function finishCalibration() {
    if (calibSamples.length) {
      // p95, the level 95% of samples stay under, not the mean. a fan
      // tick or a car outside barely move a mean, so the threshold we
      // get from it is too low and those same blips cross it.
      const sorted = calibSamples.slice().sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
      noiseFloor = Math.max(FLOOR_MIN, Math.min(FLOOR_MAX, p95));
    }
    openThresh = Math.max(noiseFloor * OPEN_MULT, OPEN_MIN);
    closeThresh = openThresh * CLOSE_RATIO;
    onLog('info', `Voice ready (floor ${noiseFloor.toFixed(4)}, open ${openThresh.toFixed(4)})`);
    setState('listening');
  }

  function onRms(rms) {
    if (!enabled) return;
    const now = performance.now();

    if (state === 'calibrating') {
      calibSamples.push(rms);
      if (now >= calibUntil) finishCalibration();
      return;
    }

    const speakingNow = !!(window.TTS && TTS.isSpeaking());

    // She just stopped talking, but her echo is still in the room and
    // the thresholds are still up for it. drop any half started
    // detection, or her own tail counts as the Start of your turn.
    if (ttsWasSpeaking && !speakingNow) { aboveCount = 0; if (state === 'maybe') setState('listening'); }
    ttsWasSpeaking = speakingNow;

    // Half-duplex: the mic is off while she talks, full stop.
    // drop what is in progress, don't just refuse to start. a turn that
    // was already mid speech when she began would skip the silence
    // check below and hang until she stops, or until the worklet's 30s
    // cap fires.
    if (speakingNow && !bargeIn) {
      if (state === 'speech') node.port.postMessage({ type: 'stop', discard: true });
      if (state !== 'listening') { aboveCount = 0; setState('listening'); }
      return;
    }

    // While she's talking everything Tightens. the threshold goes up
    // with her current level, the louder she is the more echo comes
    // back, and the debounce doubles. a false barge-in cuts her off mid
    // sentence, much worse than an interrupt that is 200ms late.
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
            // Tentative, so duck instead of cutting. if it turns
            // out to be nothing we are back up in ~150ms and she
            // only got quiet.
            if (speakingNow) TTS.duck(0.35);
          }
        } else {
          aboveCount = 0;
          setState('listening');
        }
        break;

      case 'speech':
        if (rms > closeThresh) lastLoudAt = now;
        if (!confirmed && now - speechStartedAt >= CONFIRM_MS) {
          confirmed = true;
          if (window.TTS && TTS.isSpeaking()) TTS.stop();
          // Fires even when she isn't speaking. the reply can still
          // be streaming while she thinks or runs a tool, and talking
          // over that still means "stop, listen to me".
          // app.js kills the stream from here.
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
      node.port.postMessage({ type: 'stop', discard: true });
      if (!confirmed && window.TTS) TTS.duck(1);
      setState('listening');
      return;
    }
    node.port.postMessage({ type: 'stop', discard: false });  // goes to onPcm
  }

  async function onPcm(pcm) {
    if (!pcm || !pcm.length) { resume(); return; }
    const wav = encodeWav(pcm, SAMPLE_RATE);
    try {
      if (onAudio && onAudio(base64Of(wav)) !== false) return;
      const res = await fetch(`${STT_URL}?action=stt`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: wav,
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`STT http ${res.status}`);
      const data = await res.json();
      const text = (data.text || '').trim();
      // Drop empties quietly. whisper gives back "" for a breath, a
      // key press, a door closing. if we send those she Answers nothing,
      // over and over.
      if (text) onTranscript(text);
    } catch (e) {
      onLog('warn', `Voice: ${e.message}`);
    } finally {
      // Always, on every path. on the whisper path we go deaf for the
      // ~500ms of the STT fetch on purpose, you just stopped talking
      // and it keeps one turn from racing the next. but if we stay
      // that way we never hear you again. the audio path returns
      // before the fetch, so there the mic comes back right away and
      // half-duplex is the ONLY thing keeping her out of it.
      resume();
    }
  }

  // Back to listening, and this happens while she is still writing and
  // talking. that is on purpose, not an accident. barge-in only works
  // because the mic stays on through her Whole reply.
  function resume() {
    if (!enabled) return;
    aboveCount = 0;
    setState('listening');
  }

  // 16kHz mono PCM16 WAV. ~20 lines is less work than a library, and
  // less work than MediaRecorder, webm/opus can't carry the pre-roll
  // unless we glue an EBML header onto clusters that aren't next to
  // each other. 32KB/s over loopback costs nothing.
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

  // In 32KB chunks. one spread of a 1MB byte array blows the argument limit
  // and String.fromCharCode throws.
  function base64Of(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  return {
    support, enable, disable, isEnabled, getState, resume,
    setBargeIn, setSilenceMs,
    setOnTranscript, setOnAudio, setOnState, setOnBargeIn, setLogger,
  };
})();
