(function () {
  const PHONE_MAX_WIDTH = 700;
  const PHONE_LANDSCAPE_MAX_WIDTH = 900;
  const root = document.documentElement;
  const listeners = new Set();

  let state = null;
  let stageViewport = null;
  let scheduled = false;

  function number(value, fallback) {
    value = Number(value);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  function cssNumber(value) {
    return String(Number(value.toFixed(3)));
  }

  function layoutRect() {
    const width = number(root.clientWidth, number(window.innerWidth, 0));
    const height = number(root.clientHeight, number(window.innerHeight, 0));
    return { left: 0, top: 0, width, height, right: width, bottom: height };
  }

  function visualRect(layout) {
    const viewport = window.visualViewport;
    if (!viewport) return { ...layout, scale: 1 };

    const left = Math.max(0, Number(viewport.offsetLeft) || 0);
    const top = Math.max(0, Number(viewport.offsetTop) || 0);
    const width = number(viewport.width, layout.width);
    const height = number(viewport.height, layout.height);
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      scale: number(viewport.scale, 1),
    };
  }

  function screenSize(layout) {
    const screenWidth = number(window.screen && window.screen.width, layout.width);
    const screenHeight = number(window.screen && window.screen.height, layout.height);
    return {
      width: screenWidth,
      height: screenHeight,
      shortSide: Math.min(screenWidth, screenHeight),
      longSide: Math.max(screenWidth, screenHeight),
    };
  }

  function hasMobileInput() {
    if (navigator.userAgentData && navigator.userAgentData.mobile) return true;
    if (/Android|iPhone|iPod|Mobile/i.test(navigator.userAgent || '')) return true;
    return !!(navigator.maxTouchPoints > 0
      && window.matchMedia
      && window.matchMedia('(pointer: coarse)').matches);
  }

  function isPhoneDevice(layout) {
    const size = screenSize(layout);
    return hasMobileInput()
      && size.shortSide <= PHONE_MAX_WIDTH
      && size.longSide <= PHONE_LANDSCAPE_MAX_WIDTH;
  }

  function isLandscape(layout) {
    const orientation = window.screen && window.screen.orientation;
    if (orientation && typeof orientation.type === 'string') {
      return orientation.type.indexOf('landscape') === 0;
    }
    if (typeof window.orientation === 'number') return Math.abs(window.orientation) === 90;

    const size = screenSize(layout);
    return size.width > size.height;
  }

  function sameNumber(a, b) {
    return Math.abs(a - b) < 0.25;
  }

  function sameLayout(a, b) {
    return !!a && sameNumber(a.width, b.width) && sameNumber(a.height, b.height);
  }

  function sameVisual(a, b) {
    return !!a
      && sameNumber(a.left, b.left)
      && sameNumber(a.top, b.top)
      && sameNumber(a.width, b.width)
      && sameNumber(a.height, b.height)
      && sameNumber(a.scale, b.scale);
  }

  function setCssVars(layout, visual, landscape) {
    const rightInset = Math.max(0, layout.width - visual.right);
    const bottomInset = Math.max(0, layout.height - visual.bottom);
    const resetStage = !stageViewport
      || !sameNumber(stageViewport.width, layout.width)
      || stageViewport.landscape !== landscape;
    const stageHeight = resetStage
      ? layout.height
      : Math.max(stageViewport.height, layout.height);

    stageViewport = { width: layout.width, height: stageHeight, landscape };

    root.style.setProperty('--visual-viewport-top', cssNumber(visual.top) + 'px');
    root.style.setProperty('--visual-viewport-left', cssNumber(visual.left) + 'px');
    root.style.setProperty('--visual-viewport-width', cssNumber(visual.width) + 'px');
    root.style.setProperty('--visual-viewport-height', cssNumber(visual.height) + 'px');
    root.style.setProperty('--visual-viewport-right', cssNumber(rightInset) + 'px');
    root.style.setProperty('--visual-viewport-bottom', cssNumber(bottomInset) + 'px');
    root.style.setProperty('--layout-viewport-width', cssNumber(layout.width) + 'px');
    root.style.setProperty('--layout-viewport-height', cssNumber(layout.height) + 'px');
    root.style.setProperty('--stage-viewport-height', cssNumber(stageHeight) + 'px');
    root.style.setProperty('--keyboard-inset-height', cssNumber(bottomInset) + 'px');
    root.style.setProperty(
      '--safe-viewport-width',
      'calc(' + cssNumber(visual.width) + 'px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px))'
    );
    root.style.setProperty(
      '--safe-viewport-height',
      'calc(' + cssNumber(visual.height) + 'px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))'
    );
  }

  function copyRect(rect) {
    return { ...rect };
  }

  function notify(change) {
    listeners.forEach(listener => {
      try {
        listener(change);
      } catch (error) {
        console.error('[MobileViewport] subscriber failed', error);
      }
    });
  }

  function refresh(force) {
    const layout = layoutRect();
    const visual = visualRect(layout);
    const phoneDevice = isPhoneDevice(layout);
    const landscape = isLandscape(layout);
    const phone = layout.width <= PHONE_MAX_WIDTH
      || (phoneDevice && landscape && layout.width <= PHONE_LANDSCAPE_MAX_WIDTH);
    const phoneChanged = !!state && state.phone !== phone;
    const layoutChanged = !state || state.landscape !== landscape || !sameLayout(state.layout, layout);
    const visualChanged = !state || !sameVisual(state.visual, visual);

    root.classList.toggle('phone-device', phoneDevice);
    root.classList.toggle('phone-ui', phone);

    if (force || layoutChanged || visualChanged) setCssVars(layout, visual, landscape);

    const initialized = !!state;
    state = { phone, phoneDevice, landscape, layout, visual };
    if (!initialized || (!phoneChanged && !layoutChanged && !visualChanged)) return;

    notify({
      type: phoneChanged ? 'modechange' : (visualChanged ? 'viewportchange' : 'layoutchange'),
      isPhone: phone,
      phoneChanged,
      visualChanged,
      layoutChanged,
      visualRect: copyRect(visual),
      layoutRect: copyRect(layout),
    });
  }

  function scheduleRefresh() {
    if (scheduled) return;
    scheduled = true;
    const enqueue = window.requestAnimationFrame || function (callback) { return setTimeout(callback, 0); };
    enqueue(function () {
      scheduled = false;
      refresh(false);
    });
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('MobileViewport.subscribe expects a function');
    listeners.add(listener);
    return function () { listeners.delete(listener); };
  }

  refresh(true);

  window.addEventListener('resize', scheduleRefresh, { passive: true });
  window.addEventListener('orientationchange', scheduleRefresh, { passive: true });
  window.addEventListener('pageshow', scheduleRefresh, { passive: true });
  if (window.screen && window.screen.orientation && window.screen.orientation.addEventListener) {
    window.screen.orientation.addEventListener('change', scheduleRefresh);
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', scheduleRefresh, { passive: true });
    window.visualViewport.addEventListener('scroll', scheduleRefresh, { passive: true });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleRefresh, { once: true });
  }

  window.MobileViewport = {
    isPhone: function () { return state.phone; },
    getVisualRect: function () { return copyRect(state.visual); },
    subscribe,
  };
})();
