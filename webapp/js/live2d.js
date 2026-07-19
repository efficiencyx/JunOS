window.Live2D = (function () {
  const { Live2DModel, Cubism4ModelSettings } = PIXI.live2d;

  const LERP_TAU_MS = 150; // exponential smoothing time constant

  let app = null;
  let model = null;
  let raw = null;            // raw Cubism core model (parts, parameters, drawables)
  let paramIndex = null;     // Map<paramId, idx>
  let paramMin = null, paramMax = null, paramDefault = null;

  const targetParams = new Map();   // paramId -> target value
  const currentValues = new Map();  // paramId -> current (lerped) value
  const loops = new Map();          // paramId -> { amplitude, period_ms, phase_start_ms, base }
  const pendingSequences = [];      // [{ param, value, fire_at_ms }]
  const forcedPartOpacity = new Map(); // partId -> opacity (re-stamped each tick)
  const forcedDrawableOpacity = new Map(); // drawableId -> opacity override
  const drawableHighlights = new Map();    // drawableId -> screen RGB

  let userZoom = 1;
  let userOffsetX = 0;
  let userOffsetY = 0;
  let hasUserPos = false;   // true once the user drags her or a saved position loads

  const CAMERA_STORAGE_KEY = 'l2d.camera';
  const CAMERA_STORAGE_VERSION = 2;
  let cameraStates = { phone: null, desktop: null };
  let legacyDesktopCamera = null;
  let cameraMode = 'desktop';
  let cameraPersistenceEnabled = true;
  let stageElement = null;
  let stageResizeObserver = null;
  let stageResizeFrame = 0;
  let visualRefitPending = false;
  let removeViewportSubscription = null;
  let lastUsableStage = null;
  let lastFittedScreen = null;

  let lastTickMs = performance.now();
  let onMissingParam = null;        // callback(name)
  const reportedMissing = new Set();
  let publicTint = null;            // tinting API object, built in init()

  function getRaw(m) {
    const cm = m.internalModel.coreModel;
    if (cm.parts && cm.parts.ids) return cm;
    if (cm._model && cm._model.parts) return cm._model;
    for (const k of Object.keys(cm)) {
      if (cm[k] && cm[k].parts && cm[k].parts.ids) return cm[k];
    }
    throw new Error('Cannot locate raw Cubism model');
  }

  function looksLikeCubismFrag(src) {
    return typeof src === 'string'
      && src.indexOf('s_texture0') >= 0
      && src.indexOf('u_baseColor') >= 0
      && /void\s+main\s*\(/.test(src);
  }

  function patchCubismFrag(src) {
    if (src.indexOf('u_multiplyColor') >= 0) return src;
    src = src.replace(
      /(uniform\s+vec4\s+u_baseColor\s*;)/,
      '$1\nuniform vec4 u_multiplyColor;\nuniform vec4 u_screenColor;'
    );
    // Scale screen colors by alpha to avoid coloring transparent texels.
    const helper = '\nvec4 omegaTint(vec4 c) {\n'
      + '  c.rgb = min(c.rgb, vec3(c.a));\n'
      + '  c.rgb = c.rgb * u_multiplyColor.rgb;\n'
      + '  c.rgb = c.rgb + u_screenColor.rgb * c.a - c.rgb * u_screenColor.rgb;\n'
      + '  return c;\n'
      + '}\n';
    src = src.replace(
      /texture2D\s*\(\s*s_texture0\s*,\s*([^)]+)\)/g,
      'omegaTint(texture2D(s_texture0, $1))'
    );
    src = src.replace(/(void\s+main\s*\()/, helper + '$1');
    return src;
  }

  function installColorShaderPatch(gl) {
    if (!gl || gl.__omegaShaderPatched) return;
    gl.__omegaShaderPatched = true;
    const orig = gl.shaderSource;
    gl.shaderSource = function (shader, source) {
      if (looksLikeCubismFrag(source)) {
        try { source = patchCubismFrag(source); } catch (e) { console.warn('[Live2D] shader patch failed', e); }
      }
      return orig.call(this, shader, source);
    };
  }

  async function fetchAsDataURL(url, mime) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch ${url} failed: ${resp.status}`);
    const buf = await resp.arrayBuffer();
    let bin = '';
    const bytes = new Uint8Array(buf);
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return `data:${mime};base64,${btoa(bin)}`;
  }

  async function init({ stageEl, onStatus, ignoreSavedPos }) {
    onStatus = onStatus || (() => { });
    onStatus('Initializing PIXI...');

    stageElement = stageEl;
    cameraMode = currentCameraMode();
    cameraPersistenceEnabled = !ignoreSavedPos;
    const initialSize = measureStage();

    app = new PIXI.Application({
      width: initialSize.width,
      height: initialSize.height,
      backgroundAlpha: 0,          // transparent canvas: model floats on the page background
      antialias: true,
      autoDensity: true,
      resolution: rendererResolution(cameraMode),
      preserveDrawingBuffer: true,
    });
    stageEl.appendChild(app.view);

    // pixi-live2d-display 0.4 ignores drawable colors, so inject shader uniforms.
    installColorShaderPatch(app.renderer.gl);

    onStatus('Loading Live2D assets...');
    const [mocUrl, t0, t1, t2] = await Promise.all([
      fetchAsDataURL('assets/interaction_model.moc3', 'application/octet-stream'),
      fetchAsDataURL('assets/texture_00.png', 'image/png'),
      fetchAsDataURL('assets/texture_01.png', 'image/png'),
      fetchAsDataURL('assets/texture_02.png', 'image/png'),
    ]);
    const TRANSPARENT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';
    const textures = [t0, t1, t2];
    while (textures.length < 8) textures.push(TRANSPARENT);

    // The extracted atlas mixes premultiplied and straight-alpha edge pixels.
    // Upload it as PMA, then normalize each sampled pixel in the shader so
    // neither representation can produce a bright or dark fringe.
    for (const url of textures) {
      PIXI.BaseTexture.from(url, {
        alphaMode: PIXI.ALPHA_MODES.PMA,
        mipmap: PIXI.MIPMAP_MODES.OFF,
        wrapMode: PIXI.WRAP_MODES.CLAMP,
        scaleMode: PIXI.SCALE_MODES.LINEAR,
      });
    }

    const settings = new Cubism4ModelSettings({
      url: 'inline.model3.json',
      Version: 3,
      FileReferences: { Moc: mocUrl, Textures: textures },
    });

    onStatus('Building model...');
    model = await Live2DModel.from(settings, { autoInteract: false, autoUpdate: true });
    for (const texture of model.textures) {
      const baseTexture = texture.baseTexture;
      baseTexture.alphaMode = PIXI.ALPHA_MODES.PMA;
      baseTexture.update();
    }
    app.stage.addChild(model);

    const im = model.internalModel;
    try { im.motionManager.stopAllMotions(); } catch (e) { }
    try { im.motionManager.update = () => false; } catch (e) { }
    try { if (im.motionManager.expressionManager) im.motionManager.expressionManager.update = () => false; } catch (e) { }
    im.breath = null;
    im.eyeBlink = null;
    im.physics = null;
    im.pose = null;
    im.focusController = { update: () => { }, focus: () => { }, x: 0, y: 0 };

    raw = getRaw(model);
    paramIndex = new Map();
    paramMin = new Map(); paramMax = new Map(); paramDefault = new Map();
    for (let i = 0; i < raw.parameters.count; i++) {
      const id = raw.parameters.ids[i];
      paramIndex.set(id, i);
      paramMin.set(id, raw.parameters.minimumValues[i]);
      paramMax.set(id, raw.parameters.maximumValues[i]);
      paramDefault.set(id, raw.parameters.defaultValues[i]);
      currentValues.set(id, raw.parameters.defaultValues[i]);
    }

    installVariantCompositor();

    const importedLegacy = loadPos();
    if (ignoreSavedPos) { userOffsetX = 0; userOffsetY = 0; userZoom = 1; hasUserPos = true; }
    fitModel();
    if (importedLegacy) {
      cameraStates.desktop = captureCameraState();
      legacyDesktopCamera = null;
      writeCameraStates();
    }
    watchStageSize();

    window.addEventListener('wheel', (e) => {
      if (cameraPreset === 'face') return;
      if (document.body.classList.contains('sidebar-open')) return;
      if (isInteractiveTarget(e.target)) return;
      if (!isOverModel(e.clientX, e.clientY)) return;
      e.preventDefault();
      if (e.shiftKey) {
        const desired = Math.max(0.2, Math.min(5, userZoom * Math.exp(-e.deltaY * 0.00025)));
        const factor = desired / userZoom;
        userZoom = desired;
        userOffsetX *= factor;
        userOffsetY *= factor;
      } else {
        userOffsetY -= e.deltaY * 0.25;
      }
      hasUserPos = true;
      fitModel();
      savePos();
    }, { passive: false });

    let dragging = false, dragMoved = false, dragPointerId = -1;
    let dragPX = 0, dragPY = 0, dragOX = 0, dragOY = 0;
    window.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (dragging) return;
      if (cameraPreset === 'face') return;
      if (document.body.classList.contains('wardrobe-open')) return;
      if (document.body.classList.contains('sidebar-open')) return;
      if (isInteractiveTarget(e.target)) return;
      if (!isOverModel(e.clientX, e.clientY)) return;
      if (e.pointerType === 'touch') e.preventDefault();
      dragging = true;
      dragMoved = false;
      dragPointerId = e.pointerId;
      dragPX = e.clientX; dragPY = e.clientY;
      dragOX = userOffsetX; dragOY = userOffsetY;
      try { e.target.setPointerCapture(e.pointerId); } catch (err) { }
    });
    window.addEventListener('pointermove', (e) => {
      if (!dragging || e.pointerId !== dragPointerId) return;
      if (document.body.classList.contains('l2d-touch-pending') || document.body.classList.contains('l2d-touching')) return;
      const dx = e.clientX - dragPX;
      const dy = e.clientY - dragPY;
      if (!dragMoved) {
        if (Math.hypot(dx, dy) < 4) return;
        dragMoved = true;
        hasUserPos = true;
        document.body.classList.add('l2d-dragging');
      }
      userOffsetX = dragOX + dx;
      userOffsetY = dragOY + dy;
      fitModel();
    });
    const endDrag = (e) => {
      if (!dragging || e.pointerId !== dragPointerId) return;
      const moved = dragMoved;
      dragging = false;
      dragMoved = false;
      dragPointerId = -1;
      document.body.classList.remove('l2d-dragging');
      if (moved) savePos();
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    app.ticker.add(tick);

    let forcedOrderBelow = [];               // [belowId, aboveId] pairs, re-applied each frame
    const forcedMultiplyColor = new Map();   // drawableId -> [r,g,b,a]
    const forcedScreenColor = new Map();     // drawableId -> [r,g,b,a]
    const r = model.internalModel.renderer;
    const gl = app.renderer.gl;
    const ONE = [1, 1, 1, 1];
    const ZERO = [0, 0, 0, 1];
    const uniformLocCache = new WeakMap(); // glProgram -> { mloc, sloc }

    if (r && r.doDrawModel && r.drawMesh && !r.__omegaPatched) {
      r.__omegaPatched = true;

      const visibleOrder = [];
      let drawCursor = 0;
      let currentDrawableId = null;   // set in drawMesh, read in drawElements hook

      const origDoDrawModel = r.doDrawModel.bind(r);
      r.doDrawModel = function () {
        const d = raw.drawables;
        if (d && d.opacities && forcedDrawableOpacity.size) {
          for (const [id, op] of forcedDrawableOpacity) {
            const i = d.ids.indexOf(id);
            if (i < 0) continue;
            d.opacities[i] = op;
            // Restore visibility that Cubism clears for zero-opacity outfits.
            if (op > 0.0001) d.dynamicFlags[i] |= 0x01;
          }
        }
        // Apply overrides before both our and Cubism's render-order sorts.
        if (d && forcedOrderBelow.length) {
          const ro = d.renderOrders;
          for (const [below, above] of forcedOrderBelow) {
            const bi = d.ids.indexOf(below), ai = d.ids.indexOf(above);
            if (bi >= 0 && ai >= 0 && ro[bi] > ro[ai]) {
              const t = ro[bi]; ro[bi] = ro[ai]; ro[ai] = t;
            }
          }
        }
        visibleOrder.length = 0;
        if (d) {
          const tmp = [];
          for (let i = 0; i < d.count; i++) {
            // Cubism filters on visibility, not opacity; match it to align tinting.
            const visible = (d.dynamicFlags[i] & 0x01) !== 0;
            if (visible) tmp.push(i);
          }
          tmp.sort((a, b) => d.renderOrders[a] - d.renderOrders[b]);
          for (let k = 0; k < tmp.length; k++) visibleOrder.push(tmp[k]);
        }
        drawCursor = 0;
        return origDoDrawModel();
      };

      const origDrawMesh = r.drawMesh.bind(r);
      r.drawMesh = function () {
        const isMaskPass = !!r._clippingContextBufferForMask;
        if (!isMaskPass) {
          const drawableIdx = visibleOrder[drawCursor++];
          currentDrawableId = drawableIdx !== undefined ? raw.drawables.ids[drawableIdx] : null;
        } else {
          currentDrawableId = null;
        }
        try {
          return origDrawMesh.apply(this, arguments);
        } finally {
          currentDrawableId = null;
        }
      };

      // Cubism binds its shader inside drawMesh, so set uniforms at draw time.
      const origDrawElements = gl.drawElements;
      gl.drawElements = function (mode, count, type, offset) {
        const prog = gl.getParameter(gl.CURRENT_PROGRAM);
        if (prog) {
          let cache = uniformLocCache.get(prog);
          if (!cache) {
            cache = {
              mloc: gl.getUniformLocation(prog, 'u_multiplyColor'),
              sloc: gl.getUniformLocation(prog, 'u_screenColor'),
            };
            uniformLocCache.set(prog, cache);
          }
          if (cache.mloc || cache.sloc) {
            const mc = (currentDrawableId && forcedMultiplyColor.get(currentDrawableId)) || ONE;
            const baseScreen = (currentDrawableId && forcedScreenColor.get(currentDrawableId)) || ZERO;
            const highlight = currentDrawableId && drawableHighlights.get(currentDrawableId);
            const sc = highlight
              ? [
                1 - (1 - baseScreen[0]) * (1 - highlight[0]),
                1 - (1 - baseScreen[1]) * (1 - highlight[1]),
                1 - (1 - baseScreen[2]) * (1 - highlight[2]),
                1,
              ]
              : baseScreen;
            if (cache.mloc) gl.uniform4f(cache.mloc, mc[0], mc[1], mc[2], mc[3]);
            if (cache.sloc) gl.uniform4f(cache.sloc, sc[0], sc[1], sc[2], sc[3]);
          }
        }
        return origDrawElements.call(this, mode, count, type, offset);
      };
    }

    publicTint = {
      setMultiply(drawableId, rgb) {
        if (rgb) forcedMultiplyColor.set(drawableId, [rgb[0], rgb[1], rgb[2], 1]);
        else forcedMultiplyColor.delete(drawableId);
      },
      setScreen(drawableId, rgb) {
        if (rgb) forcedScreenColor.set(drawableId, [rgb[0], rgb[1], rgb[2], 1]);
        else forcedScreenColor.delete(drawableId);
      },
      setHighlight(drawableId, rgb) {
        if (rgb) drawableHighlights.set(drawableId, [rgb[0], rgb[1], rgb[2]]);
        else drawableHighlights.delete(drawableId);
      },
      setOpacity(drawableId, op) {
        if (op == null) forcedDrawableOpacity.delete(drawableId);
        else forcedDrawableOpacity.set(drawableId, op);
      },
      listDrawables() { return Array.from(raw.drawables.ids); },
      setOrderBelow(pairs) { forcedOrderBelow = pairs || []; },
    };

    window.__l2d = {
      model, raw,
      hide(name) { forcedDrawableOpacity.set(name, 0); },
      show(name) { forcedDrawableOpacity.delete(name); },
      hideAll() { for (const id of raw.drawables.ids) forcedDrawableOpacity.set(id, 0); },
      showAll() { forcedDrawableOpacity.clear(); },
      listDrawables() { return Array.from(raw.drawables.ids); },
      hideRange(from, to) {
        const ids = raw.drawables.ids;
        for (let i = from; i < to && i < ids.length; i++) forcedDrawableOpacity.set(ids[i], 0);
      },
      visibleDrawables() {
        const out = [];
        const ops = raw.drawables.opacities, ids = raw.drawables.ids;
        for (let i = 0; i < raw.drawables.count; i++) if (ops[i] > 0.01) out.push([ids[i], ops[i]]);
        return out;
      },
      tint(name, rgb) { forcedMultiplyColor.set(name, [rgb[0], rgb[1], rgb[2], 1]); },
      untint(name) { forcedMultiplyColor.delete(name); },
      screenTint(name, rgb) { forcedScreenColor.set(name, [rgb[0], rgb[1], rgb[2], 1]); },
      unscreen(name) { forcedScreenColor.delete(name); },
    };

    onStatus(`OK - ${raw.parameters.count} params, ${raw.parts.count} parts`);
    return { paramIds: Array.from(paramIndex.keys()) };
  }

  function boundNumber(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function currentCameraMode() {
    try {
      return window.MobileViewport && window.MobileViewport.isPhone() ? 'phone' : 'desktop';
    } catch (e) {
      return 'desktop';
    }
  }

  function rendererResolution(mode) {
    const resolution = window.devicePixelRatio || 1;
    return mode === 'phone' ? Math.min(2, resolution) : resolution;
  }

  function measureStage() {
    const rect = stageElement && stageElement.getBoundingClientRect();
    const width = rect && rect.width ? rect.width : (stageElement && stageElement.clientWidth) || window.innerWidth;
    const height = rect && rect.height ? rect.height : (stageElement && stageElement.clientHeight) || window.innerHeight;
    return {
      width: Math.max(1, Math.round(width || 1)),
      height: Math.max(1, Math.round(height || 1)),
    };
  }

  function stageScreen() {
    const screen = app && (app.screen || (app.renderer && app.renderer.screen));
    if (screen && screen.width > 0 && screen.height > 0) {
      return { width: screen.width, height: screen.height };
    }
    return measureStage();
  }

  function textEntryFocused() {
    const activeElement = document.activeElement;
    return !!(activeElement && (
      activeElement.matches('input, textarea, select') || activeElement.isContentEditable
    ));
  }

  function usableStage(mode = cameraMode) {
    const screen = stageScreen();
    const full = { x: 0, y: 0, width: screen.width, height: screen.height };
    if (mode !== 'phone' || !window.MobileViewport || !app || !app.view) return full;

    let visual;
    try { visual = window.MobileViewport.getVisualRect(); } catch (e) { return full; }
    const canvas = app.view.getBoundingClientRect();
    if (!visual || !canvas.width || !canvas.height) return full;

    const visualRight = Number.isFinite(visual.right) ? visual.right : visual.left + visual.width;
    const visualBottom = Number.isFinite(visual.bottom) ? visual.bottom : visual.top + visual.height;
    const left = Math.max(canvas.left, visual.left);
    const top = Math.max(canvas.top, visual.top);
    const right = Math.min(canvas.right, visualRight);
    const bottom = Math.min(canvas.bottom, visualBottom);
    if (right - left < 1 || bottom - top < 1) return full;

    const scaleX = screen.width / canvas.width;
    const scaleY = screen.height / canvas.height;
    const candidate = {
      x: (left - canvas.left) * scaleX,
      y: (top - canvas.top) * scaleY,
      width: (right - left) * scaleX,
      height: (bottom - top) * scaleY,
    };
    if (textEntryFocused() && lastUsableStage && lastFittedScreen
      && Math.abs(screen.width - lastFittedScreen.width) < 1
      && candidate.height < lastUsableStage.height - 40) {
      return { ...lastUsableStage };
    }
    return candidate;
  }

  function fitModel() {
    if (!model || !app) return;
    const usable = usableStage();
    const margin = 0.92;
    const sx = (usable.width * margin) / model.internalModel.width;
    const sy = (usable.height * margin) / model.internalModel.height;
    userZoom = boundNumber(Number.isFinite(userZoom) ? userZoom : 1, 0.2, 5);
    const s = Math.min(sx, sy) * userZoom;
    const modelW = model.internalModel.width * s;
    const modelH = model.internalModel.height * s;
    const baseX = usable.x + usable.width / 2 - modelW / 2;
    const baseY = usable.y + usable.height / 2 - modelH / 2;
    if (!hasUserPos) {
      userOffsetX = cameraMode === 'phone' ? 0 : usable.width * 0.26;
      userOffsetY = 0;
    }
    const keepX = Math.min(120, modelW, usable.width);
    const keepY = Math.min(120, modelH, usable.height);
    const mx = boundNumber(baseX + userOffsetX, usable.x - modelW + keepX, usable.x + usable.width - keepX);
    const my = boundNumber(baseY + userOffsetY, usable.y - modelH + keepY, usable.y + usable.height - keepY);
    userOffsetX = mx - baseX;
    userOffsetY = my - baseY;
    model.scale.set(s);
    model.x = mx;
    model.y = my;
    lastUsableStage = { ...usable };
    lastFittedScreen = stageScreen();
  }

  function captureCameraState(usable = lastUsableStage || usableStage()) {
    if (!model || !usable || usable.width < 1 || usable.height < 1) return null;
    const centerX = model.x + model.internalModel.width * model.scale.x / 2;
    const centerY = model.y + model.internalModel.height * model.scale.y / 2;
    return {
      centerX: (centerX - usable.x) / usable.width,
      centerY: (centerY - usable.y) / usable.height,
      zoom: userZoom,
    };
  }

  function sanitizeCameraState(state) {
    if (!state || !Number.isFinite(state.centerX) || !Number.isFinite(state.centerY) || !Number.isFinite(state.zoom)) {
      return null;
    }
    return {
      centerX: boundNumber(state.centerX, -4, 5),
      centerY: boundNumber(state.centerY, -4, 5),
      zoom: boundNumber(state.zoom, 0.2, 5),
    };
  }

  function applyCameraState(state) {
    state = sanitizeCameraState(state);
    if (!state) return false;
    const usable = usableStage();
    userZoom = state.zoom;
    userOffsetX = (state.centerX - 0.5) * usable.width;
    userOffsetY = (state.centerY - 0.5) * usable.height;
    hasUserPos = true;
    return true;
  }

  function resetCameraForMode(mode = cameraMode) {
    userZoom = 1;
    userOffsetX = mode === 'phone' ? 0 : usableStage(mode).width * 0.26;
    userOffsetY = 0;
    hasUserPos = false;
  }

  function cameraSnapshotForMode(mode) {
    const state = sanitizeCameraState(cameraStates[mode]);
    return { mode, state, hasUserPos: !!state };
  }

  function currentCameraSnapshot() {
    return {
      mode: cameraMode,
      state: hasUserPos ? captureCameraState() : null,
      hasUserPos,
    };
  }

  function cameraTarget(snapshot) {
    if (snapshot && snapshot.hasUserPos && sanitizeCameraState(snapshot.state)) {
      const usable = usableStage();
      const state = sanitizeCameraState(snapshot.state);
      return {
        zoom: state.zoom,
        offsetX: (state.centerX - 0.5) * usable.width,
        offsetY: (state.centerY - 0.5) * usable.height,
      };
    }
    const usable = usableStage();
    return {
      zoom: 1,
      offsetX: cameraMode === 'phone' ? 0 : usable.width * 0.26,
      offsetY: 0,
    };
  }

  function restoreCameraForMode(mode) {
    const state = cameraPersistenceEnabled && sanitizeCameraState(cameraStates[mode]);
    if (state) {
      applyCameraState(state);
    } else if (mode === 'desktop' && legacyDesktopCamera) {
      userOffsetX = legacyDesktopCamera.x;
      userOffsetY = legacyDesktopCamera.y;
      userZoom = legacyDesktopCamera.zoom;
      hasUserPos = true;
      fitModel();
      cameraStates.desktop = captureCameraState();
      legacyDesktopCamera = null;
      writeCameraStates();
      return;
    } else {
      resetCameraForMode(mode);
    }
    fitModel();
  }

  function queueStageResize() {
    if (stageResizeFrame) return;
    stageResizeFrame = requestAnimationFrame(() => {
      stageResizeFrame = 0;
      resizeStage();
    });
  }

  function resizeStage() {
    if (!app || !app.renderer) return;
    const nextMode = currentCameraMode();
    const previousMode = cameraMode;
    const screen = stageScreen();
    const nextSize = measureStage();
    const nextResolution = rendererResolution(nextMode);
    const visualChanged = visualRefitPending;
    visualRefitPending = false;
    const modeChanged = nextMode !== previousMode;
    const sizeChanged = Math.abs(screen.width - nextSize.width) >= 1 || Math.abs(screen.height - nextSize.height) >= 1;
    const resolutionChanged = !Number.isFinite(app.renderer.resolution)
      || Math.abs(app.renderer.resolution - nextResolution) >= 0.01;
    if (!modeChanged && !sizeChanged && !resolutionChanged && !visualChanged) return;
    if (!modeChanged && !resolutionChanged && nextMode === 'phone'
      && textEntryFocused() && Math.abs(screen.width - nextSize.width) < 1) return;

    const wasTweening = !!cameraTween;
    const currentState = cameraPreset === 'default' && hasUserPos && !wasTweening
      ? captureCameraState()
      : null;
    if (modeChanged && cameraPersistenceEnabled && currentState) cameraStates[previousMode] = currentState;
    if (wasTweening) cancelCameraTween();
    if (resolutionChanged) app.renderer.resolution = nextResolution;
    if (sizeChanged || resolutionChanged) app.renderer.resize(nextSize.width, nextSize.height);
    cameraMode = nextMode;
    if (modeChanged && cameraPersistenceEnabled && cameraPreset === 'default' && wasTweening) {
      savedCamera = cameraSnapshotForMode(nextMode);
    }

    if (cameraPreset === 'face') {
      if (modeChanged && cameraPersistenceEnabled) savedCamera = cameraSnapshotForMode(nextMode);
      const target = computeFaceCamera();
      userZoom = target.zoom;
      userOffsetX = target.offsetX;
      userOffsetY = target.offsetY;
      hasUserPos = true;
      fitModel();
      return;
    }

    if (wasTweening && savedCamera) {
      const target = cameraTarget(savedCamera);
      userZoom = target.zoom;
      userOffsetX = target.offsetX;
      userOffsetY = target.offsetY;
      hasUserPos = savedCamera.hasUserPos;
      savedCamera = null;
      fitModel();
    } else if (modeChanged && cameraPersistenceEnabled) {
      savedCamera = null;
      restoreCameraForMode(nextMode);
    } else if (currentState) {
      applyCameraState(currentState);
      fitModel();
    } else {
      fitModel();
    }
  }

  function watchStageSize() {
    if (stageResizeObserver) stageResizeObserver.disconnect();
    if (removeViewportSubscription) removeViewportSubscription();

    if (window.ResizeObserver) {
      stageResizeObserver = new ResizeObserver(queueStageResize);
      stageResizeObserver.observe(stageElement);
    } else {
      window.addEventListener('resize', queueStageResize);
    }

    if (window.MobileViewport && window.MobileViewport.subscribe) {
      removeViewportSubscription = window.MobileViewport.subscribe((event) => {
        if (event.visualChanged && event.isPhone) visualRefitPending = true;
        if (event.phoneChanged || visualRefitPending || currentCameraMode() !== cameraMode) queueStageResize();
      });
    }
    queueStageResize();
  }

  let cameraPreset = 'default';
  let savedCamera = null;   // snapshot of user camera while 'face' is active
  let cameraTween = null;   // active ticker fn

  const FACE_CENTER_FRAC = 0.12;
  const FACE_SCREEN_Y = 0.42;
  const FACE_HEAD_FRAC = 0.30;

  function computeFaceCamera() {
    const usable = usableStage();
    const margin = 0.92;
    const sBase = Math.min(
      (usable.width * margin) / model.internalModel.width,
      (usable.height * margin) / model.internalModel.height
    );
    const zoom = Math.min(5, (usable.height * FACE_HEAD_FRAC) / (sBase * model.internalModel.height * 0.22));
    const modelH = model.internalModel.height * sBase * zoom;
    const baseY = usable.y + usable.height / 2 - modelH / 2;
    return {
      zoom,
      offsetX: 0,
      offsetY: (usable.y + usable.height * FACE_SCREEN_Y - FACE_CENTER_FRAC * modelH) - baseY,
    };
  }

  function cancelCameraTween() {
    if (cameraTween) { app.ticker.remove(cameraTween); cameraTween = null; }
  }

  function tweenCameraTo(target, ms, onDone) {
    cancelCameraTween();
    const from = { zoom: userZoom, offsetX: userOffsetX, offsetY: userOffsetY };
    const t0 = performance.now();
    cameraTween = () => {
      const t = Math.min(1, (performance.now() - t0) / ms);
      const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
      userZoom = from.zoom + (target.zoom - from.zoom) * e;
      userOffsetX = from.offsetX + (target.offsetX - from.offsetX) * e;
      userOffsetY = from.offsetY + (target.offsetY - from.offsetY) * e;
      fitModel();
      if (t >= 1) { cancelCameraTween(); if (onDone) onDone(); }
    };
    app.ticker.add(cameraTween);
  }

  function setCameraPreset(preset) {
    if (!model || !app || preset === cameraPreset) return;
    if (preset === 'face') {
      savedCamera = currentCameraSnapshot();
      cameraPreset = 'face';
      hasUserPos = true; // suppress the default rest offset in fitModel
      tweenCameraTo(computeFaceCamera(), 450);
    } else {
      cameraPreset = 'default';
      const back = savedCamera || cameraSnapshotForMode(cameraMode);
      hasUserPos = true;
      tweenCameraTo(cameraTarget(back), 450, () => {
        hasUserPos = back.hasUserPos;
        savedCamera = null;
        fitModel();
      });
    }
  }

  function clamp(id, v) {
    const lo = paramMin.get(id), hi = paramMax.get(id);
    if (lo === undefined) return v;
    return Math.max(lo, Math.min(hi, v));
  }

  function faceAnchor() {
    if (!model || !app) return null;
    const r = app.view.getBoundingClientRect();
    const b = model.getBounds();
    return {
      x: r.left + b.x + b.width / 2,
      y: r.top + b.y + b.height * 0.09,
      headW: Math.max(b.width * 0.30, b.height * 0.12),
    };
  }

  function isOverModel(clientX, clientY) {
    if (!model || !app) return false;
    const r = app.view.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    const b = model.getBounds();
    const hw = b.width * 0.5;
    const hx = b.x + (b.width - hw) / 2;
    return x >= hx && x <= hx + hw && y >= b.y && y <= b.y + b.height;
  }

  function isInteractiveTarget(t) {
    return !!(t && t.closest && t.closest(
      'button, a, input, textarea, select, .composer, .conv-sidebar, .settings-drawer, .app-header, .prompt-chips, .wardrobe-overlay, .face-bubble, .sidebar-backdrop'
    ));
  }

  function savePos() {
    if (document.body.classList.contains('wardrobe-open')) return;
    if (cameraPreset === 'face') return;
    if (!cameraPersistenceEnabled) return;
    const state = captureCameraState();
    if (!state) return;
    cameraStates[cameraMode] = state;
    writeCameraStates();
  }

  function loadPos() {
    cameraStates = { phone: null, desktop: null };
    legacyDesktopCamera = null;
    if (!cameraPersistenceEnabled) return false;
    try {
      const saved = JSON.parse(localStorage.getItem(CAMERA_STORAGE_KEY) || 'null');
      if (saved && saved.version === CAMERA_STORAGE_VERSION) {
        cameraStates.phone = sanitizeCameraState(saved.phone);
        cameraStates.desktop = sanitizeCameraState(saved.desktop);
      }
    } catch (e) { }

    if (!cameraStates.desktop) {
      try {
        const legacy = JSON.parse(localStorage.getItem('l2d.pos') || 'null');
        if (legacy && Number.isFinite(legacy.x)) {
          legacyDesktopCamera = {
            x: legacy.x,
            y: Number.isFinite(legacy.y) ? legacy.y : 0,
            zoom: Number.isFinite(legacy.z) ? boundNumber(legacy.z, 0.2, 5) : 1,
          };
        }
      } catch (e) { }
    }

    if (cameraStates[cameraMode]) {
      applyCameraState(cameraStates[cameraMode]);
      return false;
    }
    if (cameraMode !== 'desktop') {
      resetCameraForMode(cameraMode);
      return false;
    }
    if (legacyDesktopCamera) {
      userOffsetX = legacyDesktopCamera.x;
      userOffsetY = legacyDesktopCamera.y;
      userZoom = legacyDesktopCamera.zoom;
      hasUserPos = true;
      return true;
    }
    resetCameraForMode(cameraMode);
    return false;
  }

  function writeCameraStates() {
    if (!cameraPersistenceEnabled) return;
    try {
      localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify({
        version: CAMERA_STORAGE_VERSION,
        phone: sanitizeCameraState(cameraStates.phone),
        desktop: sanitizeCameraState(cameraStates.desktop),
      }));
    } catch (e) { }
  }

  function setOnMissingParam(cb) { onMissingParam = cb; }

  function knows(param) { return paramIndex.has(param); }

  function reportMissing(param) {
    if (reportedMissing.has(param)) return;
    reportedMissing.add(param);
    if (onMissingParam) onMissingParam(param);
  }

  function setTarget(param, value) {
    if (!paramIndex.has(param)) { reportMissing(param); return false; }
    targetParams.set(param, clamp(param, value));
    return true;
  }

  function setNow(param, value) {
    if (!setTarget(param, value)) return false;
    currentValues.set(param, clamp(param, value));
    return true;
  }

  function cancelPending(paramPrefix) {
    for (let i = pendingSequences.length - 1; i >= 0; i--) {
      if (pendingSequences[i].param.startsWith(paramPrefix)) pendingSequences.splice(i, 1);
    }
  }

  function startLoop(param, amplitude, period_ms, base) {
    if (!paramIndex.has(param)) { reportMissing(param); return false; }
    if (base === undefined) base = paramDefault.get(param) || 0;
    loops.set(param, {
      amplitude,
      period_ms: Math.max(50, period_ms),
      phase_start_ms: performance.now(),
      base,
    });
    return true;
  }

  function stopLoop(param) {
    loops.delete(param);
  }

  function stopAllLoops() {
    loops.clear();
  }

  function scheduleSequence(steps) {
    let t = performance.now();
    for (const step of steps) {
      const dt = step.dt_ms || 0;
      t += dt;
      for (const [param, value] of Object.entries(step.params || {})) {
        if (!paramIndex.has(param)) { reportMissing(param); continue; }
        pendingSequences.push({ param, value: clamp(param, value), fire_at_ms: t });
      }
    }
  }

  const STATEFUL_PARAMS = new Set([
    'ParamShirtEnabled', 'ParamBraEnabled', 'ParamPantiesEnabled',
    'ParamSkirtEnabled', 'ParamHoodieEnabled', 'ParamPantsEnabled',
    'ParamDress2Enabled', 'ParamShoeLOn', 'ParamShoeROn',
    'ParamHandholdingLEnable', 'ParamHandholdingREnable',
    'ParamCuddleHandholdingEnable', 'ParamFaceRubEnable',
  ]);

  function resetIdle() {
    const preserved = new Map();
    for (const id of STATEFUL_PARAMS) {
      if (!paramIndex.has(id)) continue;
      const t = targetParams.get(id);
      const c = currentValues.get(id);
      preserved.set(id, t !== undefined ? t : (c !== undefined ? c : paramDefault.get(id)));
    }
    targetParams.clear();
    pendingSequences.length = 0;
    for (const id of [...loops.keys()]) {
      if (!STATEFUL_PARAMS.has(id)) loops.delete(id);
    }
    for (const [id, def] of paramDefault) {
      if (STATEFUL_PARAMS.has(id)) continue;
      targetParams.set(id, def);
    }
    for (const [id, v] of preserved) {
      targetParams.set(id, v);
      currentValues.set(id, v);
    }
  }

  let idleActive = false;
  let blinkTimeout = null;
  let fidgetTimeout = null;
  const mood = { affection: 50, trust: 50, tension: 0 };

  function setMood(m) {
    for (const k of ['affection', 'trust', 'tension']) {
      const v = Number(m && m[k]);
      if (Number.isFinite(v)) mood[k] = Math.max(0, Math.min(100, v));
    }
    if (idleActive) applyMoodBaseline();
  }

  // warmth: -1 (cold) .. 1 (adoring); fear: 0 .. 1 once tension passes 45
  function moodFactors() {
    const warmth = ((mood.affection + mood.trust) / 2 - 50) / 50;
    const fear = Math.max(0, (mood.tension - 45) / 55);
    return { warmth, fear };
  }

  function moodTier() {
    const { warmth, fear } = moodFactors();
    if (fear >= 0.45) return 'scared';
    if (fear > 0) return 'nervous';
    if (warmth >= 0.4) return 'happy';
    if (warmth <= -0.4) return 'upset';
    return 'neutral';
  }

  function trySet(param, value) {
    if (paramIndex.has(param)) targetParams.set(param, clamp(param, value));
  }

  function applyMoodBaseline() {
    const { warmth, fear } = moodFactors();

    trySet('ParamMouthForm', warmth > 0 ? warmth * 0.6 : warmth * 0.4);
    const brow = warmth * 0.4 - fear * 0.6;
    trySet('ParamBrowLEmote', brow);
    trySet('ParamBrowREmote', brow);
    trySet('ParamBrowLRot', fear * 0.3);
    trySet('ParamBrowRRot', -fear * 0.3);
    trySet('ParamBrowLY', warmth * 0.2 + fear * 0.3);
    trySet('ParamBrowRY', warmth * 0.2 + fear * 0.3);

    const ear = fear > 0.3 ? -1 : (warmth > 0.3 ? 1 : (warmth < -0.3 ? -0.6 : 0));
    trySet('ParamEarL', ear);
    trySet('ParamEarR', ear);

    trySet('ParamEyesHappy', warmth >= 0.7 && fear === 0 ? 0.6 : 0);
    trySet('ParamBlush', warmth >= 0.7 && fear === 0 ? 0.25 : 0);
    trySet('ParamIrisZoom', -0.4 * fear);
    trySet('ParamEyeOpen', fear > 0.3 ? 1 : (warmth < -0.4 ? 0.7 : 1));

    if (fear > 0.4) {
      tryLoop('ParamHeadZ', 0.01 + 0.02 * fear, 220);
      tryLoop('ParamHeadX', 0.01 + 0.02 * fear, 120);
      tryLoop('ParamBodyX', 0.01 + 0.01 * fear, 200);
      tryLoop('ParamBodyY', 0.05, 1600);
    } else {
      stopLoop('ParamHeadZ');
      stopLoop('ParamHeadX');
      stopLoop('ParamBodyX');
      trySet('ParamHeadZ', paramDefault.get('ParamHeadZ') || 0);
      trySet('ParamHeadX', paramDefault.get('ParamHeadX') || 0);
      trySet('ParamBodyX', paramDefault.get('ParamBodyX') || 0);
      tryLoop('ParamBodyY', warmth > 0.4 ? 0.2 : 0.15, warmth > 0.4 ? 3000 : 3800);
    }
  }
  let blinkPhase = null; // { startMs, closeMs, holdMs, openMs }
  let mouthOverride = null; // null | 0..1, drives ParamMouthOpen each tick when set (e.g. TTS lipsync)

  function setMouthOverride(v) {
    if (v == null) { mouthOverride = null; return; }
    mouthOverride = Math.max(0, Math.min(1, v));
  }

  function tryLoop(param, amplitude, period_ms) {
    if (paramIndex.has(param)) startLoop(param, amplitude, period_ms);
  }

  function triggerBlink() {
    if (!paramIndex.has('ParamEyeOpen')) return;
    blinkPhase = { startMs: performance.now(), closeMs: 70, holdMs: 50, openMs: 120 };
  }

  function scheduleBlink() {
    if (blinkTimeout) clearTimeout(blinkTimeout);
    const delay = 2200 + Math.random() * 4000;
    blinkTimeout = setTimeout(() => {
      if (!idleActive) return;
      triggerBlink();
      if (Math.random() < 0.18) {
        setTimeout(() => { if (idleActive) triggerBlink(); }, 280);
      }
      scheduleBlink();
    }, delay);
  }

  const FIDGETS = [
    { kind: 'loop', param: 'ParamTailWiggle', amp: 0.5, period: 900, duration: 2400 },
    { kind: 'loop', param: 'ParamEarsWiggle', amp: 0.4, period: 700, duration: 1400, moods: ['neutral', 'happy', 'nervous'] },
    { kind: 'loop', param: 'ParamHeadX', amp: 1.2, period: 4200, duration: 4200, moods: ['neutral', 'happy', 'upset', 'nervous'] },
    { kind: 'loop', param: 'ParamHeadY', amp: 0.8, period: 3800, duration: 3800 },
    { kind: 'loop', param: 'ParamEyeballLX', amp: 0.3, period: 2600, duration: 2600, pair: 'ParamEyeballRX' },
    { kind: 'loop', param: 'ParamBodyX', amp: 0.2, period: 5000, duration: 5000, moods: ['neutral', 'happy', 'upset'] },
    { kind: 'pose', param: 'ParamLegL', value: 0.35, hold: 1800 },
    { kind: 'pose', param: 'ParamLegR', value: 0.35, hold: 1800 },
    { kind: 'pose', param: 'ParamLegL', value: -0.25, hold: 1500 },
    { kind: 'pose', param: 'ParamLegR', value: -0.25, hold: 1500 },
    { kind: 'pose', param: 'ParamArmLUp', value: 0.25, hold: 1600, moods: ['neutral', 'happy', 'nervous'] },
    { kind: 'pose', param: 'ParamArmRUp', value: 0.25, hold: 1600, moods: ['neutral', 'happy', 'nervous'] },
    { kind: 'pose', param: 'ParamArmLRot', value: 0.3, hold: 1400 },
    { kind: 'pose', param: 'ParamArmRRot', value: -0.3, hold: 1400 },
    { kind: 'pose', param: 'ParamArmLGesture', value: 0.4, hold: 1200 },
    { kind: 'pose', param: 'ParamArmRGesture', value: 0.4, hold: 1200 },

    { moods: ['happy'], kind: 'seq', param: 'ParamArmRUp', steps: [
      { params: { ParamArmRUp: 1, ParamArmRGesture: 2 }, dt_ms: 0 },
      { params: { ParamArmRRot: 0.4 }, dt_ms: 250 },
      { params: { ParamArmRRot: -0.4 }, dt_ms: 250 },
      { params: { ParamArmRRot: 0.4 }, dt_ms: 250 },
      { params: { ParamArmRRot: 0, ParamArmRUp: 0, ParamArmRGesture: 1 }, dt_ms: 350 },
    ] },
    { moods: ['happy'], kind: 'seq', param: 'ParamHeart', steps: [
      { params: { ParamHeart: 1, ParamIrisZoom: 0.5 }, dt_ms: 0 },
      { params: { ParamHeart: 0, ParamIrisZoom: 0 }, dt_ms: 2200 },
    ] },
    { moods: ['happy'], kind: 'seq', param: 'ParamEyesHappy', steps: [
      { params: { ParamEyesHappy: 1, ParamMouthForm: 1 }, dt_ms: 0 },
      { params: { ParamEyesHappy: 0.6, ParamMouthForm: 0.6 }, dt_ms: 2400 },
    ] },
    { moods: ['happy'], kind: 'loop', param: 'ParamTailWiggle', amp: 1, period: 600, duration: 2600 },
    { moods: ['happy'], kind: 'seq', param: 'ParamHeadZ', steps: [
      { params: { ParamHeadZ: -10 }, dt_ms: 0 },
      { params: { ParamHeadZ: 0 }, dt_ms: 1800 },
    ] },

    { moods: ['upset'], kind: 'seq', param: 'ParamEyeballLY', steps: [
      { params: { ParamEyeballLY: -0.8, ParamEyeballRY: -0.8, ParamHeadY: -0.3 }, dt_ms: 0 },
      { params: { ParamEyeballLY: 0, ParamEyeballRY: 0, ParamHeadY: 0 }, dt_ms: 2600 },
    ] },
    { moods: ['upset'], kind: 'seq', param: 'ParamHeadX', steps: [
      { params: { ParamHeadX: 0.4, ParamEyeballLX: 0.7, ParamEyeballRX: 0.7 }, dt_ms: 0 },
      { params: { ParamHeadX: 0, ParamEyeballLX: 0, ParamEyeballRX: 0 }, dt_ms: 2400 },
    ] },
    { moods: ['upset'], kind: 'seq', param: 'ParamBodyY', steps: [
      { params: { ParamBodyY: 0.3 }, dt_ms: 0 },
      { params: { ParamBodyY: -0.2, ParamMouthOpen: 0.3 }, dt_ms: 500 },
      { params: { ParamBodyY: 0, ParamMouthOpen: 0 }, dt_ms: 700 },
    ] },

    { moods: ['nervous', 'scared'], kind: 'seq', param: 'ParamEyeballLX', steps: [
      { params: { ParamEyeballLX: -0.8, ParamEyeballRX: -0.8 }, dt_ms: 0 },
      { params: { ParamEyeballLX: 0.8, ParamEyeballRX: 0.8 }, dt_ms: 380 },
      { params: { ParamEyeballLX: 0, ParamEyeballRX: 0 }, dt_ms: 380 },
    ] },
    { moods: ['scared'], kind: 'seq', param: 'ParamEyeLShock', steps: [
      { params: { ParamEyeLShock: 1, ParamEyeRShock: 1 }, dt_ms: 0 },
      { params: { ParamEyeLShock: 0, ParamEyeRShock: 0 }, dt_ms: 1400 },
    ] },
    { moods: ['scared'], kind: 'pose', param: 'ParamArmLUp', value: -1, pairValue: { ParamArmRUp: -1 }, hold: 2600 },
    { moods: ['nervous'], kind: 'pose', param: 'ParamArmLRot', value: 0.2, pairValue: { ParamArmRRot: -0.2 }, hold: 1200 },
  ];

  const FIDGET_DELAYS = {
    happy:   [1500, 4000],
    scared:  [1500, 3500],
    nervous: [1800, 4500],
    upset:   [3000, 7000],
    neutral: [2000, 6000],
  };

  function runFidget(f) {
    if (f.kind === 'seq') {
      scheduleSequence(f.steps);
      return;
    }
    if (f.kind === 'pose') {
      targetParams.set(f.param, clamp(f.param, f.value));
      const extras = f.pairValue || {};
      for (const [p, v] of Object.entries(extras)) {
        if (paramIndex.has(p)) targetParams.set(p, clamp(p, v));
      }
      setTimeout(() => {
        targetParams.set(f.param, paramDefault.get(f.param));
        for (const p of Object.keys(extras)) {
          if (paramIndex.has(p)) targetParams.set(p, paramDefault.get(p));
        }
      }, f.hold);
      return;
    }
    startLoop(f.param, f.amp, f.period);
    if (f.pair && paramIndex.has(f.pair)) startLoop(f.pair, f.amp, f.period);
    setTimeout(() => {
      stopLoop(f.param);
      if (f.pair) stopLoop(f.pair);
      targetParams.set(f.param, paramDefault.get(f.param));
      if (f.pair) targetParams.set(f.pair, paramDefault.get(f.pair));
    }, f.duration);
  }

  function scheduleFidget() {
    if (fidgetTimeout) clearTimeout(fidgetTimeout);
    const tier = moodTier();
    const [lo, hi] = FIDGET_DELAYS[tier] || FIDGET_DELAYS.neutral;
    const delay = lo + Math.random() * (hi - lo);
    fidgetTimeout = setTimeout(() => {
      if (!idleActive) return;
      const candidates = [];
      for (const f of FIDGETS) {
        if (!paramIndex.has(f.param)) continue;
        if (f.moods && !f.moods.includes(tier)) continue;
        candidates.push(f);
        // mood-specific fidgets get double weight so the mood reads clearly
        if (f.moods) candidates.push(f);
      }
      if (candidates.length) {
        runFidget(candidates[Math.floor(Math.random() * candidates.length)]);
      }
      scheduleFidget();
    }, delay);
  }

  function startIdle() {
    idleActive = true;
    applyMoodBaseline();
    scheduleBlink();
    scheduleFidget();
  }

  function stopIdle() {
    idleActive = false;
    if (blinkTimeout) { clearTimeout(blinkTimeout); blinkTimeout = null; }
    if (fidgetTimeout) { clearTimeout(fidgetTimeout); fidgetTimeout = null; }
  }

  function tick() {
    if (!raw) return;
    const now = performance.now();
    const dt = Math.max(1, now - lastTickMs);
    lastTickMs = now;

    if (pendingSequences.length) {
      for (let i = pendingSequences.length - 1; i >= 0; i--) {
        if (pendingSequences[i].fire_at_ms <= now) {
          const s = pendingSequences[i];
          targetParams.set(s.param, s.value);
          pendingSequences.splice(i, 1);
        }
      }
    }

    const alpha = 1 - Math.exp(-dt / LERP_TAU_MS);
    for (const [id, target] of targetParams) {
      const cur = currentValues.get(id);
      if (cur === undefined) { currentValues.set(id, target); continue; }
      let next = cur + (target - cur) * alpha;
      // Snap when close: params that gate drawable visibility (ParamHeadpat)
      // must actually reach 0, not decay asymptotically forever.
      if (Math.abs(target - next) < 0.001) next = target;
      currentValues.set(id, next);
    }

    const ps = raw.parameters;
    for (const [id, val] of currentValues) {
      const idx = paramIndex.get(id);
      if (idx === undefined) continue;
      ps.values[idx] = val;
    }

    for (const [id, L] of loops) {
      const phase = (now - L.phase_start_ms) / L.period_ms;
      const v = L.base + Math.sin(2 * Math.PI * phase) * L.amplitude;
      const idx = paramIndex.get(id);
      if (idx !== undefined) ps.values[idx] = clamp(id, v);
    }

    if (forcedPartOpacity.size && raw.parts && raw.parts.opacities) {
      for (const [id, op] of forcedPartOpacity) {
        const i = raw.parts.ids.indexOf(id);
        if (i >= 0) raw.parts.opacities[i] = op;
      }
    }

    // Bypass smoothing so lipsync tracks audio amplitude tightly.
    if (mouthOverride != null) {
      const idx = paramIndex.get('ParamMouthOpen');
      if (idx !== undefined) {
        ps.values[idx] = clamp('ParamMouthOpen', mouthOverride);
        currentValues.set('ParamMouthOpen', mouthOverride);
      }
    }

    if (blinkPhase) {
      const t = now - blinkPhase.startMs;
      const total = blinkPhase.closeMs + blinkPhase.holdMs + blinkPhase.openMs;
      const hi = paramMax.get('ParamEyeOpen');
      const lo = paramMin.get('ParamEyeOpen');
      let v;
      if (t <= 0) {
        v = hi;
      } else if (t < blinkPhase.closeMs) {
        v = hi + (lo - hi) * (t / blinkPhase.closeMs);
      } else if (t < blinkPhase.closeMs + blinkPhase.holdMs) {
        v = lo;
      } else if (t < total) {
        const u = (t - blinkPhase.closeMs - blinkPhase.holdMs) / blinkPhase.openMs;
        v = lo + (hi - lo) * u;
      } else {
        v = hi;
        blinkPhase = null;
      }
      const idx = paramIndex.get('ParamEyeOpen');
      if (idx !== undefined) ps.values[idx] = v;
      currentValues.set('ParamEyeOpen', v);
    }
  }

  function findDrawables(includes, excludes) {
    if (!publicTint) return [];
    const inc = (includes || []).map(s => s.toLowerCase());
    const exc = (excludes || []).map(s => s.toLowerCase());
    const out = [];
    for (const id of publicTint.listDrawables()) {
      const lo = id.toLowerCase();
      if (!inc.some(p => lo.includes(p))) continue;
      if (exc.some(p => lo.includes(p))) continue;
      out.push(id);
    }
    return out;
  }

  function tintByPattern(includes, excludes, rgb) {
    if (!publicTint) return [];
    const ids = findDrawables(includes, excludes);
    for (const id of ids) publicTint.setMultiply(id, rgb);
    return ids;
  }

  function screenByPattern(includes, excludes, rgb) {
    if (!publicTint) return [];
    const ids = findDrawables(includes, excludes);
    for (const id of ids) publicTint.setScreen(id, rgb);
    return ids;
  }

  function listDrawables() {
    return publicTint ? publicTint.listDrawables() : [];
  }

  // Variants replace only the matching shared-atlas UV region.
  const _texOverride = new Map();   // drawableId -> { img, overlay } | null
  const _uvRect = new Map();        // drawableId -> {tex,u0,v0,w,h}
  const _baseCanvas = [];           // texIndex -> canvas of the pristine atlas
  const _imgCache = new Map();      // url -> Promise<HTMLImageElement>
  const _originalSource = [];       // texIndex -> original HTMLImageElement source

  function installVariantCompositor() {
    _uvRect.clear();
    const D = raw.drawables, uvs = D.vertexUvs, ti = D.textureIndices;
    for (let d = 0; d < D.count; d++) {
      const uv = uvs[d];
      let u0 = 1, u1 = 0, v0 = 1, v1 = 0;
      for (let k = 0; k < uv.length; k += 2) {
        const u = uv[k], v = uv[k + 1];
        if (u < u0) u0 = u; if (u > u1) u1 = u;
        if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
      _uvRect.set(D.ids[d], { tex: ti[d], u0, v0, w: u1 - u0, h: v1 - v0, d });
    }
  }

  // Clip to cached mesh triangles because atlas UV bounds overlap.
  const _meshPath = new Map();     // drawableId -> Path2D
  function meshPath(id, W, H) {
    if (_meshPath.has(id)) return _meshPath.get(id);
    const r = _uvRect.get(id);
    const D = raw.drawables;
    const uv = D.vertexUvs[r.d], ix = D.indices[r.d];
    const p = new Path2D();
    for (let k = 0; k < ix.length; k += 3) {
      const a = ix[k] * 2, b = ix[k + 1] * 2, c = ix[k + 2] * 2;
      p.moveTo(uv[a] * W, (1 - uv[a + 1]) * H);
      p.lineTo(uv[b] * W, (1 - uv[b + 1]) * H);
      p.lineTo(uv[c] * W, (1 - uv[c + 1]) * H);
      p.closePath();
    }
    _meshPath.set(id, p);
    return p;
  }

  function _loadImg(url) {
    if (_imgCache.has(url)) return _imgCache.get(url);
    const p = new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = url;
    });
    // Never memoize a failure: a flaky load at startup must stay retryable.
    p.catch(() => _imgCache.delete(url));
    _imgCache.set(url, p);
    return p;
  }

  // alphaClip variants need a binary erase mask.
  function _alphaMask(img) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height);
    const px = d.data;
    for (let i = 3; i < px.length; i += 4) if (px[i]) px[i] = 255;
    x.putImageData(d, 0, 0);
    return c;
  }

  function _baseAtlas(texIndex) {
    if (_baseCanvas[texIndex]) return _baseCanvas[texIndex];
    const bt = model.textures[texIndex].baseTexture;
    const src = bt.resource.source;               // HTMLImageElement or canvas
    _originalSource[texIndex] = src;              // Keep reference to original image element
    const c = document.createElement('canvas');
    c.width = src.naturalWidth || src.width;
    c.height = src.naturalHeight || src.height;
    c.getContext('2d').drawImage(src, 0, 0);
    _baseCanvas[texIndex] = c;
    return c;
  }

  // Reuse one compositing canvas per texture to avoid allocation churn.
  const _liveCanvas = [];

  function _uploadTexture(texIndex, canvas) {
    // Invalidate Pixi's cached GL texture after replacing its source canvas.
    const bt = model.textures[texIndex].baseTexture;
    bt.alphaMode = PIXI.ALPHA_MODES.PMA;
    const res = bt.resource;
    res.source = canvas;
    res.width = canvas.width;
    res.height = canvas.height;
    const uid = model.glContextID;
    if (uid >= 0 && bt._glTextures[uid]) {
      delete bt._glTextures[uid];
    }
    return true;
  }

  function _restoreOriginalTexture(texIndex, origSource) {
    const bt = model.textures[texIndex].baseTexture;
    bt.alphaMode = PIXI.ALPHA_MODES.PMA;
    const res = bt.resource;
    res.source = origSource;
    res.width = origSource.naturalWidth || origSource.width;
    res.height = origSource.naturalHeight || origSource.height;
    const uid = model.glContextID;
    if (uid >= 0 && bt._glTextures[uid]) {
      delete bt._glTextures[uid];
    }
  }

  function recompositeTexture(texIndex) {
    let hasOverride = false;
    for (const [id, entry] of _texOverride) {
      const r = _uvRect.get(id);
      if (r && r.tex === texIndex && entry) {
        hasOverride = true;
        break;
      }
    }

    if (!hasOverride) {
      const orig = _originalSource[texIndex];
      if (orig) {
        _restoreOriginalTexture(texIndex, orig);
        return;
      }
    }

    const base = _baseAtlas(texIndex), W = base.width, H = base.height;
    if (!_liveCanvas[texIndex]) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      _liveCanvas[texIndex] = c;
    }
    const c = _liveCanvas[texIndex];
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(base, 0, 0);
    const active = [];
    for (const [id, entry] of _texOverride) {
      const r = _uvRect.get(id);
      if (!r || r.tex !== texIndex || !entry) continue;
      // Cubism's bottom-origin v coordinate needs the flipped canvas origin.
      active.push({ id, entry, x: r.u0 * W, yTop: (1 - (r.v0 + r.h)) * H, w: r.w * W, h: r.h * H });
    }
    // Erase before painting so overlapping atlas regions do not clear each other.
    for (const a of active) {
      if (a.entry.fullClear) {
        // Placeholder art and bilinear bleed require a padded full-rect erase.
        const p = 8;
        ctx.clearRect(a.x - p, a.yTop - p, a.w + 2 * p, a.h + 2 * p);
        continue;
      }
      if (a.entry.overlay) continue;   // decorations paint on top of the base
      ctx.save();
      ctx.clip(meshPath(a.id, W, H));
      if (a.entry.alphaClip) {
        // Shared texels need a binary-alpha erase to avoid holes and dark edges.
        if (!a.entry.mask) a.entry.mask = _alphaMask(a.entry.img);
        ctx.globalCompositeOperation = 'destination-out';
        ctx.drawImage(a.entry.mask, a.x, a.yTop, a.w, a.h);
        ctx.globalCompositeOperation = 'source-over';
      } else {
        ctx.clearRect(a.x, a.yTop, a.w, a.h);
      }
      ctx.restore();
    }
    for (const a of active) {
      ctx.save();
      ctx.clip(meshPath(a.id, W, H));
      // Tiny decals are pixel art (the fruit panty logos); keep them crisp.
      if (a.entry.img.width < 64) ctx.imageSmoothingEnabled = false;
      ctx.drawImage(a.entry.img, a.x, a.yTop, a.w, a.h);
      ctx.restore();
    }
    _uploadTexture(texIndex, c);
  }

  async function setDrawableTexture(drawableId, url, overlay) {
    const r = _uvRect.get(drawableId);
    if (!r) return;
    if (url) _texOverride.set(drawableId, { url, img: await _loadImg(url), overlay: !!overlay, alphaClip: false, fullClear: false });
    else _texOverride.delete(drawableId);
    recompositeTexture(r.tex);
  }

  async function setDrawableTextures(map) {
    const texes = new Set();
    await Promise.all(Object.entries(map).map(async ([id, val]) => {
      const r = _uvRect.get(id);
      if (!r) return;
      const url = val && typeof val === 'object' ? val.url : val;
      const overlay = val && typeof val === 'object' ? !!val.overlay : false;
      const alphaClip = val && typeof val === 'object' ? !!val.alphaClip : false;
      const fullClear = val && typeof val === 'object' ? !!val.fullClear : false;
      // Avoid re-uploading a 4k atlas when an outfit update is unchanged.
      const prev = _texOverride.get(id);
      if (url) {
        if (prev && prev.url === url && prev.overlay === overlay &&
            prev.alphaClip === alphaClip && prev.fullClear === fullClear) return;
        // One failed image must not abort the whole batch: the other
        // overrides still have to land and recomposite.
        let img;
        try { img = await _loadImg(url); }
        catch (e) { console.warn('texture load failed', id, url, e); return; }
        _texOverride.set(id, { url, img, overlay, alphaClip, fullClear });
      } else {
        if (!prev) return;
        _texOverride.delete(id);
      }
      texes.add(r.tex);
    }));
    for (const t of texes) recompositeTexture(t);
  }

  function setDrawableTint(id, rgb) {
    if (publicTint) publicTint.setMultiply(id, rgb);
  }

  function setDrawableScreen(id, rgb) {
    if (publicTint) publicTint.setScreen(id, rgb);
  }

  function setDrawableOpacity(id, op) {
    if (publicTint) publicTint.setOpacity(id, op);
  }

  function setDrawableOrderBelow(pairs) {
    if (publicTint) publicTint.setOrderBelow(pairs);
  }
  function opacityByPattern(includes, excludes, op) {
    const ids = findDrawables(includes, excludes);
    for (const id of ids) setDrawableOpacity(id, op);
    return ids;
  }

  function toModelPoint(clientX, clientY) {
    const rect = app.view.getBoundingClientRect();
    const p = model.toModelPosition(new PIXI.Point(clientX - rect.left, clientY - rect.top));
    // Convert model-canvas pixels (y down) to Cubism coordinates (y up).
    const ci = raw.canvasinfo;
    p.x = (p.x - ci.CanvasOriginX) / ci.PixelsPerUnit;
    p.y = (ci.CanvasOriginY - p.y) / ci.PixelsPerUnit;
    return p;
  }

  function pointInMesh(D, i, p) {
    const vp = D.vertexPositions[i], ix = D.indices[i];
    for (let k = 0; k < ix.length; k += 3) {
      const a = ix[k] * 2, b = ix[k + 1] * 2, c = ix[k + 2] * 2;
      const s1 = (vp[b] - vp[a]) * (p.y - vp[a + 1]) - (vp[b + 1] - vp[a + 1]) * (p.x - vp[a]);
      const s2 = (vp[c] - vp[b]) * (p.y - vp[b + 1]) - (vp[c + 1] - vp[b + 1]) * (p.x - vp[b]);
      const s3 = (vp[a] - vp[c]) * (p.y - vp[c + 1]) - (vp[a + 1] - vp[c + 1]) * (p.x - vp[c]);
      if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return true;
    }
    return false;
  }

  // Point-in-mesh test against specific drawables regardless of visibility,
  // for the model's invisible HitArea* meshes.
  function hitTest(clientX, clientY, ids) {
    if (!model || !raw || !app) return null;
    const p = toModelPoint(clientX, clientY);
    const D = raw.drawables;
    for (let i = 0; i < D.count; i++) {
      if (ids.has(D.ids[i]) && pointInMesh(D, i, p)) return D.ids[i];
    }
    return null;
  }

  function drawableAt(clientX, clientY, onlyIds, tolerancePx) {
    if (!model || !raw || !app) return null;
    const rect = app.view.getBoundingClientRect();
    const p = toModelPoint(clientX, clientY);
    const ci = raw.canvasinfo;
    const D = raw.drawables;
    const only = onlyIds ? (onlyIds instanceof Set ? onlyIds : new Set(onlyIds)) : null;
    const candidates = [];
    let best = null, bestOrder = -Infinity;
    for (let i = 0; i < D.count; i++) {
      if (only && !only.has(D.ids[i])) continue;
      const forcedOpacity = forcedDrawableOpacity.get(D.ids[i]);
      const opacity = forcedOpacity == null ? D.opacities[i] : forcedOpacity;
      // Include layers forced visible by the renderer.
      const visible = (D.dynamicFlags[i] & 0x01) || (forcedOpacity != null && forcedOpacity > 0.0001);
      if (!visible || opacity < 0.01) continue;
      candidates.push(i);
      if (D.renderOrders[i] <= bestOrder) continue;
      if (pointInMesh(D, i, p)) { best = D.ids[i]; bestOrder = D.renderOrders[i]; }
    }
    if (best || !tolerancePx) return best;
    // Nothing under the cursor exactly: fall back to padded bounding boxes,
    // smallest box wins so thin accessories are not shadowed by garments.
    const q = model.toModelPosition(new PIXI.Point(clientX - rect.left + tolerancePx, clientY - rect.top));
    const tol = Math.abs((q.x - ci.CanvasOriginX) / ci.PixelsPerUnit - p.x);
    let bestArea = Infinity;
    for (const i of candidates) {
      const vp = D.vertexPositions[i];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let k = 0; k < vp.length; k += 2) {
        if (vp[k] < minX) minX = vp[k];
        if (vp[k] > maxX) maxX = vp[k];
        if (vp[k + 1] < minY) minY = vp[k + 1];
        if (vp[k + 1] > maxY) maxY = vp[k + 1];
      }
      if (p.x < minX - tol || p.x > maxX + tol || p.y < minY - tol || p.y > maxY + tol) continue;
      const area = (maxX - minX) * (maxY - minY);
      if (area < bestArea) { bestArea = area; best = D.ids[i]; }
    }
    return best;
  }

  function drawableThumb(drawableId, size = 72) {
    const r = _uvRect.get(drawableId);
    if (!r || !model) return null;
    const base = _baseAtlas(r.tex), W = base.width, H = base.height;
    const w = Math.max(1, r.w * W), h = Math.max(1, r.h * H);
    const s = Math.min(size / w, size / h, 1);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    c.getContext('2d').drawImage(base, r.u0 * W, (1 - (r.v0 + r.h)) * H, w, h, 0, 0, c.width, c.height);
    return c.toDataURL();
  }

  function debugParam(param) {
    if (!paramIndex.has(param)) return { error: 'unknown param' };
    const idx = paramIndex.get(param);
    return {
      target: targetParams.get(param),
      current: currentValues.get(param),
      live: raw ? raw.parameters.values[idx] : undefined,
      min: paramMin.get(param), max: paramMax.get(param), def: paramDefault.get(param),
    };
  }

  return {
    init,
    setTarget,
    setNow,
    cancelPending,
    startLoop,
    stopLoop,
    stopAllLoops,
    scheduleSequence,
    resetIdle,
    startIdle,
    stopIdle,
    setMood,
    knows,
    setOnMissingParam,
    fitModel,
    setCameraPreset,
    debugParam,
    tintByPattern,
    screenByPattern,
    findDrawables,
    listDrawables,
    setDrawableTint,
    setDrawableScreen,
    setDrawableHighlight(drawableId, rgb) {
      if (publicTint) publicTint.setHighlight(drawableId, rgb);
    },
    setDrawableOpacity,
    setDrawableOrderBelow,
    opacityByPattern,
    setDrawableTexture,
    setDrawableTextures,
    setMouthOverride,
    isOverModel,
    faceAnchor,
    drawableAt,
    hitTest,
    drawableThumb,
  };
})();
