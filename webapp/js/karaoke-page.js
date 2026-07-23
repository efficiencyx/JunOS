(async () => {
  const status = document.getElementById('karaokePageStatus');
  const backLink = document.getElementById('karaokeBackLink');
  const me = await Auth.me().catch(() => null);
  if (!me) {
    location.replace('index.html');
    return;
  }

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
    onExit: () => { location.href = 'index.html'; },
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
      onStatus: (message) => { status.textContent = message; },
      ignoreSavedPos: true,
    });
    Outfit.load();
    Outfit.applyAll();
    Live2D.startIdle();
    status.textContent = 'Ready';
  } catch (error) {
    console.error(error);
    status.textContent = 'Jun could not load: ' + error.message;
  }

  const entered = await Karaoke.enter();
  if (!entered) {
    status.textContent = 'Karaoke is unavailable because source separation is not running.';
  }
})();
