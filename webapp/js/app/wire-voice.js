import { VOICE_STATE_LABELS, renderVoiceDraft, sendAudioFromVoice, sendFromVoice, stopActiveStream, sttAvailable } from '../app.js?v=17';
import { voiceBargeChk, voiceChk, voiceHearAllChk, voiceSilenceInput, voiceState } from './dom.js?v=11';
import { hideFaceBubble } from './face-bubble.js?v=12';
import { logAction } from './logging.js?v=10';
import { syncVoiceDeps, updateVoiceSilenceLabel } from './settings.js?v=13';

export async function wireVoice() {
  if (window.Voice && voiceChk) {
    Voice.setLogger(logAction);
    Voice.setOnTranscript(sendFromVoice);

    const sup = Voice.support();
    const sttOk = await sttAvailable();

    // she hears the wav herself when the backend can take it, and
    // whisper runs NEXT to her, not instead: the transcript backfills
    // the <audio> placeholder so history reads words. the FIRST refusal
    // turns audio turns off for the rest of the page, we never ask the
    // server up front. the refused utterance goes through whisper right
    // away, not the next one, same call, not a second one. no whisper
    // either = that turn is gone and we say so
    let audioTurns = true;
    Voice.setOnAudio((b64, stt) => {
      if (!audioTurns) return false;
      const text = sttOk ? stt() : Promise.resolve('');
      const turn = sendAudioFromVoice(b64, () => {
        audioTurns = false;
        if (sttOk) {
          ui.toast('⚠ This model can\'t hear - falling back to transcription', 'error');
          text.then(t => { if (t) sendFromVoice(t); });
        } else {
          ui.toast('⚠ This model can\'t hear and speech-to-text is not running - voice needs one of the two', 'error');
        }
      });
      text.then(t => { if (t) turn.setTranscript(t); });
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
        onEnter: hideFaceBubble,
        onExitMidStream: () => { if (renderVoiceDraft) renderVoiceDraft(); },
      });
    }

    if (!sup.ok) {
      voiceChk.disabled = true;
      const why = sup.reason === 'insecure_context'
        ? 'needs HTTPS (or localhost) - see TLS_MODE in .env'
        : sup.reason === 'no_getusermedia'
          ? 'no microphone API in this browser'
          : 'no AudioWorklet in this browser';
      if (voiceState) voiceState.textContent = 'unavailable';
      const voiceModeBtn = document.getElementById('voiceModeBtn');
      if (voiceModeBtn) { voiceModeBtn.disabled = true; voiceModeBtn.title = `Voice mode unavailable: ${why}`; }
      logAction('warn', `Voice mode unavailable: ${why}`);
    } else {
      if (!sttOk) logAction('warn', 'No speech-to-text on the sidecar - voice works only while the chat model can hear (Ollama + audio capability)');
      const savedBarge = localStorage.getItem('voice.bargein') !== '0';
      const savedSilence = parseInt(localStorage.getItem('voice.silence_ms') || '700', 10);
      Voice.setBargeIn(savedBarge);
      Voice.setSilenceMs(savedSilence);
      if (voiceBargeChk) voiceBargeChk.checked = savedBarge;
      if (voiceSilenceInput) voiceSilenceInput.value = String(savedSilence);
      updateVoiceSilenceLabel();

      const hearAllBtn = document.getElementById('voiceOverlayHearAll');
      const voiceOverlay = document.getElementById('voiceOverlay');
      const applyHearAll = (on, save) => {
        Voice.setHearAll(on);
        if (voiceHearAllChk) voiceHearAllChk.checked = on;
        if (voiceOverlay) voiceOverlay.classList.toggle('hear-all', on);
        if (hearAllBtn) {
          hearAllBtn.title = hearAllBtn.ariaLabel = on
            ? 'She hears everything - click so she ignores side-talk'
            : 'She ignores side-talk - click so she hears everything';
        }
        if (!save) return;
        localStorage.setItem('voice.hear_all', on ? '1' : '0');
        if (window.Prefs) Prefs.pushToServer();
      };
      applyHearAll(localStorage.getItem('voice.hear_all') === '1', false);
      if (voiceHearAllChk) voiceHearAllChk.addEventListener('change', () => applyHearAll(voiceHearAllChk.checked, true));
      if (hearAllBtn) hearAllBtn.addEventListener('click', () => applyHearAll(!Voice.hearAll(), true));

      // a live mic is a per session choice. Never a synced setting.
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
