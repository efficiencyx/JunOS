window.VoiceMode = (function () {
  let active = false;
  let muted = false;
  let hooks = { onEnter: null, onExitMidStream: null, sttAvailable: null };

  const overlay = () => document.getElementById('voiceOverlay');

  function isActive() { return active; }

  async function enter() {
    if (active) return;
    const sup = window.Voice ? Voice.support() : { ok: false, reason: 'no voice module' };
    if (!sup.ok) {
      ui.toast('⚠ Voice mode unavailable: ' + (sup.reason === 'insecure_context'
        ? 'needs HTTPS or localhost' : sup.reason), 'error');
      return;
    }
    if (hooks.sttAvailable && !(await hooks.sttAvailable())) {
      ui.toast('⚠ Voice mode unavailable: speech-to-text is not running', 'error');
      return;
    }
    try {
      await Voice.enable(); // does nothing if hands-free is already on in settings
    } catch (e) {
      ui.toast('⚠ Mic blocked - check the browser permission', 'error');
      return;
    }
    if (window.TTS) TTS.setEnabled(true); // her talking back IS the point here
    muted = false;
    active = true;
    const ov = overlay();
    if (ov) {
      ov.hidden = false;
      ov.classList.remove('muted');
      updateMuteIcon();
      void ov.offsetHeight; // forces layout NOW so the fade has something to run from
    }
    document.body.classList.add('voice-mode');
    if (hooks.onEnter) hooks.onEnter();
    if (window.Live2D) Live2D.setCameraPreset('face');
  }

  function exit() {
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
    if (window.TTS) {
      TTS.setEnabled(ttsOn);
      if (!ttsOn) TTS.stop();
    }
    if (window.Live2D) Live2D.setCameraPreset('default');
  }

  function toggle() { active ? exit() : enter(); }

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

  function init(h) {
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

  return { init, isActive, enter, exit, toggle };
})();
