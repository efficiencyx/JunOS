import { IDLE_AFTER_REPLY_MS, scheduleIdleNudge } from './consolidation.js?v=123';
import { ttsChk, ttsEngineSelect, ttsLangRow, ttsLangSelect, ttsSpeedInput, ttsVoiceSelect } from './dom.js?v=77';
import { finishPendingFaceBubbleHide } from './face-bubble.js?v=92';
import { logAction } from './logging.js?v=78';
import { syncVoiceDeps, updateTtsSpeedLabel } from './settings.js?v=128';
import { escapeHtml } from '../core/util.js?v=1';
import * as Names from '../core/names.js?v=1';
import * as Prefs from '../core/prefs.js?v=7';
import * as TTS from '../voice/tts.js?v=91';
import { PREVIEW_LINES } from '../voice/kokoro-lang.js?v=1';

export async function wireTts() {
  TTS.setLogger(logAction);
  TTS.setOnAllDone(() => {
    finishPendingFaceBubbleHide();
    scheduleIdleNudge(IDLE_AFTER_REPLY_MS);
  });
  const savedEnabled = localStorage.getItem('tts.enabled') === '1';
  const savedVoice = localStorage.getItem('tts.voice') || '';
  const savedLang = localStorage.getItem('tts.lang') || '';
  const savedSpeed = parseFloat(localStorage.getItem('tts.speed') || '1.0');
  const savedEngine = localStorage.getItem('tts.engine') || 'kokoro';
  // Kokoro's voice per language, {english: 'af_heart', ...}. one
  // string pref like the rest, so prefs.js syncs it as is.
  let langVoices = {};
  try { langVoices = JSON.parse(localStorage.getItem('tts.voices') || '{}') || {}; } catch { langVoices = {}; }
  TTS.setSpeed(savedSpeed);
  if (ttsSpeedInput) ttsSpeedInput.value = String(savedSpeed);
  updateTtsSpeedLabel();

  let engines = {};
  // a language that brings its own voice list (Kokoro does,
  // pocket-tts voices fit every language) or null
  function langWithVoices(engineKey, langId) {
    const langs = (engines[engineKey] && engines[engineKey].languages) || [];
    return langs.find(l => l.id === langId && Array.isArray(l.voices)) || null;
  }
  function perLangVoices(engineKey) {
    const langs = (engines[engineKey] && engines[engineKey].languages) || [];
    return langs.some(l => Array.isArray(l.voices));
  }
  // every language gets a voice that's really one of its own, the
  // saved one if it still is, otherwise the language's default
  function syncLangVoices(engineKey) {
    if (!perLangVoices(engineKey)) { TTS.setLangVoices({}); return; }
    for (const l of engines[engineKey].languages) {
      if (!l.voices.includes(langVoices[l.id])) langVoices[l.id] = l.default || l.voices[0] || '';
    }
    TTS.setLangVoices(langVoices);
  }

  function populateVoices(engineKey, preferred, langId) {
    const info = engines[engineKey] || { voices: [], default: '' };
    // auto-detect with per-language voices: each language speaks in
    // the voice picked for it, so there's no single one to show.
    // pick a language to change its voice.
    if (langId === 'auto' && perLangVoices(engineKey)) {
      if (ttsVoiceSelect) {
        ttsVoiceSelect.innerHTML = '<option value="">Set per language</option>';
        ttsVoiceSelect.disabled = true;
      }
      const def = langVoices[info.default_language] || info.default || '';
      TTS.setVoice(def);
      return def;
    }
    if (ttsVoiceSelect) ttsVoiceSelect.disabled = false;
    const lang = langWithVoices(engineKey, langId);
    const voices = (lang ? lang.voices : info.voices) || [];
    const fallback = lang ? lang.default : info.default;
    if (lang) preferred = langVoices[lang.id] || preferred;
    const def = (preferred && voices.includes(preferred)) ? preferred
      : (voices.includes(fallback) ? fallback : (voices[0] || ''));
    if (ttsVoiceSelect) {
      ttsVoiceSelect.innerHTML = voices.map(name =>
        `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
      if (def) ttsVoiceSelect.value = def;
    }
    TTS.setVoice(def);
    return def;
  }

  // the row stays hidden for engines that don't hand us a
  // `languages` list (Kokoro without a second language installed)
  function populateLanguages(engineKey, preferred) {
    const info = engines[engineKey] || {};
    const baseLangs = info.languages || [];
    if (ttsLangRow) ttsLangRow.hidden = baseLangs.length === 0;
    // no choice means the engine's own default, not whatever the
    // last engine left behind
    if (!baseLangs.length) { TTS.setLang('english'); return ''; }
    // 'auto' is a fake language that only exists in the client.
    // TTS works out the language from the text and sends a real id.
    // pocket-tts defaults to it so it just works with zero setup.
    // Kokoro starts on its default language, English, so nothing
    // changes for anyone who never opens this menu: under auto its
    // voice menu is per language and would start out greyed.
    const langs = [{ id: 'auto', label: 'Auto-detect' }, ...baseLangs];
    const ids = langs.map(l => l.id);
    const fresh = perLangVoices(engineKey) && info.default_language ? info.default_language : 'auto';
    const def = (preferred && ids.includes(preferred)) ? preferred : fresh;
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
    syncLangVoices(engineKey);
    const langDef = populateLanguages(engineKey, savedLang);
    const def = populateVoices(engineKey, savedVoice, langDef);
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
      syncLangVoices(engineKey);
      const langDef = populateLanguages(engineKey, localStorage.getItem('tts.lang') || '');
      if (langDef) localStorage.setItem('tts.lang', langDef);
      const def = populateVoices(engineKey, '', langDef);
      localStorage.setItem('tts.voice', def);
      Prefs.pushToServer();
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
      Prefs.pushToServer();
    });
    syncVoiceDeps();
  }
  if (ttsVoiceSelect) {
    ttsVoiceSelect.addEventListener('change', () => {
      if (!ttsVoiceSelect.value) return;
      TTS.setVoice(ttsVoiceSelect.value);
      localStorage.setItem('tts.voice', ttsVoiceSelect.value);
      const engineKey = ttsEngineSelect ? ttsEngineSelect.value : '';
      const lang = langWithVoices(engineKey, ttsLangSelect ? ttsLangSelect.value : '');
      if (lang) {
        langVoices[lang.id] = ttsVoiceSelect.value;
        TTS.setLangVoices(langVoices);
        localStorage.setItem('tts.voices', JSON.stringify(langVoices));
      }
      Prefs.pushToServer();
    });
  }
  const previewBtn = document.getElementById('ttsPreviewBtn');
  if (previewBtn) {
    let previewing = false;
    const settle = () => { previewing = false; previewBtn.textContent = 'Play'; };
    // stop() from anywhere else cancels without either hook, so the
    // button can't trust previewing alone
    ttsChk?.addEventListener('change', () => { if (!ttsChk.checked) settle(); });
    previewBtn.addEventListener('click', () => {
      if (previewing && TTS.isSpeaking()) { TTS.stop(); settle(); return; }
      // in the voice's own language, or the sidecar gives an English
      // line to the English G2P and you'd hear accented English
      const engineKey = ttsEngineSelect ? ttsEngineSelect.value : '';
      const lang = langWithVoices(engineKey, ttsLangSelect ? ttsLangSelect.value : '');
      const line = (lang && PREVIEW_LINES[lang.id]) || `Hi ${Names.getPlayer()}, do you like this voice?`;
      const ok = TTS.speak(line, {
        onDone: settle,
        onError: settle,
      });
      if (!ok) { logAction('warn', 'voice preview: TTS is off or has no voice'); return; }
      previewing = true;
      previewBtn.textContent = 'Stop';
    });
  }
  if (ttsLangSelect) {
    ttsLangSelect.addEventListener('change', () => {
      TTS.setLang(ttsLangSelect.value);
      localStorage.setItem('tts.lang', ttsLangSelect.value);
      // Kokoro's voice menu follows the language
      const engineKey = ttsEngineSelect ? ttsEngineSelect.value : '';
      if (perLangVoices(engineKey)) {
        const def = populateVoices(engineKey, '', ttsLangSelect.value);
        localStorage.setItem('tts.voice', def);
      }
      Prefs.pushToServer();
    });
  }
  if (ttsSpeedInput) {
    ttsSpeedInput.addEventListener('input', updateTtsSpeedLabel);
    ttsSpeedInput.addEventListener('change', () => {
      const s = parseFloat(ttsSpeedInput.value) || 1.0;
      TTS.setSpeed(s);
      localStorage.setItem('tts.speed', String(s));
      Prefs.pushToServer();
    });
  }

}
