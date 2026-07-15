// Live2D engine: loads interaction_model.moc3, drives params via lerp + loops + sequences.
// Pattern (getRaw / kill internal updaters / write to coreModel.parameters.values) follows viewer/index.html.

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
  // Keep these outside init so hit-testing sees the same forced visibility as
  // the renderer. The wardrobe also uses the highlight map for hovered pieces.
  const forcedDrawableOpacity = new Map(); // drawableId -> opacity override
  const drawableHighlights = new Map();    // drawableId -> screen RGB

  let userZoom = 1;
  let userOffsetX = 0;
  let userOffsetY = 0;
  let hasUserPos = false;   // true once the user drags her or a saved position loads

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
    // Textures are premultiplied-alpha here, so the screen term must be scaled
    // by c.a - otherwise transparent texels get colored and the whole drawable
    // quad shows up as a solid tinted square.
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

    app = new PIXI.Application({
      resizeTo: stageEl,
      backgroundAlpha: 0,          // transparent canvas: model floats on the page background
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      preserveDrawingBuffer: true,
    });
    stageEl.appendChild(app.view);

    // Patch Cubism fragment shaders at compile time to add per-drawable
    // multiply + screen colors. The bundled Cubism Web Framework in
    // pixi-live2d-display 0.4 doesn't honor drawables.multiplyColors, so we
    // inject u_multiplyColor / u_screenColor uniforms here, and bind them
    // per-drawable in our drawMesh hook below.
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
    app.stage.addChild(model);

    // Kill internal updaters that would overwrite our targets every frame.
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

    loadPos();
    // Dedicated pages (wardrobe.html) center her in their own stage instead of
    // inheriting the chat page's saved position.
    if (ignoreSavedPos) { userOffsetX = 0; userOffsetY = 0; userZoom = 1; hasUserPos = true; }
    fitModel();
    window.addEventListener('resize', () => {
      if (cameraPreset === 'face' && !cameraTween) {
        const t = computeFaceCamera();
        userZoom = t.zoom; userOffsetX = t.offsetX; userOffsetY = t.offsetY;
      }
      fitModel();
    });

    // Zoom (shift+wheel) / vertical pan (wheel) while the pointer is over her.
    // The canvas is click-through, so we listen on the window and hit-test.
    window.addEventListener('wheel', (e) => {
      if (cameraPreset === 'face') return;
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

    // Drag to move her anywhere on the page.
    let dragging = false, dragPX = 0, dragPY = 0, dragOX = 0, dragOY = 0;
    window.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (cameraPreset === 'face') return;
      // Wardrobe mode: presses on the model start an item-removal drag instead of a pan.
      if (document.body.classList.contains('wardrobe-open')) return;
      if (isInteractiveTarget(e.target)) return;
      if (!isOverModel(e.clientX, e.clientY)) return;
      dragging = true;
      dragPX = e.clientX; dragPY = e.clientY;
      dragOX = userOffsetX; dragOY = userOffsetY;
      hasUserPos = true;
      document.body.classList.add('l2d-dragging');
    });
    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      userOffsetX = dragOX + (e.clientX - dragPX);
      userOffsetY = dragOY + (e.clientY - dragPY);
      fitModel();
    });
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('l2d-dragging');
      savePos();
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    app.ticker.add(tick);

    // Debug clothing toggle params: print min/max/default.
    const clothingParams = ['ParamShirtEnabled', 'ParamBraEnabled', 'ParamPantiesEnabled', 'ParamSkirtEnabled', 'ParamHoodieEnabled', 'ParamPantsEnabled', 'ParamDress2Enabled', 'ParamShoeLOn', 'ParamShoeROn'];
    const info = {};
    for (const p of clothingParams) {
      if (paramIndex.has(p)) info[p] = { min: paramMin.get(p), max: paramMax.get(p), def: paramDefault.get(p) };
      else info[p] = 'MISSING from model';
    }
    console.log('[Live2D] clothing params:', info);

    // Render-time hooks: forced opacity + per-drawable color uniforms.
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

      // Per-frame ordered list of drawable indices in render order.
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
            // Force-SHOW: some outfits (e.g. Dress1) are hidden purely by
            // opacity 0, which makes update() clear their IsVisible flag so the
            // Framework skips them. Re-set the flag so a forced opacity>0 can
            // actually render. (op<=0 leaves the flag; it just draws transparent.)
            if (op > 0.0001) d.dynamicFlags[i] |= 0x01;
          }
        }
        // Draw-order overrides: guarantee `below` renders under `above` by
        // swapping their rig-assigned render orders when they're inverted.
        // Runs before both our visibleOrder sort and the Framework's own
        // per-frame sorted list, so the two stay consistent.
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
            // Match the Framework's draw loop exactly: it skips on the IsVisible
            // dynamic flag only, NOT on opacity. Filtering by opacity here would
            // drop drawables we force to opacity 0 (e.g. shoe toggle) that the
            // Framework still draws, desyncing the per-drawable tint cursor.
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

      // Hook gl.drawElements so we can set our uniforms on the program that's
      // ACTUALLY bound at draw time (the Framework switches programs inside
      // drawMesh, after our drawMesh wrapper runs).
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
            // Compose a hover highlight with any existing screen tint instead
            // of clobbering it (for example, the blush color group).
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

    // Expose tinting to the public Live2D API (used by Outfit color pickers).
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
        // op=null clears the override (rig decides visibility); op=0 force-hides.
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

  function fitModel() {
    if (!model || !app) return;
    const dpr = window.devicePixelRatio || 1;
    const stageW = app.view.width / dpr;
    const stageH = app.view.height / dpr;
    const margin = 0.92;
    const sx = (stageW * margin) / model.internalModel.width;
    const sy = (stageH * margin) / model.internalModel.height;
    const s = Math.min(sx, sy) * userZoom;
    const modelW = model.internalModel.width * s;
    const modelH = model.internalModel.height * s;
    const baseX = stageW / 2 - modelW / 2;
    const baseY = stageH / 2 - modelH / 2;
    // Until the user positions her, float to the right of the centered chat.
    if (!hasUserPos) { userOffsetX = stageW * 0.26; userOffsetY = 0; }
    // Keep at least KEEP px of the model on screen in every direction.
    const KEEP = 120;
    const mx = Math.max(-modelW + KEEP, Math.min(stageW - KEEP, baseX + userOffsetX));
    const my = Math.max(-modelH + KEEP, Math.min(stageH - KEEP, baseY + userOffsetY));
    userOffsetX = mx - baseX;
    userOffsetY = my - baseY;
    model.scale.set(s);
    model.x = mx;
    model.y = my;
  }

  // --- Camera presets (voice mode face zoom) ---
  let cameraPreset = 'default';
  let savedCamera = null;   // snapshot of user camera while 'face' is active
  let cameraTween = null;   // active ticker fn

  // Face framing constants: face center sits ~12% from the model's top; frame
  // it slightly above the stage midline with the head ~1/3 of stage height.
  const FACE_CENTER_FRAC = 0.12;
  const FACE_SCREEN_Y = 0.42;
  const FACE_HEAD_FRAC = 0.30;

  function computeFaceCamera() {
    const dpr = window.devicePixelRatio || 1;
    const stageW = app.view.width / dpr;
    const stageH = app.view.height / dpr;
    const margin = 0.92;
    const sBase = Math.min(
      (stageW * margin) / model.internalModel.width,
      (stageH * margin) / model.internalModel.height
    );
    // Head ≈ top 22% of the model; make it FACE_HEAD_FRAC of stage height.
    const zoom = Math.min(5, (stageH * FACE_HEAD_FRAC) / (sBase * model.internalModel.height * 0.22));
    const modelH = model.internalModel.height * sBase * zoom;
    const baseY = stageH / 2 - modelH / 2;
    return {
      zoom,
      offsetX: 0,
      offsetY: (stageH * FACE_SCREEN_Y - FACE_CENTER_FRAC * modelH) - baseY,
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
      savedCamera = { zoom: userZoom, offsetX: userOffsetX, offsetY: userOffsetY, hasUserPos };
      cameraPreset = 'face';
      hasUserPos = true; // suppress the default rest offset in fitModel
      tweenCameraTo(computeFaceCamera(), 450);
    } else {
      cameraPreset = 'default';
      const back = savedCamera || { zoom: 1, offsetX: 0, offsetY: 0, hasUserPos: false };
      savedCamera = null;
      if (!back.hasUserPos) {
        // Tween to the rest pose explicitly; only hand control back to
        // fitModel's default-offset branch once the tween lands.
        const dpr = window.devicePixelRatio || 1;
        const restX = (app.view.width / dpr) * 0.26;
        tweenCameraTo({ zoom: back.zoom, offsetX: restX, offsetY: 0 }, 450,
          () => { hasUserPos = false; fitModel(); });
      } else {
        tweenCameraTo(back, 450);
      }
    }
  }

  function clamp(id, v) {
    const lo = paramMin.get(id), hi = paramMax.get(id);
    if (lo === undefined) return v;
    return Math.max(lo, Math.min(hi, v));
  }

  function isOverModel(clientX, clientY) {
    if (!model || !app) return false;
    const r = app.view.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    const b = model.getBounds();
    // Narrow the hit area to 50% of her width, kept centred; full height.
    const hw = b.width * 0.5;
    const hx = b.x + (b.width - hw) / 2;
    return x >= hx && x <= hx + hw && y >= b.y && y <= b.y + b.height;
  }

  // Don't start a drag when the press lands on an actual UI control she overlaps.
  function isInteractiveTarget(t) {
    return !!(t && t.closest && t.closest(
      'button, a, input, textarea, select, .composer, .conv-sidebar, .settings-drawer, .app-header, .prompt-chips, .wardrobe-overlay'
    ));
  }

  function savePos() {
    // Wardrobe-page zoom/pan is transient - never clobber the chat page's position.
    if (document.body.classList.contains('wardrobe-open')) return;
    // Voice-mode face camera is transient too.
    if (cameraPreset === 'face') return;
    try {
      localStorage.setItem('l2d.pos', JSON.stringify({ x: userOffsetX, y: userOffsetY, z: userZoom }));
    } catch (e) { }
  }

  function loadPos() {
    try {
      const s = JSON.parse(localStorage.getItem('l2d.pos') || 'null');
      if (s && typeof s.x === 'number') {
        userOffsetX = s.x;
        userOffsetY = typeof s.y === 'number' ? s.y : 0;
        if (s.z) userZoom = s.z;
        hasUserPos = true;
      }
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

  // steps: [{ params: {name:value,...}, dt_ms }]
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

  // Params whose value represents persistent on/off state (clothing & props).
  // resetIdle() must NOT snap these back to default.
  // NB: transient pose-y wardrobe params (ParamSkirtUp, ParamPantiesX) are
  // intentionally NOT here - those should reset along with the body pose.
  const STATEFUL_PARAMS = new Set([
    'ParamShirtEnabled', 'ParamBraEnabled', 'ParamPantiesEnabled',
    'ParamSkirtEnabled', 'ParamHoodieEnabled', 'ParamPantsEnabled',
    'ParamDress2Enabled', 'ParamShoeLOn', 'ParamShoeROn',
    'ParamHandholdingLEnable', 'ParamHandholdingREnable',
    'ParamCuddleHandholdingEnable', 'ParamFaceRubEnable',
  ]);

  function resetIdle() {
    // Preserve current values of stateful params across the reset.
    const preserved = new Map();
    for (const id of STATEFUL_PARAMS) {
      if (!paramIndex.has(id)) continue;
      const t = targetParams.get(id);
      const c = currentValues.get(id);
      preserved.set(id, t !== undefined ? t : (c !== undefined ? c : paramDefault.get(id)));
    }
    targetParams.clear();
    pendingSequences.length = 0;
    // Drop loops on non-stateful params only.
    for (const id of [...loops.keys()]) {
      if (!STATEFUL_PARAMS.has(id)) loops.delete(id);
    }
    for (const [id, def] of paramDefault) {
      if (STATEFUL_PARAMS.has(id)) continue;
      targetParams.set(id, def);
    }
    // Re-assert preserved values so they win over any default lerp.
    for (const [id, v] of preserved) {
      targetParams.set(id, v);
      currentValues.set(id, v);
    }
  }

  // Idle ambient animation: breathing, blinking, subtle sways.
  let idleActive = false;
  let blinkTimeout = null;
  let fidgetTimeout = null;
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
      // Occasional double-blink.
      if (Math.random() < 0.18) {
        setTimeout(() => { if (idleActive) triggerBlink(); }, 280);
      }
      scheduleBlink();
    }, delay);
  }

  // Pool of small one-at-a-time fidgets. Each runs briefly, then we wait.
  // Two kinds: 'loop' = sin oscillation; 'pose' = move to value, hold, return.
  const FIDGETS = [
    // Oscillating bits.
    { kind: 'loop', param: 'ParamTailWiggle', amp: 0.5, period: 900, duration: 2400 },
    { kind: 'loop', param: 'ParamEarsWiggle', amp: 0.4, period: 700, duration: 1400 },
    { kind: 'loop', param: 'ParamHeadX', amp: 1.2, period: 4200, duration: 4200 },
    { kind: 'loop', param: 'ParamHeadY', amp: 0.8, period: 3800, duration: 3800 },
    { kind: 'loop', param: 'ParamEyeballLX', amp: 0.3, period: 2600, duration: 2600, pair: 'ParamEyeballRX' },
    { kind: 'loop', param: 'ParamBodyX', amp: 0.2, period: 5000, duration: 5000 },
    // Pose-and-return: shift a leg, raise an arm slightly, rotate an arm.
    { kind: 'pose', param: 'ParamLegL', value: 0.35, hold: 1800 },
    { kind: 'pose', param: 'ParamLegR', value: 0.35, hold: 1800 },
    { kind: 'pose', param: 'ParamLegL', value: -0.25, hold: 1500 },
    { kind: 'pose', param: 'ParamLegR', value: -0.25, hold: 1500 },
    { kind: 'pose', param: 'ParamArmLUp', value: 0.25, hold: 1600 },
    { kind: 'pose', param: 'ParamArmRUp', value: 0.25, hold: 1600 },
    { kind: 'pose', param: 'ParamArmLRot', value: 0.3, hold: 1400 },
    { kind: 'pose', param: 'ParamArmRRot', value: -0.3, hold: 1400 },
    { kind: 'pose', param: 'ParamArmLGesture', value: 0.4, hold: 1200 },
    { kind: 'pose', param: 'ParamArmRGesture', value: 0.4, hold: 1200 },
  ];

  function scheduleFidget() {
    if (fidgetTimeout) clearTimeout(fidgetTimeout);
    const delay = 2000 + Math.random() * 6000;
    fidgetTimeout = setTimeout(() => {
      if (!idleActive) return;
      const candidates = FIDGETS.filter(f => paramIndex.has(f.param));
      if (candidates.length) {
        const f = candidates[Math.floor(Math.random() * candidates.length)];
        if (f.kind === 'pose') {
          targetParams.set(f.param, clamp(f.param, f.value));
          setTimeout(() => {
            targetParams.set(f.param, paramDefault.get(f.param));
          }, f.hold);
        } else {
          startLoop(f.param, f.amp, f.period);
          if (f.pair && paramIndex.has(f.pair)) startLoop(f.pair, f.amp, f.period);
          setTimeout(() => {
            stopLoop(f.param);
            if (f.pair) stopLoop(f.pair);
            targetParams.set(f.param, paramDefault.get(f.param));
            if (f.pair) targetParams.set(f.pair, paramDefault.get(f.pair));
          }, f.duration);
        }
      }
      scheduleFidget();
    }, delay);
  }

  function startIdle() {
    idleActive = true;
    // Always-on faint breath + blink. Everything else is a brief, occasional fidget.
    tryLoop('ParamBodyY', 0.15, 3800);
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

    // Fire pending sequence keyframes whose time has come.
    if (pendingSequences.length) {
      for (let i = pendingSequences.length - 1; i >= 0; i--) {
        if (pendingSequences[i].fire_at_ms <= now) {
          const s = pendingSequences[i];
          targetParams.set(s.param, s.value);
          pendingSequences.splice(i, 1);
        }
      }
    }

    // Lerp current toward target (exponential smoothing).
    const alpha = 1 - Math.exp(-dt / LERP_TAU_MS);
    for (const [id, target] of targetParams) {
      const cur = currentValues.get(id);
      if (cur === undefined) { currentValues.set(id, target); continue; }
      const next = cur + (target - cur) * alpha;
      currentValues.set(id, next);
    }

    // Write current values to the core model.
    const ps = raw.parameters;
    for (const [id, val] of currentValues) {
      const idx = paramIndex.get(id);
      if (idx === undefined) continue;
      ps.values[idx] = val;
    }

    // Apply loops (overwrite after lerp, so they animate cleanly).
    for (const [id, L] of loops) {
      const phase = (now - L.phase_start_ms) / L.period_ms;
      const v = L.base + Math.sin(2 * Math.PI * phase) * L.amplitude;
      const idx = paramIndex.get(id);
      if (idx !== undefined) ps.values[idx] = clamp(id, v);
    }

    // Force part opacities (debug hide/show).
    if (forcedPartOpacity.size && raw.parts && raw.parts.opacities) {
      for (const [id, op] of forcedPartOpacity) {
        const i = raw.parts.ids.indexOf(id);
        if (i >= 0) raw.parts.opacities[i] = op;
      }
    }

    // Mouth override (e.g. TTS audio-RMS lipsync). Bypasses lerp so the mouth
    // tracks audio amplitude tightly instead of being smeared by smoothing.
    if (mouthOverride != null) {
      const idx = paramIndex.get('ParamMouthOpen');
      if (idx !== undefined) {
        ps.values[idx] = clamp('ParamMouthOpen', mouthOverride);
        currentValues.set('ParamMouthOpen', mouthOverride);
      }
    }

    // Blink: drive ParamEyeOpen directly so the lerp can't smear it out.
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

  // Find drawable IDs whose name (case-insensitive) contains any include pattern
  // and none of the exclude patterns. Patterns are plain substrings.
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

  // Apply rgb (array of 0..1) to all drawables matched by patterns. rgb=null clears.
  function tintByPattern(includes, excludes, rgb) {
    if (!publicTint) return [];
    const ids = findDrawables(includes, excludes);
    for (const id of ids) publicTint.setMultiply(id, rgb);
    return ids;
  }

  // Additive (screen) tint - adds color rather than darkening, so it reads as a
  // glow/flush instead of a shadow. Used for blush. rgb=null clears.
  function screenByPattern(includes, excludes, rgb) {
    if (!publicTint) return [];
    const ids = findDrawables(includes, excludes);
    for (const id of ids) publicTint.setScreen(id, rgb);
    return ids;
  }

  function listDrawables() {
    return publicTint ? publicTint.listDrawables() : [];
  }

  // ---- Variant texture compositor -------------------------------------------
  // Game-faithful alternative clothing (cf. MakeItemTextureFromParts): swaps a
  // drawable's region of the shared atlas with an alternative texture, matching
  // the drawable's UV rectangle, then re-uploads that atlas texture. The moc3's
  // per-drawable UVs give the exact rectangle, so variant sprites (which are
  // authored to fill that rect) drop in 1:1.
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

  // Path2D of a drawable's mesh triangles in atlas pixel space, cached.
  // Compositing clips to this so an override can never spill onto neighboring
  // drawables: UV *bounding rects* overlap heavily in this atlas (hands, bra,
  // feet share rect area with unrelated items), and painting a full rect
  // stamps the override's art onto all of them.
  const _meshPath = new Map();     // drawableId -> Path2D
  function meshPath(id, W, H) {
    if (_meshPath.has(id)) return _meshPath.get(id);
    const r = _uvRect.get(id);
    const D = raw.drawables;
    const uv = D.vertexUvs[r.d], ix = D.indices[r.d];
    const p = new Path2D();
    // Same v convention as the rect math above: runtime uvs, y = (1 - v) * H.
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
    _imgCache.set(url, p);
    return p;
  }

  // Canvas copy of an image with alpha binarized (any coverage -> fully
  // opaque). Used as an erase mask by alphaClip variants.
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
    // Snapshot the *original* atlas image before any compositing.
    // model.textures[] are Pixi Texture objects wrapping BaseTextures.
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

  // The live-composited atlas canvas that replaces the BaseTexture source.
  // We keep one persistent canvas per texture index so we're not thrashing GC.
  const _liveCanvas = [];

  function _uploadTexture(texIndex, canvas) {
    // pixi-live2d-display's _render() loop caches the GL texture object in
    // baseTexture._glTextures[contextUID] and only re-uploads when that entry
    // is missing (or on a GL context change). To force it to re-upload our
    // composited canvas we:
    //  1. Swap the resource's source to our canvas
    //  2. Delete the cached _glTextures entry so the next _render() frame
    //     triggers renderer.texture.bind() → which re-uploads from source
    const bt = model.textures[texIndex].baseTexture;
    bt.alphaMode = PIXI.ALPHA_MODES.PMA;
    const res = bt.resource;
    res.source = canvas;
    res.width = canvas.width;
    res.height = canvas.height;
    // Invalidate Pixi's GL texture cache for this BaseTexture.
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
    // Invalidate Pixi's GL texture cache for this BaseTexture.
    const uid = model.glContextID;
    if (uid >= 0 && bt._glTextures[uid]) {
      delete bt._glTextures[uid];
    }
  }

  function recompositeTexture(texIndex) {
    // Check if we have any active overrides for this texture index
    let hasOverride = false;
    for (const [id, entry] of _texOverride) {
      const r = _uvRect.get(id);
      if (r && r.tex === texIndex && entry) {
        hasOverride = true;
        break;
      }
    }

    if (!hasOverride) {
      // No overrides active: restore the original clean PNG image element!
      const orig = _originalSource[texIndex];
      if (orig) {
        _restoreOriginalTexture(texIndex, orig);
        return;
      }
    }

    const base = _baseAtlas(texIndex), W = base.width, H = base.height;
    // Reuse a persistent canvas to avoid allocating a new one each swap.
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
      // Cubism UV v is bottom-origin (v=0 bottom of the PNG), so the top of the
      // canvas rect corresponds to the largest v (v0 + h). Verified against the
      // atlas: this lands exactly on the baked garment region. (The runtime's
      // vertexUvs are v-flipped relative to the raw moc3 floats - don't "fix"
      // this to r.v0 * H; that mirrors every override into the wrong place.)
      active.push({ id, entry, x: r.u0 * W, yTop: (1 - (r.v0 + r.h)) * H, w: r.w * W, h: r.h * H });
    }
    // Two passes: erase everything first, then paint. Interleaving them lets
    // one drawable's clear wipe art another override just painted into an
    // overlapping atlas rect (the limb Attach* rects overlap heavily), which
    // shows up as transparent holes on the model.
    for (const a of active) {
      if (a.entry.fullClear) {
        // Erase the whole UV rect, NOT clipped to the mesh, and pad it by a
        // few texels: the baked Moddable*Logo placeholder (red grid + "LOGO")
        // extends past the drawable's UV rect, and texels just outside the
        // rect bleed into the render through bilinear edge sampling (the red
        // box outline). Only safe for rects surrounded by placeholder art -
        // shared-texel regions must keep the clipped paths below.
        const p = 8;
        ctx.clearRect(a.x - p, a.yTop - p, a.w + 2 * p, a.h + 2 * p);
        continue;
      }
      if (a.entry.overlay) continue;   // decorations paint on top of the base
      ctx.save();
      ctx.clip(meshPath(a.id, W, H));
      if (a.entry.alphaClip) {
        // Erase only where the variant art has coverage: these rects share
        // texels with drawables that are NOT overridden (e.g. base skin), so a
        // full bounding-rect clear would punch transparent holes in those too.
        // Erase with a BINARIZED alpha mask, not the art itself: erasing with
        // the art attenuates base texels under semi-transparent pixels twice
        // (base*(1-a)^2 after the paint pass), which turns the art's soft
        // shadows (e.g. the mech knee joints) nearly black.
        if (!a.entry.mask) a.entry.mask = _alphaMask(a.entry.img);
        ctx.globalCompositeOperation = 'destination-out';
        ctx.drawImage(a.entry.mask, a.x, a.yTop, a.w, a.h);
        ctx.globalCompositeOperation = 'source-over';
      } else {
        // Full replacement (e.g. mini skirt): the whole baked region must go,
        // even where the new art is transparent.
        ctx.clearRect(a.x, a.yTop, a.w, a.h);
      }
      ctx.restore();
    }
    for (const a of active) {
      ctx.save();
      ctx.clip(meshPath(a.id, W, H));
      ctx.drawImage(a.entry.img, a.x, a.yTop, a.w, a.h);
      ctx.restore();
    }
    _uploadTexture(texIndex, c);
  }

  // Replace (url) or clear (null) a single drawable's atlas region, then rebake.
  // If overlay=true, the variant is painted on top of the base (for decorations).
  async function setDrawableTexture(drawableId, url, overlay) {
    const r = _uvRect.get(drawableId);
    if (!r) return;
    if (url) _texOverride.set(drawableId, { url, img: await _loadImg(url), overlay: !!overlay, alphaClip: false, fullClear: false });
    else _texOverride.delete(drawableId);
    recompositeTexture(r.tex);
  }

  // Batch form: map of { drawableId: { url, overlay, alphaClip, fullClear } | url | null }.
  // Recomposites each affected atlas once. Used by the outfit variant pickers.
  async function setDrawableTextures(map) {
    const texes = new Set();
    await Promise.all(Object.entries(map).map(async ([id, val]) => {
      const r = _uvRect.get(id);
      if (!r) return;
      // val can be a string (url), an object { url, overlay, alphaClip, fullClear }, or null.
      const url = val && typeof val === 'object' ? val.url : val;
      const overlay = val && typeof val === 'object' ? !!val.overlay : false;
      const alphaClip = val && typeof val === 'object' ? !!val.alphaClip : false;
      const fullClear = val && typeof val === 'object' ? !!val.fullClear : false;
      // Skip no-op updates: callers re-send unchanged maps on every outfit
      // toggle, and a redundant recomposite redraws + re-uploads a whole 4k
      // atlas (a visible main-thread stall).
      const prev = _texOverride.get(id);
      if (url) {
        if (prev && prev.url === url && prev.overlay === overlay &&
            prev.alphaClip === alphaClip && prev.fullClear === fullClear) return;
        _texOverride.set(id, { url, img: await _loadImg(url), overlay, alphaClip, fullClear });
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

  // Force a drawable's opacity independent of the rig. op=null clears the
  // override; op=0 hides. Used for items (e.g. shoes) whose on/off parameter
  // isn't wired to the drawable's opacity in this moc3.
  function setDrawableOpacity(id, op) {
    if (publicTint) publicTint.setOpacity(id, op);
  }

  // Replace the active draw-order overrides: array of [belowId, aboveId] pairs
  // (each pair guarantees `below` renders under `above`). [] clears.
  function setDrawableOrderBelow(pairs) {
    if (publicTint) publicTint.setOrderBelow(pairs);
  }
  function opacityByPattern(includes, excludes, op) {
    const ids = findDrawables(includes, excludes);
    for (const id of ids) setDrawableOpacity(id, op);
    return ids;
  }

  // Topmost visible drawable under a client-space point (point-in-triangle over
  // the drawable meshes, highest renderOrder wins). `onlyIds` restricts the
  // search to a set of drawable ids (e.g. the currently worn clothing).
  function drawableAt(clientX, clientY, onlyIds) {
    if (!model || !raw || !app) return null;
    const rect = app.view.getBoundingClientRect();
    const p = model.toModelPosition(new PIXI.Point(clientX - rect.left, clientY - rect.top));
    // toModelPosition yields model-canvas pixels (y down); vertexPositions are
    // in Cubism unit space (origin-centered, y up). Convert before hit-testing.
    const ci = raw.canvasinfo;
    p.x = (p.x - ci.CanvasOriginX) / ci.PixelsPerUnit;
    p.y = (ci.CanvasOriginY - p.y) / ci.PixelsPerUnit;
    const D = raw.drawables;
    const only = onlyIds ? (onlyIds instanceof Set ? onlyIds : new Set(onlyIds)) : null;
    let best = null, bestOrder = -Infinity;
    for (let i = 0; i < D.count; i++) {
      if (only && !only.has(D.ids[i])) continue;
      const forcedOpacity = forcedDrawableOpacity.get(D.ids[i]);
      const opacity = forcedOpacity == null ? D.opacities[i] : forcedOpacity;
      // Force-shown wardrobe layers can be invisible to the raw rig but still
      // render because the renderer restores their visibility flag every frame.
      const visible = (D.dynamicFlags[i] & 0x01) || (forcedOpacity != null && forcedOpacity > 0.0001);
      if (!visible || opacity < 0.01) continue;
      if (D.renderOrders[i] <= bestOrder) continue;
      const vp = D.vertexPositions[i], ix = D.indices[i];
      for (let k = 0; k < ix.length; k += 3) {
        const a = ix[k] * 2, b = ix[k + 1] * 2, c = ix[k + 2] * 2;
        const s1 = (vp[b] - vp[a]) * (p.y - vp[a + 1]) - (vp[b + 1] - vp[a + 1]) * (p.x - vp[a]);
        const s2 = (vp[c] - vp[b]) * (p.y - vp[b + 1]) - (vp[c + 1] - vp[b + 1]) * (p.x - vp[b]);
        const s3 = (vp[a] - vp[c]) * (p.y - vp[c + 1]) - (vp[a + 1] - vp[c + 1]) * (p.x - vp[c]);
        if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) {
          best = D.ids[i]; bestOrder = D.renderOrders[i]; break;
        }
      }
    }
    return best;
  }

  // Thumbnail of a drawable's atlas region (the same UV rect the variant
  // compositor uses), as a data URL scaled to fit `size`. Used by the wardrobe.
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
    startLoop,
    stopLoop,
    stopAllLoops,
    scheduleSequence,
    resetIdle,
    startIdle,
    stopIdle,
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
    drawableAt,
    drawableThumb,
  };
})();
