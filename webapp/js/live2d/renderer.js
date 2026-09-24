import { app, forcedDrawableOpacity, markDirty, model, raw, setPublicTint } from './state.js?v=11';

const drawableHighlights = new Map();

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
  // scale screen colors by alpha. without it transparent
  // texels get colored too.
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

export function installColorShaderPatch(gl) {
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

// pixi-live2d-display 0.4 ignores drawable colours, opacity
// overrides and draw order, so the renderer gets patched to
// apply ours on every draw. also publishes the setters
// (publicTint) the tint/opacity helpers in textures.js go
// through, and the __l2d console toy.
export function patchRenderer() {
  let forcedOrderBelow = [];
  const forcedMultiplyColor = new Map();
  const forcedScreenColor = new Map();
  const r = model.internalModel.renderer;
  const gl = app.renderer.gl;
  const ONE = [1, 1, 1, 1];
  const ZERO = [0, 0, 0, 1];
  const uniformLocCache = new WeakMap();

  if (r && r.doDrawModel && r.drawMesh && !r.__omegaPatched) {
    r.__omegaPatched = true;

    const drawableByVertices = new Map();
    for (let i = 0; i < raw.drawables.count; i++) {
      drawableByVertices.set(raw.drawables.vertexPositions[i], raw.drawables.ids[i]);
    }
    let currentDrawableId = null;

    const origDoDrawModel = r.doDrawModel.bind(r);
    r.doDrawModel = function () {
      const d = raw.drawables;
      if (d && d.opacities && forcedDrawableOpacity.size) {
        for (const [id, op] of forcedDrawableOpacity) {
          const i = d.ids.indexOf(id);
          if (i < 0) continue;
          d.opacities[i] = op;
          // put back the visibility Cubism clears on zero opacity outfits
          if (op > 0.0001) d.dynamicFlags[i] |= 0x01;
        }
      }
      // do the overrides before our sort and Cubism's sort both run
      if (d && forcedOrderBelow.length) {
        const ro = d.renderOrders;
        for (const [below, above] of forcedOrderBelow) {
          const bi = d.ids.indexOf(below), ai = d.ids.indexOf(above);
          if (bi >= 0 && ai >= 0 && ro[bi] > ro[ai]) {
            const t = ro[bi]; ro[bi] = ro[ai]; ro[ai] = t;
          }
        }
      }
      return origDoDrawModel();
    };

    const origDrawMesh = r.drawMesh.bind(r);
    r.drawMesh = function () {
      const isMaskPass = !!r._clippingContextBufferForMask;
      if (!isMaskPass) {
        currentDrawableId = drawableByVertices.get(arguments[4]) || null;
      } else {
        currentDrawableId = null;
      }
      try {
        return origDrawMesh.apply(this, arguments);
      } finally {
        currentDrawableId = null;
      }
    };

    // Cubism binds its shader inside drawMesh, so set the uniforms
    // there
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

  setPublicTint({
    setMultiply(drawableId, rgb) {
      if (rgb) forcedMultiplyColor.set(drawableId, [rgb[0], rgb[1], rgb[2], 1]);
      else forcedMultiplyColor.delete(drawableId);
      markDirty();
    },
    getMultiply(drawableId) {
      const c = forcedMultiplyColor.get(drawableId);
      return c ? [c[0], c[1], c[2]] : null;
    },
    setScreen(drawableId, rgb) {
      if (rgb) forcedScreenColor.set(drawableId, [rgb[0], rgb[1], rgb[2], 1]);
      else forcedScreenColor.delete(drawableId);
      markDirty();
    },
    setHighlight(drawableId, rgb) {
      if (rgb) drawableHighlights.set(drawableId, [rgb[0], rgb[1], rgb[2]]);
      else drawableHighlights.delete(drawableId);
      markDirty();
    },
    setOpacity(drawableId, op) {
      if (op == null) forcedDrawableOpacity.delete(drawableId);
      else forcedDrawableOpacity.set(drawableId, op);
      markDirty();
    },
    listDrawables() { return Array.from(raw.drawables.ids); },
    setOrderBelow(pairs) { forcedOrderBelow = pairs || []; markDirty(); },
  });

  window.__l2d = {
    model, raw,
    hide(name) { forcedDrawableOpacity.set(name, 0); markDirty(); },
    show(name) { forcedDrawableOpacity.delete(name); markDirty(); },
    hideAll() { for (const id of raw.drawables.ids) forcedDrawableOpacity.set(id, 0); markDirty(); },
    showAll() { forcedDrawableOpacity.clear(); markDirty(); },
    listDrawables() { return Array.from(raw.drawables.ids); },
    hideRange(from, to) {
      const ids = raw.drawables.ids;
      for (let i = from; i < to && i < ids.length; i++) forcedDrawableOpacity.set(ids[i], 0);
      markDirty();
    },
    visibleDrawables() {
      const out = [];
      const ops = raw.drawables.opacities, ids = raw.drawables.ids;
      for (let i = 0; i < raw.drawables.count; i++) if (ops[i] > 0.01) out.push([ids[i], ops[i]]);
      return out;
    },
    tint(name, rgb) { forcedMultiplyColor.set(name, [rgb[0], rgb[1], rgb[2], 1]); markDirty(); },
    untint(name) { forcedMultiplyColor.delete(name); markDirty(); },
    screenTint(name, rgb) { forcedScreenColor.set(name, [rgb[0], rgb[1], rgb[2], 1]); markDirty(); },
    unscreen(name) { forcedScreenColor.delete(name); markDirty(); },
  };
}
