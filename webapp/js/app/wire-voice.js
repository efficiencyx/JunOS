import { renderVoiceDraft, stopActiveStream } from './session.js?v=1';
import { sendAudioFromVoice, sendFromVoice } from './chat.js?v=81';
import { voiceBargeChk, voiceChk, voiceHearAllChk, voiceSilenceInput, voiceState } from './dom.js?v=77';
import { hideFaceBubble } from './face-bubble.js?v=102';
import { logAction } from './logging.js?v=78';
import { syncVoiceDeps, updateVoiceSilenceLabel } from './settings.js?v=158';
import * as Prefs from '../core/prefs.js?v=11';
import * as ui from '../core/ui.js?v=12';
import * as Voice from '../voice/voice.js?v=156';
import * as VoiceMode from '../voice/voicemode.js?v=103';
import { t } from '../core/i18n.js?v=2';

const VOICE_STATE_LABELS = {
  idle: t('voice.state.off', 'off'),
  calibrating: t('voice.state.calibrating', 'listening to the room…'),
  listening: t('voice.state.listening', 'listening'),
  // maybe lasts ~96ms. way too short to flicker another label
  maybe: t('voice.state.listening', 'listening'),
  speech: t('voice.state.speech', 'hearing you'),
  thinking: t('voice.state.thinking', 'transcribing…'),
};

async function sttAvailable() {
  try {
    const r = await fetch('/api/stt.php?action=health', { credentials: 'same-origin' });
    if (!r.ok) return false;
    const d = await r.json();
    return !!d.stt;
  } catch (e) {
    return false;
  }
}

export async function wireVoice() {
  if (voiceChk) {
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
          ui.toast(t('voice.err.noAudio', '⚠ This model can\'t hear - falling back to transcription'), 'error');
          text.then(t => { if (t) sendFromVoice(t); });
        } else {
          ui.toast(t('voice.err.noAudioNoStt', '⚠ This model can\'t hear and speech-to-text is not running - voice needs one of the two'), 'error');
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

    VoiceMode.init({
      onEnter: hideFaceBubble,
      onExitMidStream: () => { if (renderVoiceDraft) renderVoiceDraft(); },
    });

    if (!sup.ok) {
      voiceChk.disabled = true;
      const why = sup.reason === 'insecure_context'
        ? t('voice.why.https', 'needs HTTPS (or localhost) - see TLS_MODE in .env')
        : sup.reason === 'no_getusermedia'
          ? t('voice.why.noMic', 'no microphone API in this browser')
          : t('voice.why.noWorklet', 'no AudioWorklet in this browser');
      if (voiceState) voiceState.textContent = t('voice.state.unavailable', 'unavailable');
      const voiceModeBtn = document.getElementById('voiceModeBtn');
      if (voiceModeBtn) { voiceModeBtn.disabled = true; voiceModeBtn.title = t('voice.modeUnavailable', 'Voice mode unavailable: {why}', { why }); }
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
            ? t('voice.hearAll.on', 'She hears everything - click so she ignores side-talk')
            : t('voice.hearAll.title', 'She ignores side-talk - click so she hears everything');
        }
        if (!save) return;
        localStorage.setItem('voice.hear_all', on ? '1' : '0');
        Prefs.pushToServer();
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
            ui.toast(t('voice.err.micBlocked', '⚠ Mic blocked - check the browser permission'), 'error');
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
          Prefs.pushToServer();
        });
      }
      if (voiceSilenceInput) {
        voiceSilenceInput.addEventListener('input', updateVoiceSilenceLabel);
        voiceSilenceInput.addEventListener('change', () => {
          const ms = parseInt(voiceSilenceInput.value, 10) || 700;
          Voice.setSilenceMs(ms);
          localStorage.setItem('voice.silence_ms', String(ms));
          Prefs.pushToServer();
        });
      }
    }
  }

}
