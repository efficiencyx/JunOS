import * as ui from '../core/ui.js?v=1';
import * as Live2D from '../live2d/live2d.js?v=4';
import * as TTS from './tts.js?v=2';
import * as Voice from './voice.js?v=2';

let active = false;
let muted = false;
let hooks = { onEnter: null, onExitMidStream: null };

const overlay = () => document.getElementById('voiceOverlay');

export function isActive() { return active; }

export async function enter() {
  if (active) return;
  const sup = Voice.support();
  if (!sup.ok) {
    ui.toast('⚠ Voice mode unavailable: ' + (sup.reason === 'insecure_context'
      ? 'needs HTTPS or localhost' : sup.reason), 'error');
    return;
  }
  try {
    await Voice.enable();
  } catch (e) {
    ui.toast('⚠ Mic blocked - check the browser permission', 'error');
    return;
  }
  TTS.setEnabled(true);
  muted = false;
  active = true;
  const ov = overlay();
  if (ov) {
    ov.hidden = false;
    ov.classList.remove('muted');
    updateMuteIcon();
    // force layout NOW, or the fade has nothing to start from
    void ov.offsetHeight;
  }
  document.body.classList.add('voice-mode');
  if (hooks.onEnter) hooks.onEnter();
  Live2D.setCameraPreset('face');
}

export function exit() {
  if (!active) return;
  active = false;
  document.body.classList.remove('voice-mode');
  const ov = overlay();
  if (ov) setTimeout(() => { if (!active) ov.hidden = true; }, 300);
  if (hooks.onExitMidStream) hooks.onExitMidStream();
  const voiceChk = document.getElementById('voiceChk');
  if (!(voiceChk && voiceChk.checked)) Voice.disable();
  else if (muted) Voice.enable().catch(() => {});
  const ttsChk = document.getElementById('ttsChk');
  const ttsOn = !!(ttsChk && ttsChk.checked);
  TTS.setEnabled(ttsOn);
  if (!ttsOn) TTS.stop();
  Live2D.setCameraPreset('default');
}

export function toggle() { active ? exit() : enter(); }

function updateMuteIcon() {
  const btn = document.getElementById('voiceOverlayMute');
  if (!btn) return;
  btn.querySelector('.ico-mic').style.display = muted ? 'none' : '';
  btn.querySelector('.ico-mic-off').style.display = muted ? '' : 'none';
  btn.title = btn.ariaLabel = muted ? 'Unmute microphone' : 'Mute microphone';
}

function toggleMute() {
  if (!active) return;
  muted = !muted;
  if (muted) Voice.disable();
  else Voice.enable().catch(() => { muted = true; });
  const ov = overlay();
  if (ov) ov.classList.toggle('muted', muted);
  updateMuteIcon();
  const status = document.getElementById('voiceOverlayStatus');
  if (status && muted) { status.textContent = 'muted'; status.dataset.state = 'idle'; }
}

export function init(h) {
  hooks = { ...hooks, ...h };
  const btn = document.getElementById('voiceModeBtn');
  if (btn) btn.addEventListener('click', toggle);
  const close = document.getElementById('voiceOverlayClose');
  if (close) close.addEventListener('click', exit);
  const mute = document.getElementById('voiceOverlayMute');
  if (mute) mute.addEventListener('click', toggleMute);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && active) exit();
  });
}
