(() => {
  const STAGES = {
    'Initializing PIXI...': 'Lacing up shoes',
    'Loading Live2D assets...': 'Counting the savings',
    'Building model...': 'Almost there',
  };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let root = null, statusEl = null, videoEl = null;

  const setP = (v) => root && root.style.setProperty('--trip-p', v);

  function mount({ reverse = false } = {}) {
    root = document.createElement('div');
    root.id = 'tripLoader';
    root.className = 'trip-loader' + (reverse ? ' reverse' : '');
    root.innerHTML = `
      <div class="trip-scene">
        <div class="trip-sky"></div>
        <div class="trip-ground"></div>
        <div class="trip-trail"></div>
        <div class="trip-walker-track">
          <div class="trip-walker-pos">
            <video class="trip-walkers" src="wardrobe-cutscene.webm" autoplay muted loop playsinline disablepictureinpicture></video>
          </div>
        </div>
      </div>
      <div class="trip-status">${reverse ? 'Heading home' : "Walking to Annalie's shop"}</div>`;
    statusEl = root.querySelector('.trip-status');
    videoEl = root.querySelector('.trip-walkers');
    videoEl.addEventListener('error', () => { videoEl.style.display = 'none'; });
    if (reduced) videoEl.pause();
    document.body.appendChild(root);

    // Fake progress: constant walk 0→99 over ~4s (CSS transition), park at 99
    // until loading finishes. The transition must be running before Live2D.init
    // blocks the main thread, hence the forced reflow between the two values.
    if (reduced) { setP(50); }
    else {
      setP(0);
      void root.offsetWidth;
      setP(99);
    }
  }

  function setStage(raw) {
    if (statusEl) statusEl.textContent = STAGES[raw] || String(raw).replace(/[.…]+$/, '');
  }

  async function finish() {
    if (!root) return;
    root.classList.add('arrived');
    setP(100);
    await new Promise(r => setTimeout(r, reduced ? 250 : 1000));
    root.classList.add('done');
  }

  function fail(message) {
    if (!root) return;
    root.classList.add('error');
    if (videoEl) videoEl.pause();
    if (statusEl) statusEl.textContent = message;
  }

  window.TripLoader = { mount, setStage, finish, fail };
})();
