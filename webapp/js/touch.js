// User-initiated touch on the model: head pat, hand hold, face rub.

window.ModelTouch = (function () {
  let sendEvent = null;
  let isBusy = () => false;
  let onTouch = null;

  let regions = null;
  let active = null;
  let tickTimer = null;
  let cooldownUntil = 0;
  let pendingCooldown = false;

  const NOTIFY_INTERVAL_MS = 2000;
  const NOTIFY_CHANCE = 0.2;
  const COOLDOWN_MS = 10000;

  function buildRegions() {
    const head = Live2D.findDrawables(
      ['h0_', 'h1_', 'h2_', 'h3_', 'h4_', 'hair', 'catear', 'pointyear'],
      ['hairhologram']
    );
    const face = Live2D.findDrawables(['moddableface'], []);
    const hand = Live2D.findDrawables(['hand'], ['handholding']);
    if (!head.length && !face.length && !hand.length) return null;
    return { head: new Set(head), face: new Set(face), hand: new Set(hand) };
  }

  function classify(clientX, clientY) {
    if (!regions) regions = buildRegions();
    if (!regions) return null;
    const id = Live2D.drawableAt(clientX, clientY);
    if (!id) return null;
    if (regions.hand.has(id)) {
      const lo = id.toLowerCase();
      return { kind: 'hand', side: (lo.includes('arml') || lo.includes('mchandl')) ? 'left' : 'right' };
    }
    if (regions.head.has(id)) return { kind: 'head' };
    if (regions.face.has(id)) return { kind: 'face' };
    return null;
  }

  function isInteractiveTarget(t) {
    return !!(t && t.closest && t.closest(
      'button, a, input, textarea, select, .composer, .conv-sidebar, .settings-drawer, .app-header, .prompt-chips, .wardrobe-overlay'
    ));
  }

  function eventText(kind, side) {
    if (kind === 'head') return "*pats Jun's head*";
    if (kind === 'face') return "*rubs Jun's cheek*";
    return `*holds Jun's ${side} hand*`;
  }

  function begin(kind, side, e) {
    active = {
      kind, side,
      pointerId: e.pointerId,
      lastY: e.clientY,
      lastX: e.clientX,
      lastMoveAt: 0,
      startedAt: performance.now(),
      heldMs: 0,
      lastTickAt: performance.now(),
      lastPatReplay: performance.now(),
    };
    if (kind === 'head') {
      Actions.applyAction({ name: 'receive_headpat', kwargs: {} });
      Live2D.setTarget('ParamHeadpat', 1);
    } else if (kind === 'face') {
      Live2D.setTarget('ParamFaceRubEnable', 1);
    } else {
      Actions.applyAction({ name: 'handhold', kwargs: { side, enable: 'true' } });
    }
    tickTimer = setInterval(tick, 250);
    if (onTouch) onTouch();
  }

  function end() {
    if (!active) return;
    const { kind, side } = active;
    if (kind === 'head') {
      Live2D.setTarget('ParamHeadpat', 0);
      Live2D.setTarget('ParamHeadpatY', 0);
    } else if (kind === 'face') {
      Live2D.setTarget('ParamFaceRubMoveX', 0);
      Live2D.setTarget('ParamFaceRubEnable', 0);
    } else {
      Actions.applyAction({ name: 'handhold', kwargs: { side, enable: 'false' } });
    }
    active = null;
    clearInterval(tickTimer);
    tickTimer = null;
  }

  function tick() {
    if (!active) return;
    const now = performance.now();
    active.heldMs += now - active.lastTickAt;
    active.lastTickAt = now;
    if (onTouch) onTouch();

    if (now - active.lastMoveAt > 400) {
      if (active.kind === 'head') Live2D.setTarget('ParamHeadpatY', 0);
      if (active.kind === 'face') Live2D.setTarget('ParamFaceRubMoveX', 0);
    }
    if (active.kind === 'head' && now - active.lastPatReplay > 800) {
      active.lastPatReplay = now;
      Actions.applyAction({ name: 'receive_headpat', kwargs: {} });
      Live2D.setTarget('ParamHeadpat', 1);
    }

    if (active.heldMs >= NOTIFY_INTERVAL_MS) {
      active.heldMs -= NOTIFY_INTERVAL_MS;
      if (Math.random() < NOTIFY_CHANCE && !isBusy() && now >= cooldownUntil && sendEvent) {
        pendingCooldown = true;
        sendEvent(eventText(active.kind, active.side));
      }
    }
  }

  function onPointerMove(e) {
    if (!active || e.pointerId !== active.pointerId) return;
    const now = performance.now();
    active.lastMoveAt = now;
    if (active.kind === 'head') {
      const dy = e.clientY - active.lastY;
      Live2D.setTarget('ParamHeadpatY', Math.max(-1, Math.min(1, -dy * 0.08)));
    } else if (active.kind === 'face') {
      const dx = e.clientX - active.lastX;
      Live2D.setTarget('ParamFaceRubMoveX', Math.max(-1, Math.min(1, dx * 0.08)));
    }
    active.lastY = e.clientY;
    active.lastX = e.clientX;
  }

  function onPointerEnd(e) {
    if (!active || e.pointerId !== active.pointerId) return;
    end();
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    if (active) return;
    if (!window.Live2D || !window.Actions) return;
    if (document.body.classList.contains('wardrobe-open')) return;
    if (isInteractiveTarget(e.target)) return;
    if (!Live2D.isOverModel(e.clientX, e.clientY)) return;
    const hit = classify(e.clientX, e.clientY);
    if (!hit) return;
    e.stopImmediatePropagation();
    begin(hit.kind, hit.side, e);
  }

  function init(opts) {
    sendEvent = opts.sendEvent || null;
    if (opts.isBusy) isBusy = opts.isBusy;
    onTouch = opts.onTouch || null;
    window.addEventListener('pointerdown', onPointerDown, { capture: true });
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);
  }

  function onReplyDone() {
    if (!pendingCooldown) return;
    pendingCooldown = false;
    cooldownUntil = performance.now() + COOLDOWN_MS;
  }

  return { init, onReplyDone };
})();
