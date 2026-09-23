import * as Live2D from '../live2d/live2d.js?v=4';
import * as ui from '../core/ui.js?v=1';
import { assignOwners } from './lyrics.js?v=1';
import { health, loadFile, mode, platformFlavor, queueLyrics, resetPanels, setLyricsChoice, setMode, showStage, splitPicks, track } from './setup.js?v=2';
import { renderLyrics, setJunVolume, start, stopPlayback } from './playback.js?v=2';

export { setVolume } from './playback.js?v=2';

export let active = false;
export let hooks = {};
export const $ = (id) => document.getElementById(id);
export const overlay = () => $('karaokeOverlay');

export function isActive() { return active; }

function focusPanel() {
  const ov = overlay();
  if (!ov) return;
  const panel = [...ov.children].find(el => !el.hidden && el.querySelector('button, [href], input'));
  const target = panel && panel.querySelector('button:not([hidden]), [href], input:not([hidden])');
  (target || ov.querySelector('#karaokeOverlayClose'))?.focus();
}

export async function enter() {
  if (active) return true;
  const h = await health();
  if (!h.sep) {
    ui.toast('⚠ Karaoke unavailable: stem separation is not running', 'error');
    return false;
  }
  active = true;
  const ov = overlay();
  if (ov) { ov.hidden = false; void ov.offsetHeight; }
  document.body.classList.add('karaoke-mode');
  resetPanels();
  focusPanel();
  const hint = $('karaokeDeviceHint');
  if (hint) hint.textContent = h.device === 'cpu' ? 'CPU - separation is slow' : 'GPU ⚡';
  Live2D.setCameraPreset(hooks.cameraPreset || 'face');
  if (hooks.onEnter) hooks.onEnter();
  return true;
}

export function exit() {
  if (!active) return;
  active = false;
  stopPlayback();
  document.body.classList.remove('karaoke-mode');
  const ov = overlay();
  if (ov) setTimeout(() => { if (!active) ov.hidden = true; }, 300);
  Live2D.setCameraPreset('default');
  if (hooks.onExit) hooks.onExit();
}

export function init(h) {
  hooks = { ...hooks, ...(h || {}) };
  platformFlavor();
  const close = $('karaokeOverlayClose');
  if (close) close.addEventListener('click', exit);

  const sel = $('karaokeModeSel');
  if (sel) sel.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  setMode(mode);

  const lyricsAuto = $('karaokeLyricsAuto');
  if (lyricsAuto) lyricsAuto.addEventListener('click', () => setLyricsChoice('auto'));

  const load = $('karaokeLoadBtn');
  const input = $('karaokeFileInput');
  if (load && input) {
    load.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const f = input.files[0];
      input.value = '';
      if (f) loadFile(f);
    });
  }

  const lyBtn = $('karaokeLyricsBtn');
  const lyInput = $('karaokeLyricsInput');
  if (lyBtn && lyInput) {
    lyBtn.addEventListener('click', () => lyInput.click());
    lyInput.addEventListener('change', async () => {
      const f = lyInput.files[0];
      lyInput.value = '';
      if (!f) return;
      const kind = /\.lrc$/i.test(f.name) ? 'lrc' : 'txt';
      queueLyrics({ text: await f.text(), kind, name: f.name });
    });
  }

  const assignStart = $('karaokeAssignStart');
  if (assignStart) assignStart.addEventListener('click', () => {
    if (!track) return;
    assignOwners(track.sections, 'split', splitPicks);
    renderLyrics();
    showStage(true);
    start();
  });

  const stop = $('karaokeStopBtn');
  if (stop) stop.addEventListener('click', stopPlayback);
  const restart = $('karaokeRestartBtn');
  if (restart) restart.addEventListener('click', () => { showStage(true); start(); });
  const gv = $('karaokeGuideVol');
  if (gv) gv.addEventListener('input', () => setJunVolume(parseFloat(gv.value)));
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && active) exit(); });
}
