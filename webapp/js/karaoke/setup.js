import * as ui from '../core/ui.js?v=1';
import { assignOwners, buildSections, fetchLrclib, parseId3Lyrics, trackMeta } from './lyrics.js?v=1';
import { audioCtx, ensureCtx, renderLyrics, start } from './playback.js?v=2';
import { $, overlay } from './karaoke.js?v=2';
import { api, apiJson } from '../core/api.js?v=1';
import { idbStore } from '../core/idb.js?v=1';
import { escapeHtml } from '../core/util.js?v=1';

let healthCache = null;
export let track = null;
export let mode = 'solo';
let pendingLyrics = null;
let pendingId3 = null;
let pendingLrclib = null;
export let splitPicks = null;
let sepAbort = null;
let clockTimer = null, clockStartedAt = 0, clockEta = null;

export async function health() {
  if (healthCache) return healthCache;
  try {
    const r = await api('karaoke.php?action=health');
    if (!r.ok) throw new Error(`http ${r.status}`);
    healthCache = await r.json();
  } catch (e) {
    healthCache = { sep: false };
  }
  return healthCache;
}

const tracks = idbStore('omega-karaoke', 'tracks', 'hash');

async function sha256Hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function setStatus(msg) {
  const el = $('karaokeStatus');
  if (el) el.textContent = msg || '';
  const setupStatus = $('karaokeSetupStatus');
  if (setupStatus) setupStatus.textContent = msg || 'Preparing the stage…';
}

function setBusy(b) {
  const p = $('karaokeProgress');
  if (p) p.hidden = !b;
  const load = $('karaokeLoadBtn');
  if (load) load.disabled = b;
  const setup = $('karaokeSetup');
  if (setup) setup.setAttribute('aria-busy', b ? 'true' : 'false');
  // everything on the one setup screen locks while a song is
  // being separated, not just the button that started it
  document.querySelectorAll('.karaoke-mode-chip, #karaokeLyricsBtn, #karaokeLyricsAuto')
    .forEach(button => { button.disabled = b; });
  if (!b) stopClock();
}

function fmtClock(seconds) {
  const whole = Math.max(0, Math.round(seconds));
  return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
}

// a wide range on purpose, this is not a countdown. htdemucs (the
// thing that splits a song into vocals and backing) is slower
// than realtime on a CPU and way faster on a GPU. whisper then
// reads the vocal track back, and the very first run also has to
// download the model. so, you know. varies.
function estimateSeparation(duration, device) {
  if (!duration || (device !== 'cpu' && device !== 'cuda')) return null;
  return device === 'cpu' ? [duration * 1.2, duration * 2.6] : [duration * 0.15, duration * 0.5];
}

function fmtEta(eta) {
  const mins = (s) => Math.max(1, Math.round(s / 60));
  const low = mins(eta[0]), high = mins(eta[1]);
  return low === high ? `usually about ${low} min` : `usually ${low}-${high} min`;
}

function renderClock() {
  const el = $('karaokeProgressDetail');
  if (!el || !clockStartedAt) return;
  const elapsed = (Date.now() - clockStartedAt) / 1000;
  let text = fmtClock(elapsed) + ' elapsed';
  if (clockEta) {
    text += elapsed > clockEta[1] ? ' · longer than expected, still working' : ' · ' + fmtEta(clockEta);
  }
  el.textContent = text;
}

function startClock(eta) {
  clockStartedAt = Date.now();
  clockEta = eta || null;
  renderClock();
  if (!clockTimer) clockTimer = setInterval(renderClock, 1000);
}

function stopClock() {
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  clockStartedAt = 0;
  clockEta = null;
  const el = $('karaokeProgressDetail');
  if (el) el.textContent = '';
}

function setCancellable(fn) {
  const btn = $('karaokeCancelBtn');
  if (!btn) return;
  btn.hidden = !fn;
  btn.onclick = fn || null;
}

function setLyricsSrc(src) {
  const el = $('karaokeLyricsSrc');
  if (el) el.textContent = src ? `Lyrics: ${src}` : '';
}

function updateSetupSummary() {
  const el = $('karaokeSetupSummary');
  if (!el) return;
  const modes = {
    solo: 'Solo',
    duo: 'Sing together',
    split: 'Pick our lines',
  };
  el.textContent = `${modes[mode]} · ${pendingLyrics ? pendingLyrics.name : 'automatic lyrics'}`;
}

export function setLyricsChoice(choice) {
  const clear = $('karaokeLyricsAuto');
  const file = $('karaokeLyricsBtn');
  if (clear) clear.hidden = choice !== 'file';
  if (file) file.classList.toggle('selected', choice === 'file');
  if (choice === 'auto') {
    pendingLyrics = null;
    setLyricsSrc('');
  }
  updateSetupSummary();
}

export function queueLyrics(lyrics) {
  pendingLyrics = lyrics;
  setLyricsChoice('file');
  setLyricsSrc(`${lyrics.name} (queued)`);
}

export function platformFlavor() {
  const authTerm = $('authTerm');
  const forced = new URLSearchParams(location.search).get('os');
  let os = (forced === 'mac' || forced === 'windows' || forced === 'linux')
    ? forced
    : authTerm && authTerm.dataset.os;
  if (!os) {
    const platform = (navigator.userAgentData && navigator.userAgentData.platform)
      || navigator.platform || navigator.userAgent || '';
    const value = platform.toLowerCase();
    os = /mac|iphone|ipad|ipod/.test(value) ? 'mac' : /win/.test(value) ? 'windows' : 'linux';
  }
  const titles = {
    mac: ['jun - karaoke - 80×24', 'jun - karaoke/lines - 80×24'],
    windows: ['Windows PowerShell - karaoke', 'Windows PowerShell - karaoke\\lines'],
    linux: ['jun@junbuntu: ~/karaoke', 'jun@junbuntu: ~/karaoke/lines'],
  };
  const names = { mac: 'macOS', windows: 'Windows', linux: 'Linux' };
  document.querySelectorAll('.karaoke-menu').forEach((menu, index) => {
    menu.dataset.os = os;
    const title = menu.querySelector('.karaoke-term-title');
    const name = menu.querySelector('.karaoke-os-name');
    if (title) title.textContent = titles[os][Math.min(index, 1)];
    if (name) name.textContent = names[os];
  });
}

// decodeAudioData DETACHES the ArrayBuffer you hand it, so decode
// a copy and keep the original bytes for IndexedDB. AudioBuffer
// itself isn't storable.
async function decodeCopy(raw) {
  return audioCtx.decodeAudioData(raw.slice(0));
}

async function fetchStem(which, token) {
  const r = await apiJson('karaoke.php?action=stem', { token, which });
  if (!r.ok) throw new Error(`stem ${which} http ${r.status}`);
  return r.arrayBuffer();
}

export async function loadFile(file) {
  ensureCtx();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  setBusy(true);
  try {
    const raw = await file.arrayBuffer();
    const hash = await sha256Hex(raw);
    pendingId3 = parseId3Lyrics(raw);
    pendingLrclib = null;
    const meta = trackMeta(raw, file.name);

    let rec = await tracks.get(hash);
    if (!rec) {
      const h = await health();
      let sourceDuration = 0;
      try {
        setStatus('Reading the track…');
        sourceDuration = (await decodeCopy(raw)).duration;
      } catch (e) {
        // only needed for the estimate, separation reports a bad file
        // properly
      }
      setStatus(h.device === 'cpu'
        ? 'Splitting the vocals off on CPU…'
        : 'Splitting the vocals off…');
      startClock(estimateSeparation(sourceDuration, h.device));
      // aborting only stops US waiting. the sidecar carries right
      // on to the end of the job it started, there's no cancel on
      // the demucs side.
      sepAbort = new AbortController();
      setCancellable(() => sepAbort && sepAbort.abort());
      let sepRes;
      try {
        sepRes = await api('karaoke.php?action=separate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: raw,
          signal: sepAbort.signal,
        });
      } finally {
        setCancellable(null);
        sepAbort = null;
      }
      if (!sepRes.ok) throw new Error(`separate http ${sepRes.status}`);
      const meta = await sepRes.json();
      setStatus('Fetching the stems…');
      startClock(null);
      const [instrumental, guide] = await Promise.all([
        fetchStem('instrumental', meta.token),
        fetchStem('guide', meta.token),
      ]);
      rec = { hash, instrumental, guide, lyrics: meta.lyrics || [], duration: meta.duration || 0 };
      await tracks.put(rec);
    } else {
      setStatus('Already split - loading from cache…');
    }
    stopClock();

    const [instrBuf, guideBuf] = await Promise.all([decodeCopy(rec.instrumental), decodeCopy(rec.guide)]);
    const duration = rec.duration || Math.max(instrBuf.duration, guideBuf.duration);

    if (!pendingLyrics) {
      setStatus('Looking up lyrics…');
      pendingLrclib = await fetchLrclib(meta, duration);
    }

    const built = buildSections(rec.lyrics || [], duration, { pendingLyrics, pendingLrclib, pendingId3 });
    track = { hash, duration, instrBuf, guideBuf, sections: built.sections, lyricsSrc: built.src, meta };
    setLyricsSrc(built.src);
    setStatus('');

    if (mode === 'split') {
      showAssign();
    } else {
      assignOwners(track.sections, mode);
      renderLyrics();
      showStage(true);
      start();
    }
  } catch (e) {
    setStatus('');
    if (e.name === 'AbortError') {
      ui.toast('Stopped waiting on the split', 'info');
    } else {
      console.error(e);
      ui.toast('⚠ Karaoke failed: ' + e.message, 'error');
    }
  } finally {
    setCancellable(null);
    sepAbort = null;
    setBusy(false);
  }
}

function showAssign() {
  const panel = $('karaokeAssign'), list = $('karaokeAssignList');
  if (!panel || !list) return;
  splitPicks = track.sections.map((s, i) => (i % 2 === 0 ? 'you' : 'jun'));
  list.innerHTML = track.sections.map((sec, i) => {
    const preview = escapeHtml(sec.words.map(w => w.word).join(' ').slice(0, 64));
    return `<div class="karaoke-assign-row">
      <span class="karaoke-assign-preview">${preview}</span>
      <span class="karaoke-assign-toggle">
        <button type="button" data-i="${i}" data-owner="you" class="${splitPicks[i] === 'you' ? 'selected' : ''}">You</button>
        <button type="button" data-i="${i}" data-owner="jun" class="${splitPicks[i] === 'jun' ? 'selected' : ''}">Jun</button>
      </span></div>`;
  }).join('');
  list.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.i;
    splitPicks[i] = b.dataset.owner;
    b.parentElement.querySelectorAll('button').forEach(x => x.classList.toggle('selected', x.dataset.owner === b.dataset.owner));
  }));
  const setup = $('karaokeSetup');
  if (setup) setup.hidden = true;
  panel.hidden = false;
  const ov = overlay();
  if (ov) ov.dataset.view = 'assign';
}

export function showStage(on) {
  const setup = $('karaokeSetup'), assign = $('karaokeAssign'), stage = $('karaokeStage');
  if (setup) setup.hidden = on;
  if (assign) assign.hidden = on;
  if (stage) stage.hidden = !on;
  const ov = overlay();
  if (ov && on) ov.dataset.view = 'stage';
  const score = $('karaokeScore');
  if (score) score.hidden = true;
}

export function resetPanels() {
  const setup = $('karaokeSetup'), assign = $('karaokeAssign'), stage = $('karaokeStage'), score = $('karaokeScore');
  if (setup) setup.hidden = false;
  if (assign) assign.hidden = true;
  if (stage) stage.hidden = true;
  if (score) score.hidden = true;
  const ov = overlay();
  if (ov) ov.dataset.view = 'setup';
  track = null;
  pendingLyrics = null;
  pendingId3 = null;
  pendingLrclib = null;
  setStatus('');
  setBusy(false);
  setLyricsChoice('auto');
}

export function setMode(m) {
  if (!['solo', 'duo', 'split'].includes(m)) return;
  mode = m;
  const sel = $('karaokeModeSel');
  if (sel) sel.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('selected', b.dataset.mode === m));
  const desc = $('karaokeModeDesc');
  if (desc) desc.textContent =
    m === 'duo' ? 'Sing the whole song together.' :
    m === 'split' ? 'Assign each line to you or Jun after the song loads.' :
    'You sing the full song first, then Jun takes a solo turn.';
  updateSetupSummary();
}
