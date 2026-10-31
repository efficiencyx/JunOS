// date.js skeleton on a clock. grab.js hands over frames + audio
// every 20 s played, she talks or calls stay_silent. one request at
// a time, a window due while she's busy just drops, a newer one's coming

import * as Auth from './core/auth.js?v=1';
import { api, apiJson } from './core/api.js?v=1';
import * as ChatAPI from './core/chat-api.js?v=7';
import * as Names from './core/names.js?v=1';
import * as Prefs from './core/prefs.js?v=6';
import { say } from './core/speech-card.js?v=17';
import { localTimeString } from './core/util.js?v=1';
import * as Live2D from './live2d/live2d.js?v=89';
import * as Outfit from './outfit/outfit.js?v=93';
import * as Scene from './trip/scene.js?v=1';
import * as TripLoader from './trip/trip-loader.js?v=1';
import { startCapture } from './watch/grab.js?v=2';

const OOC = '(OOC stage direction, not spoken by Anon: ';
const HISTORY_KEPT = 16;
const TRAIL_KEPT = 6;
const HEARD_KEPT = 300;
// whisper on music and credits. it's always one of these
const STT_JUNK = /^\W*(?:thanks? (?:you )?for watching|please subscribe|subscribe|you|bye)?\W*$/i;

async function main() {
  const status = document.getElementById('stageStatus');
  const video = document.getElementById('player');
  const picker = document.getElementById('picker');
  const fileInput = document.getElementById('fileInput');
  const fileBtn = document.getElementById('fileBtn');
  const tabBtn = document.getElementById('tabBtn');
  const input = document.getElementById('sayInput');
  const sendBtn = document.getElementById('sendBtn');
  const homeBtn = document.getElementById('homeBtn');
  const lastLine = document.getElementById('lastLine');

  let conversationId = 0;
  let history = [];
  const table = [];
  let ready = false;
  let leaving = false;
  let streaming = null;
  let speaking = false;
  let sees = true;
  let hears = true;
  let sttUp = null;
  let src = null;
  let cap = null;
  let frameEvery = 5;
  // windows she didn't answer. they ride along until she does
  let pending = [];

  const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const position = () => src.stream ? Math.round(cap.seconds()) : Math.round(video.currentTime);
  const length = () => src.stream || !isFinite(video.duration) ? 0 : Math.round(video.duration);

  function setComposer() {
    input.disabled = !ready;
    sendBtn.disabled = !ready || !src || !!leaving;
    homeBtn.disabled = !ready || !!leaving;
  }

  async function transcribe(wav) {
    if (sttUp === null) {
      sttUp = await api('stt.php?action=health').then(r => r.ok ? r.json() : null)
        .then(h => !!(h && h.stt)).catch(() => false);
    }
    if (!sttUp) return '';
    const text = await api('stt.php?action=stt', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav })
      .then(r => r.ok ? r.json() : null).then(d => (d && d.text || '').trim()).catch(() => '');
    return STT_JUNK.test(text) ? '' : text;
  }

  function stretchOf(win) {
    const s = { from: win.from, to: win.to, heard: '', done: Promise.resolve() };
    if (win.wav) s.done = transcribe(win.wav).then((t) => { s.heard = t; });
    return s;
  }

  const stretchLine = (s) => `${clock(s.from)} to ${clock(s.to)}`
    + (s.heard ? `, said in it: "${s.heard.slice(0, HEARD_KEPT)}"` : '');

  function hold(s) {
    pending.push(s);
    if (pending.length > TRAIL_KEPT) pending.shift();
  }

  // resolves { text, silent, error, aborted }. never throws
  function send(body, kind) {
    return new Promise((resolve) => {
      let text = '';
      let silent = false;
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; streaming = null; resolve(r); } };
      const abort = ChatAPI.chat(body, {
        onToken: (t) => { text += t; if (streaming) streaming.started = true; },
        onRestart: () => { text = ''; },
        onSilence: () => { silent = true; },
        onDone: () => done({ text, silent }),
        onError: (err) => done({ text, silent, error: err.message }),
      });
      streaming = { kind, started: false, abort: () => { abort(); done({ aborted: true }); } };
    });
  }

  async function turn(kind, content, win = null) {
    if (!conversationId) return '';
    const stretch = win ? stretchOf(win) : null;
    const earlier = stretch ? pending.slice() : [];
    const watch = {
      turn: kind, source: src.kind, title: src.title,
      at: position(), length: length(), paused: !src.stream && video.paused,
      earlier: earlier.map(stretchLine).join(' / '),
    };
    let frames = sees && win ? win.frames : [];
    let audio = '';
    if (win && win.wav) {
      if (hears) audio = win.wavB64;
      else { await stretch.done; watch.heard = stretch.heard; }
    }
    const entry = { role: 'user', content };
    history.push(entry);
    let res;
    for (let tries = 0; tries < 3; tries++) {
      res = await send({
        messages: history.slice(-HISTORY_KEPT), conversation_id: conversationId, ephemeral: true,
        client_time: localTimeString(), outfit_context: Outfit.describe(),
        frames: frames.length ? frames : undefined, audio: audio || undefined,
        watch: { ...watch, frames_at: frames.length ? win.stamps : undefined },
      }, kind);
      if (res.error === 'vision_unsupported') { sees = false; frames = []; continue; }
      if (res.error === 'audio_unsupported') {
        hears = false;
        audio = '';
        if (win && win.wav) { await stretch.done; watch.heard = stretch.heard; }
        continue;
      }
      break;
    }
    const line = (res.text || '').replace(/\[\s*A(?:CTIONS?)?\s*:[^\]]*\]/gi, '').replace(/\s+/g, ' ').trim();
    const quiet = res.aborted || res.error || res.silent || /^[\s.…*]*$/.test(line);
    if (stretch && quiet && kind === 'tick') {
      const i = history.indexOf(entry);
      if (i >= 0) history.splice(i, 1);
      hold(stretch);
    } else if (stretch) {
      // the frames and the recording are gone after this turn, the
      // text trail is all she keeps of these 20 s
      const trail = [...earlier, stretch];
      pending = pending.filter(s => !earlier.includes(s));
      const write = () => {
        const note = `${OOC}${trail.map(stretchLine).join(', then ')} played.)`;
        entry.content = kind === 'talk' ? `${note}\n\n${content}` : note;
      };
      write();
      stretch.done.then(write);
    }
    if (quiet) {
      if (kind !== 'tick') history.push({ role: 'assistant', content: '...' });
      if (res.error && kind !== 'tick') status.textContent = "She didn't catch that.";
      return '';
    }
    history.push({ role: 'assistant', content: res.text });
    table.push({ role: 'assistant', text: line });
    return Names.apply(line);
  }

  async function speak(line) {
    if (!line) return;
    lastLine.textContent = line;
    speaking = true;
    if (cap) cap.duck(0.3);
    await say(line);
    if (cap) cap.duck(1);
    speaking = false;
  }

  async function onWindow(win) {
    if (leaving) return;
    if (streaming || speaking || document.hidden) { hold(stretchOf(win)); return; }
    const note = `${OOC}${clock(win.from)} to ${clock(win.to)} played.)`;
    speak(await turn('tick', note, win));
  }

  async function begin(next) {
    src = next;
    picker.hidden = true;
    document.body.classList.add('watching');
    cap = startCapture(video, { stream: src.stream, frameEvery, onWindow });
    setComposer();
    cap.hasAudio.then((ok) => {
      if (!ok && src.stream) lastLine.textContent = 'No sound came with it. Only Chrome tabs share sound.';
    });
    speak(await turn('start', `${OOC}you two sit down to watch it.)`));
  }

  function reset() {
    if (cap) cap.stop();
    cap = null;
    src = null;
    pending = [];
    video.removeAttribute('src');
    video.srcObject = null;
    video.load();
    picker.hidden = false;
    document.body.classList.remove('watching');
    setComposer();
  }

  fileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (src) reset();
    video.muted = false;
    video.src = URL.createObjectURL(file);
    video.play().catch(() => {});
    begin({ kind: 'file', title: file.name.replace(/\.[^.]+$/, ''), stream: null });
  });

  // a phone browser has no getDisplayMedia, and plain-http LAN has
  // no secure context
  tabBtn.hidden = !(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia
    && !matchMedia('(pointer: coarse)').matches);
  tabBtn.addEventListener('click', async () => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 5 }, audio: true,
        selfBrowserSurface: 'exclude', systemAudio: 'exclude', surfaceSwitching: 'include',
      });
    } catch (e) {
      return;
    }
    if (src) reset();
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings ? track.getSettings() : {};
    track.addEventListener('ended', () => { if (src && src.stream === stream && !leaving) reset(); });
    video.muted = true;
    video.srcObject = stream;
    video.play().catch(() => {});
    begin({
      kind: settings.displaySurface === 'browser' ? 'tab' : 'screen',
      title: /:\/\//.test(track.label) ? '' : track.label.slice(0, 120),
      stream,
    });
  });

  document.getElementById('composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !ready || !src || leaving) return;
    if (streaming) {
      if (streaming.kind !== 'tick' || streaming.started) return;
      streaming.abort();
    }
    input.value = '';
    const spoken = Names.canonicalize(text);
    table.push({ role: 'user', text: spoken });
    const win = await cap.snapshot();
    speak(await turn('talk', spoken, win));
    input.focus();
  });

  homeBtn.addEventListener('click', async () => {
    if (leaving) return;
    leaving = true;
    setComposer();
    if (streaming) streaming.abort();
    const minutes = cap ? Math.round(cap.seconds() / 60) : 0;
    const title = src ? src.title : '';
    if (src) {
      video.pause();
      const line = await turn('end', `${OOC}you two get up from the couch.)`);
      const home = apiJson('trip.php?action=home', {
        title, minutes,
        table: table.slice(-30).map(r => ({ role: r.role, text: r.text.slice(0, 300) })),
      }).catch(() => null);
      await speak(line);
      await home;
    } else {
      await apiJson('trip.php?action=home', {}).catch(() => null);
    }
    if (cap) cap.stop();
    location.href = 'index.html?from=watch';
  });

  const me = await Auth.me().catch(() => null);
  if (!me) { location.replace('index.html'); return; }
  const trip = await api('trip.php').then(r => r.ok ? r.json() : null).catch(() => null);
  if (trip && trip.gated && trip.where !== 'watch') { location.replace('index.html'); return; }
  TripLoader.mount();
  TripLoader.setStage('Grabbing the remote');
  Scene.inject('.room', 'scene/lounge.svg?v=4');
  conversationId = trip ? Number(trip.conversation_id) || 0 : 0;
  frameEvery = trip && trip.frame_every || 5;
  if (!conversationId) {
    const list = await api('conversations.php?action=list').then(r => r.ok ? r.json() : []).catch(() => []);
    conversationId = list.length ? Number(list[0].id) : 0;
  }

  await Prefs.pullFromServer();
  Names.load();
  Names.decorate();

  if (conversationId) {
    try {
      const rows = await api(`conversations.php?action=messages&id=${conversationId}`).then(r => r.ok ? r.json() : []);
      history = rows.filter(r => r.content !== '<audio>').slice(-6).map(r => ({ role: r.role, content: r.content }));
    } catch (e) {}
  }

  try {
    await Live2D.init({
      stageEl: document.getElementById('stage'),
      onStatus: (s) => {
        status.textContent = s;
        TripLoader.setStage(s);
      },
      ignoreSavedPos: true,
    });
    await Outfit.load();
    Outfit.applyAll();
    Live2D.startIdle();
    Live2D.setCameraPreset('face');
    await TripLoader.finish();
    status.textContent = '';
    ready = true;
    setComposer();
  } catch (e) {
    console.error(e);
    status.textContent = 'Load error: ' + e.message;
    TripLoader.fail('Load error: ' + e.message);
  }
}

main();
