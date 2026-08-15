// capture stays seperate from TTS playback. otherwise the mic
// picks her up and she drives her own mouth. cursed.

window.Voice = (function () {
  const STT_URL = '/api/stt.php';
  // whisper wants 16 kHz. browser resamples for us, free real estate
  const SAMPLE_RATE = 16000;

  const PRE_ROLL_MS = 300;
  const MAX_UTTERANCE_MS = 30000;
  const EMA_ALPHA = 0.2;

  // calibration can NEVER overlap TTS. AEC, the browser's echo
  // canceller, needs ~200-500ms to settle after TTS stops.
  const CALIBRATE_MS = 1500;
  // dead or muted mic gives floor 0, so threshold 0, so
  // literally everything reads as speech. fun.
  const FLOOR_MIN = 0.003;
  // cap the floor or a loud room shoves the open threshold up
  // past actual speech and she never hears you
  const FLOOR_MAX = 0.05;
  // 3.5 is ~ +11dB over the noise floor
  const OPEN_MULT = 3.5;
  const OPEN_MIN = 0.015;
  // close lower than we open, or the VAD (the speech detector)
  // Flaps mid-word like a broken relay
  const CLOSE_RATIO = 0.55;

  // 3 worklet frames = ~96ms at the worklet's 32ms cadence.
  // while Jun talks we wait 6, ~200ms, because a false
  // barge-in off her own echo guillotines her mid sentence.
  const START_FRAMES = 3;
  const START_FRAMES_TTS = 6;
  // bump the threshold per unit of Jun's output. louder she is,
  // more echo comes back
  const ECHO_COEFF = 1.8;
  // 700ms of quiet ends the default turn
  const SILENCE_MS = 700;
  // under 250ms is a cough or a click, not a turn
  const MIN_SPEECH_MS = 250;
  // duck at speech start, only actually cut her off after this
  const CONFIRM_MS = 250;

  let enabled = false;
  let bargeIn = true;
  let silenceMs = SILENCE_MS;

  let stream = null;
  let micCtx = null;
  let node = null;
  let srcNode = null;

  let state = 'idle';
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
  // set this and the wav goes straight to the chat model. return false from
  // it and that turn falls back to whisper. one turn at a time, not a latch
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

  // getUserMedia ONLY works in a secure context. localhost counts so your
  // dev box is fine, but we ship TLS_MODE=off on :80, and over a LAN IP
  // `navigator.mediaDevices` is just straight up undefined. doesn't throw.
  // doesn't warn. nothing. so it gets its own case, because telling
  // somebody to "click allow" when no prompt ever appears helps NOBODY.
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
        // off ON PURPOSE. AGC is the mic's automatic volume, room goes
        // quiet and it cranks the gain by itself. so the same noise gets
        // a different level minute to minute, the floor we measured at
        // startup doesn't match what the mic sends NOW, and every
        // threshold we built off it is fiction. whisper doesn't care.
        // the VAD absolutely does.
        autoGainControl: { ideal: false },
        channelCount: 1,
      },
    });

    // `ideal` constraints just fail and say nothing, so check what we
    // actually got, never trust what we asked for. no AEC + speakers on
    // and she Interrupts herself all day.
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
    // no connect() to destination, that would play your own mic back at
    // you (nightmare). a worklet with numberOfOutputs:0 still runs off
    // the source connection anyway
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
    // NEVER calibrate over Jun's voice. we'd take her voice as the room
    // noise, park the threshold above her, and stay deaf for the rest of
    // the session. ask me how i know
    if (window.TTS && TTS.isSpeaking()) { setTimeout(startCalibration, 200); return; }
    calibSamples = [];
    calibUntil = performance.now() + CALIBRATE_MS;
    setState('calibrating');
  }

  function finishCalibration() {
    if (calibSamples.length) {
      // p95, the level 95% of samples stay under. NOT the mean. a fan
      // tick or a car outside barely move a mean, so the threshold you
      // get off it is too low and those exact blips cross it. lol
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

    // she just stopped talking but her echo is still bouncing around the
    // room and the thresholds are still raised for it. drop any half
    // started detection or her own tail counts as the Start of your turn
    if (ttsWasSpeaking && !speakingNow) { aboveCount = 0; if (state === 'maybe') setState('listening'); }
    ttsWasSpeaking = speakingNow;

    // half-duplex. mic is off while she talks, full stop.
    // and DROP what's in progress, don't just refuse to start. a turn
    // that was already mid speech when she began skips the silence check
    // below and hangs until she stops, or until the worklet's 30s cap
    // fires. neither is a good time.
    if (speakingNow && !bargeIn) {
      if (state === 'speech') node.port.postMessage({ type: 'stop', discard: true });
      if (state !== 'listening') { aboveCount = 0; setState('listening'); }
      return;
    }

    // while she's talking everything Tightens. threshold goes up with
    // her current level (louder she is, more echo comes back) and the
    // debounce doubles. a false barge-in cuts her off mid sentence,
    // which is way worse than an interrupt landing 200ms late.
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
            // tentative, so duck instead of cutting. if it turns
            // out to be nothing we're back up in ~150ms and all
            // she did was get quiet for a sec
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
          // fires even when she isn't speaking. the reply can still
          // be streaming while she thinks or runs a tool, and talking
          // over that still means "shut up and listen to me".
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
    node.port.postMessage({ type: 'stop', discard: false });
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
      // drop empties quietly. whisper hands back "" for a breath, a key
      // press, a door closing. send those and she Answers nothing, over
      // and over, forever
      if (text) onTranscript(text);
    } catch (e) {
      onLog('warn', `Voice: ${e.message}`);
    } finally {
      // ALWAYS. every path. on the whisper path we go deaf for the
      // ~500ms of the STT fetch on purpose, you just stopped talking
      // and it keeps one turn from racing the next. but stay that way
      // and we never hear you again. the audio path returns before the
      // fetch, so there the mic comes back instantly and half-duplex is
      // the ONLY thing keeping her out of it.
      resume();
    }
  }

  // back to listening, and yes this happens while she's still writing
  // and talking. on purpose, not an accident. barge-in only works
  // because the mic stays on through her Whole reply.
  function resume() {
    if (!enabled) return;
    aboveCount = 0;
    setState('listening');
  }

  // 16kHz mono PCM16 WAV. ~20 lines, less work than a library and less
  // work than MediaRecorder, because webm/opus can't carry the pre-roll
  // unless we glue an EBML header onto clusters that aren't even next
  // to each other. no thanks. 32KB/s over loopback costs nothing.
  function encodeWav(samples, rate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    str(0, 'RIFF');
    v.setUint32(4, 36 + samples.length * 2, true);
    str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, 'data');
    v.setUint32(40, samples.length * 2, true);
    let off = 44;
    for (let i = 0; i < samples.length; i++, off += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
  }

  // in 32KB chunks. spread a 1MB byte array in one go and you blow the
  // argument limit, String.fromCharCode just throws
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
