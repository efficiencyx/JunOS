(async () => {
  const status = document.getElementById('stageStatus');
  TripLoader.mount();

  try {
    await Live2D.init({
      stageEl: document.getElementById('stage'),
      onStatus: (s) => {
        status.textContent = s;
        TripLoader.setStage(s);
      },
      ignoreSavedPos: true,
    });
    Outfit.load();
    Outfit.applyAll();
    Live2D.startIdle();
    await Outfit.openWardrobe();
    status.textContent = 'Shift+wheel to zoom · drag items onto Jun to dress her';
    TripLoader.setStage("Welcome to Annalie's");
    await TripLoader.finish();
  } catch (e) {
    console.error(e);
    status.textContent = 'Load error: ' + e.message;
    TripLoader.fail('Load error: ' + e.message);
  }
})();
