import * as Auth from './core/auth.js?v=1';
import { api } from './core/api.js?v=1';
import * as Prefs from './core/prefs.js?v=1';
import * as Karaoke from './karaoke/karaoke.js?v=2';
import * as Live2D from './live2d/live2d.js?v=4';
import * as Outfit from './outfit/outfit.js?v=3';
import * as Scene from './trip/scene.js?v=1';
import { startSkybox } from './trip/skybox.js?v=1';
import * as TripLoader from './trip/trip-loader.js?v=1';

async function main() {
  startSkybox();
  const status = document.getElementById('karaokePageStatus');
  const backLink = document.getElementById('karaokeBackLink');
  const room = document.querySelector('.music-room');
  const mic = document.getElementById('karaokeMic');
  const badge = document.getElementById('karaokeRoomBadge');
  let micFrame = 0;

  function positionMic() {
    micFrame = requestAnimationFrame(positionMic);
    const anchor = Live2D.faceAnchor();
    if (!anchor || !anchor.mouth) return;
    const bounds = room.getBoundingClientRect();
    const height = anchor.modelH * .24;
    const width = height * 120 / 260;
    const floor = bounds.top + bounds.height * .9;
    mic.hidden = anchor.mouth.x < bounds.left || anchor.mouth.x > bounds.right;
    mic.style.left = (anchor.mouth.x - width / 2) + 'px';
    mic.style.top = (floor - height) + 'px';
    mic.style.width = width + 'px';
    mic.style.height = height + 'px';
  }

  document.addEventListener('visibilitychange', () => {
    cancelAnimationFrame(micFrame);
    if (!document.hidden) positionMic();
  });
  window.addEventListener('pagehide', () => cancelAnimationFrame(micFrame));
  const me = await Auth.me().catch(() => null);
  if (!me) {
    location.replace('index.html');
    return;
  }
  // same rule as wardrobe.js: she agreed, or the gate is off
  const trip = await api('trip.php')
    .then(r => r.ok ? r.json() : null).catch(() => null);
  if (trip && trip.gated && trip.where !== 'karaoke') {
    location.replace('index.html');
    return;
  }
  // mount AFTER the gate, same as date.js. otherwise a bounced user
  // sits through the whole walk just to get redirected at the end
  TripLoader.mount();
  TripLoader.setStage('Walking to the lounge');
  Scene.inject('.music-room', 'scene/lounge.svg?v=4');
  Scene.inject('.music-room-front', 'scene/lounge-front.svg?v=2');
  Scene.inject('#karaokeMic', 'scene/props/desk-mic.svg?v=1');

  await Prefs.pullFromServer();
  const storedVolume = parseFloat(localStorage.getItem('audio.volume') || '1');
  const volume = Math.max(0, Math.min(1, Number.isFinite(storedVolume) ? storedVolume : 1));
  Karaoke.setVolume(volume);

  const masterVolume = document.getElementById('karaokeMasterVol');
  if (masterVolume) {
    masterVolume.value = String(volume);
    masterVolume.addEventListener('input', () => {
      const next = parseFloat(masterVolume.value);
      Karaoke.setVolume(next);
      localStorage.setItem('audio.volume', String(next));
    });
    masterVolume.addEventListener('change', () => {
      Prefs.pushToServer();
    });
  }

  Karaoke.init({
    cameraPreset: 'default',
    onEnter: () => { badge.textContent = 'Ready for your song'; },
    onPlaybackChange: (playing) => {
      document.body.classList.toggle('is-singing', playing);
      badge.textContent = playing ? 'On air · Just us two' : 'Between songs';
    },
    onLevel: (level) => { room.style.setProperty('--vocal-level', String(Math.min(1, level * 5))); },
    onExit: () => { location.href = 'index.html?from=karaoke'; },
  });
  if (backLink) {
    backLink.addEventListener('click', (event) => {
      if (!Karaoke.isActive()) return;
      event.preventDefault();
      Karaoke.exit();
    });
  }

  try {
    await Live2D.init({
      stageEl: document.getElementById('stage'),
      onStatus: (message) => {
        status.textContent = message;
        TripLoader.setStage(message);
      },
      ignoreSavedPos: true,
    });
    await Outfit.load();
    Outfit.applyAll();
    Live2D.startIdle();
    cancelAnimationFrame(micFrame);
    positionMic();
    status.textContent = 'Ready';
  } catch (error) {
    console.error(error);
    status.textContent = 'Jun could not load: ' + error.message;
  }

  const entered = await Karaoke.enter();
  if (!entered) {
    badge.textContent = 'Taking a break';
    status.textContent = 'Karaoke is unavailable because source separation is not running.';
  }
  TripLoader.setStage(entered ? 'Welcome to the lounge' : 'The lounge is closed tonight');
  await TripLoader.finish();
}

main();
