import { base64Of, encodeWav } from '../core/wav.js?v=1';

const WINDOW_S = 20;
const FRAME_PX = 512;
const QUIET_RMS = 0.005;
const WAV_RATE = 16000;
const MAX_AUDIO_S = 25;
// base64 chars. plus 25 s of wav and the history it has to fit
// under nginx's 4m on /api/chat.php
const FRAMES_BUDGET = 2.5e6;

const canvas = document.createElement('canvas');
const thumb = document.createElement('canvas');
thumb.width = 16;
thumb.height = 9;

// a shared tab plays in the <video> muted, it has its own sound.
// a file's clock is played time, so pause and seek don't eat the window
export function startCapture(video, { stream = null, frameEvery = 5, onWindow }) {
  const framesKept = Math.ceil(WINDOW_S / frameEvery);
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const duck = ctx.createGain();
  let node = null;
  let frames = [];
  let played = 0;
  let total = 0;
  let nextFrameAt = 0;
  let lastTime = video.currentTime;
  const now = () => stream ? total : video.currentTime;
  let windowFrom = now();
  let peakRms = 0;
  let segments = [];
  let recording = false;
  let pcmWaiter = null;
  let stopped = false;

  const audioReady = (async () => {
    if (!window.AudioWorkletNode || !ctx.audioWorklet) return false;
    let source;
    if (stream) {
      if (!stream.getAudioTracks().length) return false;
      source = ctx.createMediaStreamSource(stream);
    } else {
      source = ctx.createMediaElementSource(video);
      source.connect(duck).connect(ctx.destination);
    }
    await ctx.audioWorklet.addModule(new URL('../voice/mic-worklet.js?v=1', import.meta.url).href);
    node = new AudioWorkletNode(ctx, 'mic-processor', {
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { preRollMs: 1, maxMs: (WINDOW_S + 8) * 1000 },
    });
    node.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'rms') peakRms = Math.max(peakRms, m.rms);
      else if (m.type === 'pcm') {
        const w = pcmWaiter;
        pcmWaiter = null;
        if (w) { w(m.pcm); return; }
        // the worklet hit its cap and stopped by itself (a stalled
        // stream keeps recording while played time doesn't move)
        recording = false;
        if (m.pcm && m.pcm.length) segments.push(m.pcm);
        startSegment();
      }
    };
    source.connect(node);
    return true;
  })().catch(() => false);

  function grabFrame() {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return;
    const scale = Math.min(1, FRAME_PX / Math.max(w, h));
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const t = thumb.getContext('2d', { willReadFrequently: true });
    t.drawImage(video, 0, 0, 16, 9);
    const px = t.getImageData(0, 0, 16, 9).data;
    const grey = new Float32Array(144);
    for (let i = 0; i < 144; i++) grey[i] = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3;
    const jpeg = canvas.toDataURL('image/jpeg', 0.7).split(',')[1];
    frames.push({ jpeg, grey, at: Math.round(now()) });
    if (frames.length > framesKept) frames.shift();
  }

  function stopSegment() {
    if (!node || !recording) return Promise.resolve();
    recording = false;
    return new Promise((resolve) => {
      pcmWaiter = (pcm) => { if (pcm && pcm.length) segments.push(pcm); resolve(); };
      node.port.postMessage({ type: 'stop' });
    });
  }

  function startSegment() {
    if (!node || recording || stopped) return;
    recording = true;
    node.port.postMessage({ type: 'start' });
  }

  async function takeWav() {
    await stopSegment();
    const total = segments.reduce((n, s) => n + s.length, 0);
    const parts = segments;
    segments = [];
    const loud = peakRms >= QUIET_RMS;
    peakRms = 0;
    if (!loud || total < ctx.sampleRate) return null;
    const all = new Float32Array(total);
    let off = 0;
    for (const p of parts) { all.set(p, off); off += p.length; }
    // chat.php refuses past 25 s, keep the newest
    const joined = all.subarray(Math.max(0, total - MAX_AUDIO_S * ctx.sampleRate));
    const len = joined.length;
    const off16 = new OfflineAudioContext(1, Math.ceil(len * WAV_RATE / ctx.sampleRate), WAV_RATE);
    const buf = off16.createBuffer(1, len, ctx.sampleRate);
    buf.copyToChannel(joined, 0);
    const src = off16.createBufferSource();
    src.buffer = buf;
    src.connect(off16.destination);
    src.start();
    const out = await off16.startRendering();
    return encodeWav(out.getChannelData(0), WAV_RATE);
  }

  // a frozen tab and silence is a paused tab. nothing to send
  function changed(list) {
    for (let i = 1; i < list.length; i++) {
      let d = 0;
      for (let j = 0; j < 144; j++) d += Math.abs(list[i].grey[j] - list[i - 1].grey[j]);
      if (d / 144 > 2) return true;
    }
    return false;
  }

  // DRM pages (netflix and friends) capture as pure black
  const black = (list) => list.every(f => f.grey.every(v => v < 4));

  async function flush(reason) {
    let shots = frames;
    frames = [];
    const from = Math.round(windowFrom);
    windowFrom = now();
    const wav = await takeWav();
    played = 0;
    nextFrameAt = 0;
    if (stream && reason === 'tick' && wav === null && !changed(shots)) return null;
    if (black(shots)) shots = [];
    while (shots.reduce((n, f) => n + f.jpeg.length, 0) > FRAMES_BUDGET) shots = shots.filter((_, i) => i % 2);
    return {
      from, to: Math.round(now()), wav, wavB64: wav ? base64Of(wav) : '',
      frames: shots.map(f => f.jpeg), stamps: shots.map(f => f.at),
    };
  }

  async function onSecond() {
    if (stopped) return;
    let delta;
    if (stream) {
      delta = 1;
    } else {
      delta = video.currentTime - lastTime;
      lastTime = video.currentTime;
      if (Math.abs(delta) >= 2) {
        // a seek. what's buffered is a different scene now
        frames = [];
        await stopSegment();
        segments = [];
        played = 0;
        nextFrameAt = 0;
        windowFrom = video.currentTime;
        if (!video.paused) startSegment();
        return;
      }
      if (video.paused || delta <= 0) return;
    }
    played += delta;
    total += delta;
    if (played >= nextFrameAt) { grabFrame(); nextFrameAt += frameEvery; }
    if (played >= WINDOW_S) {
      const win = await flush('tick');
      startSegment();
      if (win) onWindow(win);
    }
  }

  const timer = setInterval(onSecond, 1000);
  const onPlay = () => { ctx.resume(); lastTime = video.currentTime; startSegment(); };
  const onPause = () => { stopSegment(); };
  video.addEventListener('play', onPlay);
  video.addEventListener('pause', onPause);
  audioReady.then(() => { if (stream || !video.paused) startSegment(); });

  return {
    hasAudio: audioReady,
    seconds: () => total,
    async snapshot() {
      if (!frames.length) grabFrame();
      const win = await flush('talk');
      if (stream || !video.paused) startSegment();
      return win;
    },
    duck(gain) { duck.gain.setTargetAtTime(gain, ctx.currentTime, 0.15); },
    stop() {
      stopped = true;
      clearInterval(timer);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      ctx.close().catch(() => {});
    },
  };
}
