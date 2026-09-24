import * as Live2D from '../live2d/live2d.js?v=4';
import { $, active, hooks } from './karaoke.js?v=2';
import { mode, setStatus, track } from './setup.js?v=2';
import { startRecording, stopRecording } from './recorder.js?v=2';
import { clamp } from '../core/util.js?v=1';

// queue both stems (the split vocal and backing tracks) 0.1
// seconds ahead, so they start on the exact same sample.
const START_LEAD = 0.1;

// slide the guide vocal over 0.05 seconds, or the handoff
// clicks.
const GAIN_RAMP = 0.05;
export let audioCtx = null, analyser = null, analyserBuf = null, masterGain = null;
export let instrSource = null, guideSource = null, guideGain = null;
let startTime = 0, rafId = 0;
let wordEls = [], lineEls = [];
let activeLine = -1, activeWordLine = -1, activeWordIdx = -1;
let lastOwnerKey = '';
export let soloPhase = 'you';
let volume = 1.0;
let junVolume = 0.8;

export function ensureCtx() {
  if (audioCtx) return audioCtx;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.4;
  analyserBuf = new Float32Array(analyser.fftSize);
  masterGain = audioCtx.createGain();
  masterGain.gain.value = volume;
  masterGain.connect(audioCtx.destination);
  return audioCtx;
}

export function renderLyrics() {
  const box = $('karaokeLyrics');
  if (!box) return;
  box.innerHTML = '';
  wordEls = [];
  lineEls = [];
  activeLine = activeWordLine = activeWordIdx = -1;
  track.sections.forEach((sec) => {
    const line = document.createElement('div');
    line.className = 'karaoke-line';
    line.dataset.owner = sec.owner;
    const els = [];
    sec.words.forEach((w, k) => {
      const s = document.createElement('span');
      s.className = 'karaoke-word';
      s.textContent = w.word;
      line.appendChild(s);
      if (k < sec.words.length - 1) line.appendChild(document.createTextNode(' '));
      els.push(s);
    });
    box.appendChild(line);
    lineEls.push(line);
    wordEls.push(els);
  });
  renderTicks();
}

function renderTicks() {
  const bar = $('karaokeProgressBar');
  if (!bar || !track.duration) return;
  bar.querySelectorAll('.karaoke-tick').forEach(t => t.remove());
  for (const sec of track.sections) {
    if (sec.start <= 0) continue;
    const tick = document.createElement('span');
    tick.className = 'karaoke-tick';
    tick.style.left = (sec.start / track.duration * 100) + '%';
    bar.appendChild(tick);
  }
}

function computeRms() {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(analyserBuf);
  let sum = 0;
  for (let i = 0; i < analyserBuf.length; i++) sum += analyserBuf[i] * analyserBuf[i];
  return Math.sqrt(sum / analyserBuf.length);
}

function sectionAt(elapsed) {
  const secs = track.sections;
  let idx = -1;
  for (let i = 0; i < secs.length; i++) {
    if (elapsed >= secs[i].start) idx = i;
    else break;
  }
  return idx;
}

function updateTurn(si, owner) {
  const el = $('karaokeTurn');
  if (!el) return;
  const next = si + 1 < track.sections.length ? track.sections[si + 1].owner : null;
  const key = owner + '>' + (next || '');
  if (key === lastOwnerKey) return;
  lastOwnerKey = key;
  const label = owner === 'you' ? 'Your turn' : owner === 'jun' ? "Jun's turn" : 'Together';
  const nextLabel = next && next !== owner
    ? next === 'you' ? 'you' : next === 'jun' ? 'Jun' : 'together'
    : null;
  el.dataset.owner = owner;
  el.innerHTML = `<span class="karaoke-turn-main">${label}</span>` +
    (nextLabel ? `<span class="karaoke-turn-next">next: ${nextLabel}</span>` : '');
}

function setActiveLine(si) {
  if (si === activeLine) return;
  if (lineEls[activeLine]) lineEls[activeLine].classList.remove('active');
  if (lineEls[si]) { lineEls[si].classList.add('active'); lineEls[si].scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  activeLine = si;
}

function setActiveWord(si, wi) {
  if (si === activeWordLine && wi === activeWordIdx) return;
  if (wordEls[activeWordLine] && wordEls[activeWordLine][activeWordIdx])
    wordEls[activeWordLine][activeWordIdx].classList.remove('active');
  if (si >= 0 && wi >= 0 && wordEls[si] && wordEls[si][wi])
    wordEls[si][wi].classList.add('active');
  activeWordLine = si; activeWordIdx = wi;
}

function loop() {
  rafId = 0;
  if (!active || !audioCtx || !track) return;
  const elapsed = audioCtx.currentTime - startTime;
  const secs = track.sections;
  const si = sectionAt(elapsed);
  const owner = si >= 0 ? secs[si].owner : (secs[0] ? secs[0].owner : 'both');

  const level = computeRms();
  if (hooks.onLevel) hooks.onLevel(level);
  if (owner === 'you') Live2D.setMouthOverride(0);
  else Live2D.setMouthOverride(Math.pow(Math.min(1, level * 3.5), 0.7));

  updateTurn(si, owner);
  setActiveLine(si);

  let cw = -1;
  if (si >= 0) {
    const ws = secs[si].words;
    for (let i = 0; i < ws.length; i++) {
      if (elapsed >= ws[i].start && elapsed <= ws[i].end) { cw = i; break; }
      if (elapsed < ws[i].start) break;
      cw = i;
    }
  }
  setActiveWord(si, cw);

  const fill = $('karaokeProgressFill');
  if (fill) fill.style.width = (track.duration ? Math.min(1, elapsed / track.duration) * 100 : 0) + '%';

  rafId = requestAnimationFrame(loop);
}

const targetFor = (owner) => (owner === 'you' ? 0 : junVolume);

function scheduleGuideAutomation() {
  const g = guideGain.gain;
  g.cancelScheduledValues(0);
  const secs = track.sections;
  let prev = secs.length ? targetFor(secs[0].owner) : junVolume;
  g.setValueAtTime(prev, startTime);
  for (const sec of secs) {
    const t = Math.max(startTime, startTime + sec.start);
    const tg = targetFor(sec.owner);
    g.setValueAtTime(prev, t);
    g.linearRampToValueAtTime(tg, t + GAIN_RAMP);
    prev = tg;
  }
}

export function start(nextSoloPhase = 'you') {
  if (!track) return;
  stopPlayback();
  lastOwnerKey = '';

  if (mode === 'solo') {
    soloPhase = nextSoloPhase;
    track.sections.forEach(section => { section.owner = soloPhase; });
    renderLyrics();
  }

  instrSource = audioCtx.createBufferSource();
  instrSource.buffer = track.instrBuf;
  instrSource.connect(masterGain);

  guideGain = audioCtx.createGain();
  guideSource = audioCtx.createBufferSource();
  guideSource.buffer = track.guideBuf;
  guideSource.connect(guideGain);
  guideGain.connect(masterGain);
  // tap after the gain, lipsync follows only the vocal you actually
  // hear
  guideGain.connect(analyser);

  startTime = audioCtx.currentTime + START_LEAD;
  scheduleGuideAutomation();
  instrSource.start(startTime);
  guideSource.start(startTime);
  instrSource.onended = () => {
    if (!active) return;
    if (mode === 'solo' && soloPhase === 'you') {
      start('jun');
      return;
    }
    stopPlayback();
    setStatus(mode === 'solo' ? 'Solo relay complete' : 'Take complete');
  };

  if (hooks.onPlaybackChange) hooks.onPlaybackChange(true);
  if (mode !== 'solo' || soloPhase === 'you') startRecording();
  if (!rafId) rafId = requestAnimationFrame(loop);
  setStatus(mode === 'solo'
    ? soloPhase === 'you' ? 'Your solo… Jun goes next' : "Jun's solo…"
    : 'Singing… tap Stop when done');
}

export function stopPlayback() {
  if (hooks.onPlaybackChange) hooks.onPlaybackChange(false);
  if (hooks.onLevel) hooks.onLevel(0);
  for (const s of [instrSource, guideSource]) {
    if (!s) continue;
    try { s.onended = null; s.stop(); } catch (e) {}
    try { s.disconnect(); } catch (e) {}
  }
  if (guideGain) { try { guideGain.disconnect(); } catch (e) {} }
  instrSource = guideSource = guideGain = null;
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  Live2D.setMouthOverride(0);
  setActiveWord(-1, -1);
  setActiveLine(-1);
  lastOwnerKey = '';
  stopRecording();
}

export function setJunVolume(v) {
  junVolume = clamp(v, 0, 1);
  if (!guideGain || !audioCtx || !track) return;
  const now = audioCtx.currentTime;
  const idx = sectionAt(now - startTime);
  const curOwner = idx >= 0 ? track.sections[idx].owner : 'both';
  const g = guideGain.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(targetFor(curOwner), now + GAIN_RAMP);
  let prev = targetFor(curOwner);
  for (let i = idx + 1; i < track.sections.length; i++) {
    const t = startTime + track.sections[i].start;
    if (t <= now) continue;
    const tg = targetFor(track.sections[i].owner);
    g.setValueAtTime(prev, t);
    g.linearRampToValueAtTime(tg, t + GAIN_RAMP);
    prev = tg;
  }
}

export function setVolume(v) {
  volume = clamp(Number.isFinite(v) ? v : 1, 0, 1);
  if (!masterGain || !audioCtx) return;
  const now = audioCtx.currentTime;
  masterGain.gain.cancelScheduledValues(now);
  masterGain.gain.setTargetAtTime(volume, now, 0.02);
}
