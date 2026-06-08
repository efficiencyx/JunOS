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
    const helper = '\nvec4 omegaTint(vec4 c) {\n'
      + '  c.rgb = c.rgb * u_multiplyColor.rgb;\n'
      + '  c.rgb = c.rgb + u_screenColor.rgb - c.rgb * u_screenColor.rgb;\n'
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

  async function init({ stageEl, onStatus }) {
    onStatus = onStatus || (() => {});
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
      fetchAsDataURL('assets/00_texture_00.png', 'image/png'),
      fetchAsDataURL('assets/01_texture_01.png', 'image/png'),
      fetchAsDataURL('assets/02_texture_02.png', 'image/png'),
    ]);
    const TRANSPARENT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';
    const textures = [t0, t1, t2];
    while (textures.length < 8) textures.push(TRANSPARENT);

    // Cubism textures are straight-alpha; PIXI 6 default (UNPACK) premultiplies on
    // upload, producing dark fringes around eye/mouth alpha edges. Preload each URL
    // as a BaseTexture with alphaMode = NPM so pixi-live2d-display hits the cache.
    for (const url of textures) {
      PIXI.BaseTexture.from(url, {
        alphaMode: PIXI.ALPHA_MODES.UNPACK,
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
    try { im.motionManager.stopAllMotions(); } catch (e) {}
    try { im.motionManager.update = () => false; } catch (e) {}
    try { if (im.motionManager.expressionManager) im.motionManager.expressionManager.update = () => false; } catch (e) {}
    im.breath = null;
    im.eyeBlink = null;
    im.physics = null;
    im.pose = null;
    im.focusController = { update: () => {}, focus: () => {}, x: 0, y: 0 };

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

    loadPos();
    fitModel();
    window.addEventListener('resize', fitModel);

    // Zoom (shift+wheel) / vertical pan (wheel) while the pointer is over her.
    // The canvas is click-through, so we listen on the window and hit-test.
    window.addEventListener('wheel', (e) => {
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
    const clothingParams = ['ParamShirtEnabled','ParamBraEnabled','ParamPantiesEnabled','ParamSkirtEnabled','ParamHoodieEnabled','ParamPantsEnabled','ParamDress2Enabled','ParamShoeLOn','ParamShoeROn'];
    const info = {};
    for (const p of clothingParams) {
      if (paramIndex.has(p)) info[p] = { min: paramMin.get(p), max: paramMax.get(p), def: paramDefault.get(p) };
      else info[p] = 'MISSING from model';
    }
    console.log('[Live2D] clothing params:', info);

    // Render-time hooks: forced opacity + per-drawable color uniforms.
    const forcedDrawableOpacity = new Map(); // drawableId -> opacity
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
            if (i >= 0) d.opacities[i] = op;
          }
        }
        visibleOrder.length = 0;
        if (d) {
          const tmp = [];
          for (let i = 0; i < d.count; i++) {
            const visible = (d.dynamicFlags[i] & 0x01) !== 0;
            if (visible && d.opacities[i] > 0.0001) tmp.push(i);
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
            const sc = (currentDrawableId && forcedScreenColor.get(currentDrawableId)) || ZERO;
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
      listDrawables() { return Array.from(raw.drawables.ids); },
    };

    window.__l2d = { model, raw,
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

    onStatus(`OK — ${raw.parameters.count} params, ${raw.parts.count} parts`);
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
      'button, a, input, textarea, select, .composer, .conv-sidebar, .settings-drawer, .app-header, .prompt-chips'
    ));
  }

  function savePos() {
    try {
      localStorage.setItem('l2d.pos', JSON.stringify({ x: userOffsetX, y: userOffsetY, z: userZoom }));
    } catch (e) {}
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
    } catch (e) {}
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
  // intentionally NOT here — those should reset along with the body pose.
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
    { kind: 'loop', param: 'ParamTailWiggle', amp: 0.5, period: 900,  duration: 2400 },
    { kind: 'loop', param: 'ParamEarsWiggle', amp: 0.4, period: 700,  duration: 1400 },
    { kind: 'loop', param: 'ParamHeadX',      amp: 1.2, period: 4200, duration: 4200 },
    { kind: 'loop', param: 'ParamHeadY',      amp: 0.8, period: 3800, duration: 3800 },
    { kind: 'loop', param: 'ParamEyeballLX',  amp: 0.3, period: 2600, duration: 2600, pair: 'ParamEyeballRX' },
    { kind: 'loop', param: 'ParamBodyX',      amp: 0.2, period: 5000, duration: 5000 },
    // Pose-and-return: shift a leg, raise an arm slightly, rotate an arm.
    { kind: 'pose', param: 'ParamLegL',   value: 0.35, hold: 1800 },
    { kind: 'pose', param: 'ParamLegR',   value: 0.35, hold: 1800 },
    { kind: 'pose', param: 'ParamLegL',   value: -0.25, hold: 1500 },
    { kind: 'pose', param: 'ParamLegR',   value: -0.25, hold: 1500 },
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

  function listDrawables() {
    return publicTint ? publicTint.listDrawables() : [];
  }

  function setDrawableTint(id, rgb) {
    if (publicTint) publicTint.setMultiply(id, rgb);
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
    debugParam,
    tintByPattern,
    findDrawables,
    listDrawables,
    setDrawableTint,
    setMouthOverride,
  };
})();
