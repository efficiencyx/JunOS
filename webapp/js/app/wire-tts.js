import { IDLE_AFTER_REPLY_MS, scheduleIdleNudge } from './consolidation.js?v=70';
import { ttsChk, ttsEngineSelect, ttsLangRow, ttsLangSelect, ttsSpeedInput, ttsVoiceSelect } from './dom.js?v=70';
import { finishPendingFaceBubbleHide } from './face-bubble.js?v=70';
import { logAction } from './logging.js?v=70';
import { syncVoiceDeps, updateTtsSpeedLabel } from './settings.js?v=70';
import { escapeHtml } from './util.js?v=70';

// Pulled out of bootstrap(): TTS is optional and its wiring is one long block of
// preference plumbing that has nothing to say about the rest of startup.
export async function wireTts() {
  if (window.TTS) {
    TTS.setLogger(logAction);
    if (TTS.setOnAllDone) TTS.setOnAllDone(() => {
      finishPendingFaceBubbleHide();
      scheduleIdleNudge(IDLE_AFTER_REPLY_MS);
    });
    const savedEnabled = localStorage.getItem('tts.enabled') === '1';
    const savedVoice = localStorage.getItem('tts.voice') || '';
    const savedLang = localStorage.getItem('tts.lang') || '';
    const savedSpeed = parseFloat(localStorage.getItem('tts.speed') || '1.0');
    const savedEngine = localStorage.getItem('tts.engine') || 'kokoro';
    TTS.setSpeed(savedSpeed);
    if (ttsSpeedInput) ttsSpeedInput.value = String(savedSpeed);
    updateTtsSpeedLabel();

    let engines = {};
    function populateVoices(engineKey, preferred) {
      const info = engines[engineKey] || { voices: [], default: '' };
      const voices = info.voices || [];
      const def = (preferred && voices.includes(preferred)) ? preferred
        : (voices.includes(info.default) ? info.default : (voices[0] || ''));
      if (ttsVoiceSelect) {
        ttsVoiceSelect.innerHTML = voices.map(name =>
          `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
        if (def) ttsVoiceSelect.value = def;
      }
      TTS.setVoice(def);
      return def;
    }

    // Language only applies to pocket-tts; the row stays hidden for engines that
    // don't advertise a `languages` list.
    function populateLanguages(engineKey, preferred) {
      const info = engines[engineKey] || {};
      const baseLangs = info.languages || [];
      if (ttsLangRow) ttsLangRow.hidden = baseLangs.length === 0;
      if (!baseLangs.length) { TTS.setLang(''); return ''; }
      // 'auto' is a client-side pseudo-language: TTS detects each reply's language
      // and sends a concrete id. It's the default so routing works out of the box.
      const langs = [{ id: 'auto', label: 'Auto-detect' }, ...baseLangs];
      const ids = langs.map(l => l.id);
      const def = (preferred && ids.includes(preferred)) ? preferred : 'auto';
      if (ttsLangSelect) {
        ttsLangSelect.innerHTML = langs.map(l =>
          `<option value="${escapeHtml(l.id)}">${escapeHtml(l.label || l.id)}</option>`).join('');
        ttsLangSelect.value = def;
      }
      TTS.setLang(def);
      return def;
    }

    try {
      const v = await TTS.listVoices();
      engines = v.engines || {};
      if (ttsEngineSelect) {
        const ENGINE_LABELS = { kokoro: 'Kokoro', pockettts: 'Pocket-TTS' };
        ttsEngineSelect.innerHTML = Object.keys(engines).map(k =>
          `<option value="${escapeHtml(k)}">${escapeHtml(ENGINE_LABELS[k] || k)}</option>`).join('');
      }
      const engineKey = engines[savedEngine] ? savedEngine
        : (engines[v.default_engine] ? v.default_engine : Object.keys(engines)[0] || 'kokoro');
      TTS.setEngine(engineKey);
      if (ttsEngineSelect) ttsEngineSelect.value = engineKey;
      const def = populateVoices(engineKey, savedVoice);
      populateLanguages(engineKey, savedLang);
      const count = (engines[engineKey] && engines[engineKey].voices || []).length;
      if (count) logAction('ok', `TTS ready: ${engineKey}, ${count} voices (default ${def})`);
    } catch (e) {
      logAction('warn', 'TTS sidecar unreachable (start tts/run.sh)');
    }

    if (ttsEngineSelect) {
      ttsEngineSelect.addEventListener('change', () => {
        const engineKey = ttsEngineSelect.value;
        TTS.setEngine(engineKey);
        localStorage.setItem('tts.engine', engineKey);
        const def = populateVoices(engineKey, '');
        localStorage.setItem('tts.voice', def);
        const langDef = populateLanguages(engineKey, localStorage.getItem('tts.lang') || '');
        if (langDef) localStorage.setItem('tts.lang', langDef);
        if (window.Prefs) Prefs.pushToServer();
      });
    }

    if (ttsChk) {
      ttsChk.checked = savedEnabled;
      TTS.setEnabled(savedEnabled);
      ttsChk.addEventListener('change', () => {
        TTS.setEnabled(ttsChk.checked);
        if (!ttsChk.checked) finishPendingFaceBubbleHide();
        localStorage.setItem('tts.enabled', ttsChk.checked ? '1' : '0');
        syncVoiceDeps();
        if (window.Prefs) Prefs.pushToServer();
      });
      syncVoiceDeps();
    }
    if (ttsVoiceSelect) {
      ttsVoiceSelect.addEventListener('change', () => {
        TTS.setVoice(ttsVoiceSelect.value);
        localStorage.setItem('tts.voice', ttsVoiceSelect.value);
        if (window.Prefs) Prefs.pushToServer();
      });
    }
    if (ttsLangSelect) {
      ttsLangSelect.addEventListener('change', () => {
        TTS.setLang(ttsLangSelect.value);
        localStorage.setItem('tts.lang', ttsLangSelect.value);
        if (window.Prefs) Prefs.pushToServer();
      });
    }
    if (ttsSpeedInput) {
      ttsSpeedInput.addEventListener('input', updateTtsSpeedLabel);
      ttsSpeedInput.addEventListener('change', () => {
        const s = parseFloat(ttsSpeedInput.value) || 1.0;
        TTS.setSpeed(s);
        localStorage.setItem('tts.speed', String(s));
        if (window.Prefs) Prefs.pushToServer();
      });
    }
  }

}
