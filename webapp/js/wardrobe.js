(async () => {
  const status = document.getElementById('stageStatus');
  try {
    await Live2D.init({
      stageEl: document.getElementById('stage'),
      onStatus: (s) => { status.textContent = s; },
      ignoreSavedPos: true,
    });
    Outfit.load();
    Outfit.applyAll();
    Live2D.startIdle();
    Outfit.openWardrobe();
    status.textContent = 'Shift+wheel to zoom · drag items onto Jun to dress her';
  } catch (e) {
    console.error(e);
    status.textContent = 'Load error: ' + e.message;
  }
})();
