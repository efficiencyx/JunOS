(async () => {
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
    const width = Math.max(14, Math.min(34, anchor.modelH * .038));
    const top = anchor.mouth.y - width * .4;
    const floor = bounds.top + bounds.height * .9;
    mic.hidden = top < bounds.top || top > floor - width * 2
      || anchor.mouth.x < bounds.left || anchor.mouth.x > bounds.right;
    mic.style.left = (anchor.mouth.x + width * .15) + 'px';
    mic.style.top = top + 'px';
    mic.style.width = width + 'px';
    mic.style.height = (floor - top) + 'px';
    mic.style.setProperty('--mic-head', (width * 1.2) + 'px');
  }

  document.addEventListener('visibilitychange', () => {
    cancelAnimationFrame(micFrame);
    if (!document.hidden && window.Live2D) positionMic();
  });
  window.addEventListener('pagehide', () => cancelAnimationFrame(micFrame));
  const me = await Auth.me().catch(() => null);
  if (!me) {
    location.replace('index.html');
    return;
  }
  // same rule as wardrobe.js: she agreed, or the gate is off
  const trip = await fetch('api/trip.php', { credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : null).catch(() => null);
  if (trip && trip.gated && trip.where !== 'karaoke') {
    location.replace('index.html');
    return;
  }
  // mount AFTER the gate, same reason as date.js
  TripLoader.mount();
  TripLoader.setStage('Walking to the lounge');

  if (window.Prefs) await Prefs.pullFromServer();
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
      if (window.Prefs) Prefs.pushToServer();
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
})();
