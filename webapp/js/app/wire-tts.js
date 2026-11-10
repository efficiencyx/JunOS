import { IDLE_AFTER_REPLY_MS, scheduleIdleNudge } from './consolidation.js?v=125';
import { ttsChk, ttsEngineSelect, ttsLangRow, ttsLangSelect, ttsSpeedInput, ttsVoiceSelect } from './dom.js?v=77';
import { finishPendingFaceBubbleHide } from './face-bubble.js?v=93';
import { logAction } from './logging.js?v=78';
import { syncVoiceDeps, updateTtsSpeedLabel } from './settings.js?v=130';
import { escapeHtml } from '../core/util.js?v=1';
import * as Names from '../core/names.js?v=1';
import * as Prefs from '../core/prefs.js?v=8';
import * as TTS from '../voice/tts.js?v=92';
import { previewLine } from '../voice/languages.js?v=1';

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
  // Kokoro only, {english: 'af_heart', ...}. tts.voice stays the English one
  let langVoices = {};
  try { langVoices = JSON.parse(localStorage.getItem('tts.voices') || '{}') || {}; } catch { langVoices = {}; }
  TTS.setSpeed(savedSpeed);
  if (ttsSpeedInput) ttsSpeedInput.value = String(savedSpeed);
  updateTtsSpeedLabel();

  let engines = {};
  const engineLangs = (engineKey) => (engines[engineKey] && engines[engineKey].languages) || [];
  const perLangVoices = (engineKey) => engineLangs(engineKey).some(l => Array.isArray(l.voices));
  // the language whose voices the menu shows. auto shows the default one
  function shownLang(engineKey, langId) {
    if (!perLangVoices(engineKey)) return null;
    const langs = engineLangs(engineKey);
    return langs.find(l => l.id === langId)
      || langs.find(l => l.id === engines[engineKey].default_language) || langs[0];
  }
  const mainVoice = (engineKey) => langVoices[engines[engineKey].default_language] || '';

  // a saved tts.voice from before per-language voices seeds the default
  // language, or every upgrade lands back on af_heart
  function syncLangVoices(engineKey, oldVoice) {
    if (!perLangVoices(engineKey)) { TTS.setLangVoices({}); return; }
    const main = engines[engineKey].default_language;
    if (!langVoices[main] && oldVoice) langVoices[main] = oldVoice;
    for (const l of engineLangs(engineKey)) {
      if (!l.voices.includes(langVoices[l.id])) langVoices[l.id] = l.default || l.voices[0] || '';
    }
    TTS.setLangVoices(langVoices);
  }

  function populateVoices(engineKey, preferred, langId) {
    const info = engines[engineKey] || { voices: [], default: '' };
    const lang = shownLang(engineKey, langId);
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
    const main = lang ? mainVoice(engineKey) || def : def;
    TTS.setVoice(main);
    return main;
  }

  // the row stays hidden for engines that don't hand us a `languages` list
  function populateLanguages(engineKey, preferred) {
    const baseLangs = engineLangs(engineKey);
    if (ttsLangRow) ttsLangRow.hidden = baseLangs.length === 0;
    if (!baseLangs.length) { TTS.setLang('english'); return ''; }
    // 'auto' is a fake language that only exists in the client.
    // TTS works out each reply's language and sends a real id. it's
    // the default so this just works with zero setup.
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
    syncLangVoices(engineKey, savedVoice);
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
      syncLangVoices(engineKey, '');
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
      const engineKey = ttsEngineSelect ? ttsEngineSelect.value : '';
      const lang = shownLang(engineKey, ttsLangSelect ? ttsLangSelect.value : '');
      if (lang) {
        langVoices[lang.id] = ttsVoiceSelect.value;
        TTS.setLangVoices(langVoices);
        localStorage.setItem('tts.voices', JSON.stringify(langVoices));
      }
      const main = lang ? mainVoice(engineKey) : ttsVoiceSelect.value;
      TTS.setVoice(main);
      localStorage.setItem('tts.voice', main);
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
      const engineKey = ttsEngineSelect ? ttsEngineSelect.value : '';
      const picked = ttsLangSelect && !ttsLangRow?.hidden ? ttsLangSelect.value : '';
      const lang = shownLang(engineKey, picked);
      const ok = TTS.speak(previewLine(lang ? lang.id : picked, Names.getPlayer()), {
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
