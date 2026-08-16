(async () => {
  const status = document.getElementById('stageStatus');
  const coarsePointer = matchMedia('(pointer: coarse)');
  const syncOrientation = (force = false) => {
    const focusedControl = document.activeElement && document.activeElement.matches('input, textarea, select');
    if (!force && focusedControl && innerWidth <= 900) return;
    const type = screen.orientation && screen.orientation.type;
    const stableDeviceOrientation = type && navigator.maxTouchPoints > 0
      && Math.min(screen.width, screen.height) <= 900;
    const landscape = stableDeviceOrientation
      ? type.startsWith('landscape')
      : innerWidth > innerHeight;
    document.documentElement.classList.toggle('wd-landscape', landscape);
    document.documentElement.classList.toggle('wd-portrait', !landscape);
  };
  syncOrientation();
  window.addEventListener('resize', () => syncOrientation());
  document.addEventListener('focusout', () => requestAnimationFrame(() => syncOrientation()));
  window.addEventListener('orientationchange', () => requestAnimationFrame(() => syncOrientation(true)));
  if (screen.orientation && screen.orientation.addEventListener) {
    screen.orientation.addEventListener('change', () => requestAnimationFrame(() => syncOrientation(true)));
  }
  if (window.MobileViewport) MobileViewport.subscribe(({ layoutChanged }) => {
    if (layoutChanged) syncOrientation();
  });
  TripLoader.mount();
  if (window.Names) { Names.load(); Names.decorate(); }

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
    await Outfit.openWardrobe();
    const bot = window.Names ? Names.getBot() : 'Jun';
    status.textContent = coarsePointer.matches
      ? `Hold an item, then drag it onto ${bot} to dress her`
      : `Shift+wheel to zoom · drag items onto ${bot} to dress her`;
    TripLoader.setStage("Welcome to Annalie's");
    await TripLoader.finish();
  } catch (e) {
    console.error(e);
    status.textContent = 'Load error: ' + e.message;
    TripLoader.fail('Load error: ' + e.message);
  }
})();
