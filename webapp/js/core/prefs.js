import { apiGet, apiJson } from './api.js?v=1';

// Turning the mic on is Never synced across sessions, on purpose.

export const TRACKED = [
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
  'voice.hear_all',
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

export async function pullFromServer() {
  try {
    const data = await apiGet('prefs.php');
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
    await apiJson('prefs.php', data, { method: 'PUT' });
  } catch (e) {
  }
}

export const pushToServer = debounce(pushNow, 500);

window.addEventListener('pagehide', () => { pushNow(); });
window.addEventListener('online', () => { pushNow(); });

export function clearLocal() {
  for (const k of TRACKED) localStorage.removeItem(k);
}
