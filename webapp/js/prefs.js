// Per-account preference sync. localStorage stays the source of truth at read
// time (so the UI is instant and works offline); we mirror tracked keys to the
// server on change so a second browser sees the same outfit / colors / TTS.
//
// Reserved keys:
//   omega.outfit.v1, omega.outfit.colors.v1, omega.names.player, omega.names.bot,
//   tts.enabled, tts.engine, tts.voice, tts.speed, model, reasoning_level, think,
//   voice.bargein, voice.silence_ms
// Future: theme.
//
// Note there's no `voice.enabled`: a live microphone is a per-session decision,
// not something a synced pref should switch on in another browser.

window.Prefs = (function () {
  const TRACKED = [
    'omega.outfit.v1',
    'omega.outfit.colors.v1',
    'omega.names.player',
    'omega.names.bot',
    'tts.enabled',
    'tts.engine',
    'tts.voice',
    'tts.speed',
    'voice.bargein',
    'voice.silence_ms',
    'model',
    'reasoning_level',
    'think',
  ];

  function debounce(fn, ms) {
    let t = null;
    return function () {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; fn(); }, ms);
    };
  }

  async function pullFromServer() {
    try {
      const r = await fetch('/api/prefs.php', { credentials: 'same-origin' });
      if (!r.ok) return;
      const data = await r.json();
      if (!data || typeof data !== 'object') return;
      for (const k of TRACKED) {
        if (Object.prototype.hasOwnProperty.call(data, k) && typeof data[k] === 'string') {
          localStorage.setItem(k, data[k]);
        }
      }
    } catch (e) {
      // Network/offline: keep whatever's in localStorage and move on.
    }
  }

  async function pushNow() {
    const data = {};
    for (const k of TRACKED) {
      const v = localStorage.getItem(k);
      if (v !== null) data[k] = v;
    }
    try {
      await fetch('/api/prefs.php', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
      });
    } catch (e) {
      // Drop silently; the next change (or the `online` listener below) retries.
    }
  }

  // Coalesce bursts of saves (e.g. dragging the color picker) into one PUT.
  const pushToServer = debounce(pushNow, 500);

  // Flush pending writes if the user closes / navigates away.
  window.addEventListener('pagehide', () => { pushNow(); });
  window.addEventListener('online', () => { pushNow(); });

  function clearLocal() {
    for (const k of TRACKED) localStorage.removeItem(k);
  }

  return { TRACKED, pullFromServer, pushToServer, clearLocal };
})();
