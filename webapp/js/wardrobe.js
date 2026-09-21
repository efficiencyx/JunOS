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
  const curtains = document.querySelector('.fitting-curtains');
  const stage = document.getElementById('stage');
  const changes = [];
  let changing = false;

  const positionCurtains = () => {
    const preview = document.body.classList.contains('looks-open') && document.querySelector('.wd-looks-stage');
    if (preview) {
      const r = preview.getBoundingClientRect();
      curtains.style.inset = `${r.top}px ${innerWidth - r.right}px ${innerHeight - r.bottom}px ${r.left}px`;
    } else {
      curtains.style.inset = '';
    }
  };
  if (window.ResizeObserver) new ResizeObserver(positionCurtains).observe(stage);
  else window.addEventListener('resize', positionCurtains);
  new MutationObserver(positionCurtains).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  async function drawCurtains(closed) {
    curtains.classList.toggle('closed', closed);
    await Promise.all([...curtains.children].flatMap(c => c.getAnimations()).map(a => a.finished.catch(() => {})));
  }

  async function changeBehindCurtains() {
    changing = true;
    stage.setAttribute('aria-busy', 'true');
    try {
      while (changes.length) {
        positionCurtains();
        await drawCurtains(true);
        do {
          const batch = changes.splice(0);
          for (const job of batch) {
            try { job.resolve(await job.apply()); }
            catch (error) { job.reject(error); }
          }
          await Live2D.texturesSettled();
          await new Promise(resolve => setTimeout(resolve, 180));
        } while (changes.length);
        await drawCurtains(false);
      }
    } finally {
      curtains.classList.remove('closed');
      stage.removeAttribute('aria-busy');
      changing = false;
    }
  }

  TripLoader.mount();
  // she has to have agreed in chat. a dead endpoint (android has
  // none) counts as open, this is a story rule not a security one
  const trip = await fetch('api/trip.php', { credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : null).catch(() => null);
  if (trip && trip.gated && trip.where !== 'shop') {
    location.replace('index.html');
    return;
  }
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
    window.WardrobeCurtains = {
      change(apply) {
        return new Promise((resolve, reject) => {
          changes.push({ apply, resolve, reject });
          if (!changing) changeBehindCurtains();
        });
      },
    };
    const panel = document.querySelector('.wardrobe-overlay');
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-labelledby', 'collectionTitle');
    const titles = panel.querySelector('.wd-titles');
    const kicker = document.createElement('span');
    kicker.className = 'wd-kicker';
    kicker.textContent = 'The dressing room · Annalie’s collection';
    const title = document.createElement('h2');
    title.className = 'wd-title';
    title.id = 'collectionTitle';
    title.textContent = 'Find her next look.';
    titles.prepend(kicker, title);
    const actions = panel.querySelector('.wd-actions');
    panel.appendChild(actions);
    actions.querySelector('.wd-looks').textContent = 'Saved looks';
    const leave = actions.querySelector('.wd-close');
    leave.textContent = 'Head home ↗';
    leave.setAttribute('aria-label', 'Leave the boutique and head home');
    leave.title = 'Head home';
    panel.querySelector('.wd-body').dispatchEvent(new Event('scroll'));
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
