// what time it looks like outside. every room with a window or a
// door in it reads these, and so does the walk between them.
//
// no geolocation and no api call. day length comes off the calendar
// with a mid-latitude curve (roughly 45N: 15.5h at midsummer, 8.8h
// at midwinter), so 18:00 is dusk in december and full daylight in
// june. somebody on the equator gets a sky that swings harder than
// theirs actually does. it's a window in a dating sim, it's fine.
//
// the half that matters is --key-*: the room's OWN light follows the
// sky too, not just the glass. cool and bright at noon, sodium
// orange after dark. that's what stops the four rooms looking like
// one room with different furniture.
// zenith/mid/horizon are the three stops of the gradient you see
// through the glass. glow is the sun or the moon and x/y is where
// it sits in the frame, 0 0 top left. key is the interior light
// colour, level how hard it's driving, lit how lit the city
// silhouette reads (high at night, nothing at noon).
const PHASES = {
  night:     { zenith: '#070a14', mid: '#0d1426', horizon: '#1b2138', glow: '#2a3358', x: 70, y: 84, key: '#ffb26b', level: 0.38, lit: 1 },
  dawn:      { zenith: '#1b2340', mid: '#4a3a55', horizon: '#b3705c', glow: '#e8926a', x: 20, y: 77, key: '#ffc79a', level: 0.55, lit: 0.7 },
  morning:   { zenith: '#3f7bb5', mid: '#7fa9cf', horizon: '#cfd9e0', glow: '#fff3d8', x: 26, y: 58, key: '#e8f0ff', level: 0.9, lit: 0.15 },
  midday:    { zenith: '#2f6fb0', mid: '#6fa2d4', horizon: '#c6d8e8', glow: '#ffffff', x: 52, y: 24, key: '#f2f7ff', level: 1, lit: 0 },
  afternoon: { zenith: '#3b73a8', mid: '#8aa8c4', horizon: '#d8cdb5', glow: '#ffe9c0', x: 78, y: 54, key: '#fff0d8', level: 0.88, lit: 0.1 },
  golden:    { zenith: '#4a4a7a', mid: '#b06a52', horizon: '#e29553', glow: '#ffb464', x: 83, y: 71, key: '#ffc98a', level: 0.7, lit: 0.35 },
  dusk:      { zenith: '#141a33', mid: '#37334f', horizon: '#7a4a55', glow: '#b0685f', x: 86, y: 81, key: '#ffb87a', level: 0.5, lit: 0.8 },
};

function phaseAt(d) {
  const doy = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5);
  const dayLength = 12.15 + 3.35 * Math.cos(2 * Math.PI * (doy - 172) / 365);
  const sunrise = 12 - dayLength / 2;
  const sunset = 12 + dayLength / 2;
  const t = d.getHours() + d.getMinutes() / 60;
  if (t < sunrise - 1.2 || t > sunset + 1.6) return 'night';
  if (t < sunrise + 0.4) return 'dawn';
  if (t < sunrise + 2.6) return 'morning';
  if (t > sunset + 0.5) return 'dusk';
  if (t > sunset - 0.9) return 'golden';
  if (t > sunset - 2.6) return 'afternoon';
  return 'midday';
}

let current = '';

function apply(now) {
  const name = phaseAt(now || new Date());
  if (name === current) return name;
  current = name;
  const p = PHASES[name];
  const root = document.documentElement;
  root.dataset.sky = name;
  root.style.setProperty('--sky-zenith', p.zenith);
  root.style.setProperty('--sky-mid', p.mid);
  root.style.setProperty('--sky-horizon', p.horizon);
  root.style.setProperty('--sky-glow', p.glow);
  root.style.setProperty('--sky-glow-x', p.x + '%');
  root.style.setProperty('--sky-glow-y', p.y + '%');
  root.style.setProperty('--key-warm', p.key);
  root.style.setProperty('--key-level', String(p.level));
  root.style.setProperty('--city-lit', String(p.lit));
  return name;
}

export function startSkybox() {
  apply();
  // a karaoke session can run through a sunset. cheap enough to keep
  // checking, and apply() is a no-op until the phase actually turns
  setInterval(() => apply(), 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) apply(); });
}
