// Touch you start on the model yourself: head pat, hand hold, face rub.

window.ModelTouch = (function () {
  let sendEvent = null;
  let isBusy = () => false;
  let onTouch = null;

  let regions = null;
  let active = null;
  let pending = null;
  let tickTimer = null;
  let cooldownUntil = 0;

  const TOUCH_HOLD_MS = 180;
  const TOUCH_DRAG_THRESHOLD = 8;
  const NOTIFY_INTERVAL_MS = 2000;
  const NOTIFY_CHANCE = 0.2;
  const COOLDOWN_MS = 10000;

  const HIT_FACE = new Set(['HitAreaFaceStroke']);
  const HIT_HEAD = new Set(['HitAreaHeadpat']);
  const HIT_BOOB_L = new Set(['HitAreaBoobL']);
  const HIT_BOOB_R = new Set(['HitAreaBoobR']);

  function buildRegions() {
    const hand = Live2D.findDrawables(['armlhand', 'armrhand'], []);
    const skirt = Live2D.findDrawables(['skirt'], []);
    return hand.length ? { hand: new Set(hand), skirt: new Set(skirt) } : null;
  }

  function classify(clientX, clientY) {
    if (!regions) regions = buildRegions();
    if (!regions) return null;
    const hand = Live2D.drawableAt(clientX, clientY, regions.hand, 12);
    if (hand) {
      return { kind: 'hand', side: hand.toLowerCase().includes('armlhand') ? 'left' : 'right' };
    }
    if (Live2D.hitTest(clientX, clientY, HIT_FACE)) return { kind: 'face' };
    if (Live2D.hitTest(clientX, clientY, HIT_HEAD)) return { kind: 'head' };
    if (Live2D.hitTest(clientX, clientY, HIT_BOOB_L)) return { kind: 'boob', side: 'left' };
    if (Live2D.hitTest(clientX, clientY, HIT_BOOB_R)) return { kind: 'boob', side: 'right' };
    if (Live2D.drawableAt(clientX, clientY, regions.skirt, 8)) return { kind: 'skirt' };
    return null;
  }

  function isInteractiveTarget(t) {
    return !!(t && t.closest && t.closest(
      'button, a, input, textarea, select, .composer, .conv-sidebar, .settings-drawer, .app-header, .prompt-chips, .wardrobe-overlay, .face-bubble, .sidebar-backdrop'
    ));
  }

  function eventText(kind, side) {
    if (kind === 'head') return "*pats Jun's head*";
    if (kind === 'face') return "*rubs Jun's cheek*";
    if (kind === 'boob') return `*fondles Jun's ${side} breast*`;
    if (kind === 'skirt') return "*lifts Jun's skirt*";
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
      ox: 0,
      oy: 0,
    };
    if (kind === 'head') {
      Actions.applyAction({ name: 'receive_headpat', kwargs: {} });
      Live2D.setTarget('ParamHeadpat', 1);
    } else if (kind === 'face') {
      Live2D.setTarget('ParamFaceRubEnable', 1);
    } else if (kind === 'boob') {
      active.sq = 0;
      Live2D.setTarget(side === 'left' ? 'ParamEnableBoobFondleL' : 'ParamEnableBoobFondleR', 1);
      // No param turns the MC hand meshes on, so set the drawable ourselves.
      Live2D.setDrawableOpacity(side === 'left' ? 'MCRightHandFondle' : 'MCLeftHandFondle', 1);
    } else if (kind === 'skirt') {
      active.lift = Live2D.debugParam('ParamSkirtUp').current || 0;
    } else {
      Actions.applyAction({ name: 'handhold', kwargs: { side, enable: 'true' } });
    }
    document.body.classList.add('l2d-touching');
    tickTimer = setInterval(tick, 250);
    if (onTouch) onTouch();
    tryNotify(performance.now());
  }

  function cancelPending() {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending = null;
    document.body.classList.remove('l2d-touch-pending');
  }

  function tryNotify(now) {
    if (!active || !sendEvent || isBusy() || now < cooldownUntil) return;
    cooldownUntil = now + COOLDOWN_MS;
    sendEvent(eventText(active.kind, active.side));
  }

  function end() {
    if (!active) return;
    const { kind, side } = active;
    if (kind === 'head') {
      Live2D.cancelPending('ParamHeadpat');
      // ParamHeadpat rests at -1. at 0 the hand is still half shown.
      Live2D.setNow('ParamHeadpat', -1);
      Live2D.setNow('ParamHeadpatX', 0);
      Live2D.setNow('ParamHeadpatY', 0);
      Live2D.setTarget('ParamHeadZ', 0);
    } else if (kind === 'face') {
      Live2D.setTarget('ParamFaceRubMoveX', 0);
      Live2D.setTarget('ParamFaceRubEnable', 0);
    } else if (kind === 'boob') {
      const s = side === 'left' ? 'L' : 'R';
      Live2D.setTarget('ParamBoobSqueeze' + s, 0);
      Live2D.setTarget('ParamPhysicsBoobX' + s, 0);
      Live2D.setTarget('ParamEnableBoobFondle' + s, 0);
      Live2D.setDrawableOpacity(side === 'left' ? 'MCRightHandFondle' : 'MCLeftHandFondle', null);
    } else if (kind === 'skirt') {
      Live2D.setTarget('ParamSkirtUp', active.lift > 0.6 ? 1 : 0);
    } else {
      Actions.applyAction({ name: 'handhold', kwargs: { side, enable: 'false' } });
    }
    active = null;
    document.body.classList.remove('l2d-touching');
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
      if (active.kind === 'face') Live2D.setTarget('ParamFaceRubMoveX', 0);
      if (active.kind === 'boob' && active.sq > 0) {
        active.sq = Math.max(0, active.sq - 0.15);
        const s = active.side === 'left' ? 'L' : 'R';
        Live2D.setTarget('ParamBoobSqueeze' + s, active.sq);
        Live2D.setTarget('ParamPhysicsBoobX' + s, 0);
      }
    }

    if (active.heldMs >= NOTIFY_INTERVAL_MS) {
      active.heldMs -= NOTIFY_INTERVAL_MS;
      if (Math.random() < NOTIFY_CHANCE) tryNotify(now);
    }
  }

  function onPointerMove(e) {
    if (pending && e.pointerId === pending.pointerId) {
      pending.lastX = e.clientX;
      pending.lastY = e.clientY;
      if (Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY) > TOUCH_DRAG_THRESHOLD) {
        cancelPending();
      }
      return;
    }
    if (!active || e.pointerId !== active.pointerId) return;
    e.preventDefault();
    const now = performance.now();
    active.lastMoveAt = now;
    if (active.kind === 'head') {
      active.ox = Math.max(-1, Math.min(1, active.ox + (e.clientX - active.lastX) * 0.02));
      active.oy = Math.max(-1, Math.min(1, active.oy + (active.lastY - e.clientY) * 0.02));
      Live2D.setTarget('ParamHeadpatX', active.ox);
      Live2D.setTarget('ParamHeadpatY', active.oy);
      Live2D.setTarget('ParamHeadZ', active.ox * 0.5);
    } else if (active.kind === 'face') {
      const dx = e.clientX - active.lastX;
      Live2D.setTarget('ParamFaceRubMoveX', Math.max(-1, Math.min(1, dx * 0.08)));
    } else if (active.kind === 'boob') {
      const dx = e.clientX - active.lastX;
      const dy = e.clientY - active.lastY;
      active.sq = Math.min(1, active.sq + (Math.abs(dx) + Math.abs(dy)) * 0.015);
      const s = active.side === 'left' ? 'L' : 'R';
      Live2D.setTarget('ParamBoobSqueeze' + s, active.sq);
      Live2D.setTarget('ParamPhysicsBoobX' + s, Math.max(-1, Math.min(1, dx * 0.08)));
    } else if (active.kind === 'skirt') {
      active.lift = Math.max(0, Math.min(1, active.lift + (active.lastY - e.clientY) * 0.01));
      Live2D.setTarget('ParamSkirtUp', active.lift);
    }
    active.lastY = e.clientY;
    active.lastX = e.clientX;
  }

  function onPointerEnd(e) {
    if (pending && e.pointerId === pending.pointerId) {
      cancelPending();
      return;
    }
    if (!active || e.pointerId !== active.pointerId) return;
    end();
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    if (active || pending) return;
    if (!window.Live2D || !window.Actions) return;
    if (document.body.classList.contains('wardrobe-open')) return;
    if (document.body.classList.contains('sidebar-open')) return;
    if (isInteractiveTarget(e.target)) return;
    if (!Live2D.isOverModel(e.clientX, e.clientY)) return;
    const hit = classify(e.clientX, e.clientY);
    if (!hit) return;
    if (e.pointerType === 'touch') {
      pending = {
        kind: hit.kind,
        side: hit.side,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        timer: 0,
      };
      document.body.classList.add('l2d-touch-pending');
      pending.timer = setTimeout(() => {
        const gesture = pending;
        if (!gesture) return;
        pending = null;
        document.body.classList.remove('l2d-touch-pending');
        begin(gesture.kind, gesture.side, {
          pointerId: gesture.pointerId,
          clientX: gesture.lastX,
          clientY: gesture.lastY,
        });
      }, TOUCH_HOLD_MS);
      return;
    }
    e.preventDefault();
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

  return { init };
})();
