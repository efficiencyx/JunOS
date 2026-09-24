import * as Live2D from './live2d/live2d.js?v=4';
import * as MobileViewport from './core/viewport.js?v=1';
import * as Names from './core/names.js?v=1';
import { api } from './core/api.js?v=1';
import * as Outfit from './outfit/outfit.js?v=3';
import * as Scene from './trip/scene.js?v=1';
import { startSkybox } from './trip/skybox.js?v=1';
import * as TripLoader from './trip/trip-loader.js?v=1';
import { armCurtains } from './wardrobe/curtains.js?v=2';
import { openWardrobe } from './wardrobe/panel.js?v=4';

const status = document.getElementById('stageStatus');
const coarsePointer = matchMedia('(pointer: coarse)');

function syncOrientation(force = false) {
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
}

function dressPanel() {
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
}

async function main() {
  startSkybox();
  syncOrientation();
  window.addEventListener('resize', () => syncOrientation());
  document.addEventListener('focusout', () => requestAnimationFrame(() => syncOrientation()));
  window.addEventListener('orientationchange', () => requestAnimationFrame(() => syncOrientation(true)));
  if (screen.orientation && screen.orientation.addEventListener) {
    screen.orientation.addEventListener('change', () => requestAnimationFrame(() => syncOrientation(true)));
  }
  MobileViewport.subscribe(({ layoutChanged }) => {
    if (layoutChanged) syncOrientation();
  });

  // she has to have agreed in chat. a dead endpoint (android has
  // none) counts as open, this is a story rule not a security one
  const trip = await api('trip.php')
    .then(r => r.ok ? r.json() : null).catch(() => null);
  if (trip && trip.gated && trip.where !== 'shop') {
    location.replace('index.html');
    return;
  }
  // mount AFTER the gate, same reason as date.js
  TripLoader.mount();
  Scene.inject('.fitting-room', 'scene/boutique.svg');
  Names.load();
  Names.decorate();

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
    await openWardrobe();
    armCurtains();
    dressPanel();
    const bot = Names.getBot();
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
}

main();
