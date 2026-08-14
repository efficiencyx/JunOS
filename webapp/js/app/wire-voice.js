import { VOICE_STATE_LABELS, renderVoiceDraft, sendAudioFromVoice, sendFromVoice, stopActiveStream, sttAvailable } from '../app.js?v=1';
import { voiceBargeChk, voiceChk, voiceSilenceInput, voiceState } from './dom.js?v=1';
import { hideFaceBubble } from './face-bubble.js?v=1';
import { logAction } from './logging.js?v=1';
import { syncVoiceDeps, updateVoiceSilenceLabel } from './settings.js?v=1';

// Same deal as wire-tts. optional piece, wiring that keeps to itself.
export async function wireVoice() {
  if (window.Voice && voiceChk) {
    Voice.setLogger(logAction);
    Voice.setOnTranscript(sendFromVoice);

    // She hears the wav herself when the backend can take it. the first
    // refusal turns this off for the rest of the page, we never ask the
    // server up front.
    let audioTurns = true;
    Voice.setOnAudio((b64) => {
      if (!audioTurns) return false;
      sendAudioFromVoice(b64, () => { audioTurns = false; });
      return true;
    });

    Voice.setOnBargeIn(() => { if (stopActiveStream) stopActiveStream(); });
    const voiceOverlayStatus = document.getElementById('voiceOverlayStatus');
    Voice.setOnState((s) => {
      if (voiceState) {
        voiceState.textContent = VOICE_STATE_LABELS[s] || s;
        voiceState.dataset.state = s;
      }
      if (voiceOverlayStatus) {
        voiceOverlayStatus.textContent = VOICE_STATE_LABELS[s] || s;
        voiceOverlayStatus.dataset.state = s;
      }
    });

    if (window.VoiceMode) {
      VoiceMode.init({
        sttAvailable,
        onEnter: hideFaceBubble,
        onExitMidStream: () => { if (renderVoiceDraft) renderVoiceDraft(); },
      });
    }

    const sup = Voice.support();
    const sttOk = await sttAvailable();
    if (!sup.ok || !sttOk) {
      voiceChk.disabled = true;
      const why = !sup.ok
        ? (sup.reason === 'insecure_context'
            ? 'needs HTTPS (or localhost) - see TLS_MODE in .env'
            : sup.reason === 'no_getusermedia'
              ? 'no microphone API in this browser'
              : 'no AudioWorklet in this browser')
        : 'sidecar has no speech-to-text (rebuild the tts image)';
      if (voiceState) voiceState.textContent = 'unavailable';
      const voiceModeBtn = document.getElementById('voiceModeBtn');
      if (voiceModeBtn) { voiceModeBtn.disabled = true; voiceModeBtn.title = `Voice mode unavailable: ${why}`; }
      logAction('warn', `Voice mode unavailable: ${why}`);
    } else {
      const savedBarge = localStorage.getItem('voice.bargein') !== '0';
      const savedSilence = parseInt(localStorage.getItem('voice.silence_ms') || '700', 10);
      Voice.setBargeIn(savedBarge);
      Voice.setSilenceMs(savedSilence);
      if (voiceBargeChk) voiceBargeChk.checked = savedBarge;
      if (voiceSilenceInput) voiceSilenceInput.value = String(savedSilence);
      updateVoiceSilenceLabel();

      // A live mic is something you pick per session, Never a synced setting.
      voiceChk.checked = false;
      voiceChk.addEventListener('change', async () => {
        if (voiceChk.checked) {
          try {
            await Voice.enable();
            syncVoiceDeps();
          } catch (e) {
            voiceChk.checked = false;
            syncVoiceDeps();
            ui.toast('⚠ Mic blocked - check the browser permission', 'error');
          }
        } else {
          Voice.disable();
          syncVoiceDeps();
        }
      });

      if (voiceBargeChk) {
        voiceBargeChk.addEventListener('change', () => {
          Voice.setBargeIn(voiceBargeChk.checked);
          localStorage.setItem('voice.bargein', voiceBargeChk.checked ? '1' : '0');
          if (window.Prefs) Prefs.pushToServer();
        });
      }
      if (voiceSilenceInput) {
        voiceSilenceInput.addEventListener('input', updateVoiceSilenceLabel);
        voiceSilenceInput.addEventListener('change', () => {
          const ms = parseInt(voiceSilenceInput.value, 10) || 700;
          Voice.setSilenceMs(ms);
          localStorage.setItem('voice.silence_ms', String(ms));
          if (window.Prefs) Prefs.pushToServer();
        });
      }
    }
  }

}
