// Microphone activation is intentionally not synced across sessions.

window.Prefs = (function () {
  const TRACKED = [
    'omega.outfit.v1',
    'omega.outfit.colors.v1',
    'omega.names.player',
    'omega.names.bot',
    'tts.enabled',
    'tts.engine',
    'tts.voice',
    'tts.lang',
    'tts.speed',
    'audio.volume',
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
    }
  }

  const pushToServer = debounce(pushNow, 500);

  window.addEventListener('pagehide', () => { pushNow(); });
  window.addEventListener('online', () => { pushNow(); });

  function clearLocal() {
    for (const k of TRACKED) localStorage.removeItem(k);
  }

  return { TRACKED, pullFromServer, pushToServer, clearLocal };
})();
