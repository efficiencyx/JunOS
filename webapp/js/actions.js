// Action parser + resolver.
// Parses [ACTION:name|key=value|...] from LLM stream and dispatches to Live2D.

window.Actions = (function () {
  let actionMap = null;
  let onLog = null; // (level, text), level is 'ok' | 'warn' | 'err'
  // Kwarg keys that can select a sub-node in the action map, in priority order.
  const NAV_KEYS = ['target','dir','type','shape','emotion','side','state','speed','style','item','enable','gesture','duration'];

  async function load(url) {
    const res = await fetch(url);
    actionMap = await res.json();
  }

  function setLogger(cb) { onLog = cb; }
  function log(level, msg) { if (onLog) onLog(level, msg); }

  // Matches [ACTION:name] or [ACTION:name|k=v|k=v]
  const ACTION_RE = /\[\s*ACTION\s*:\s*([a-zA-Z_][\w]*)\s*((?:\|[^=\]|]+=[^|\]]*)*)\s*\]/gi;

  function parseActions(text) {
    const actions = [];
    let m;
    ACTION_RE.lastIndex = 0;
    while ((m = ACTION_RE.exec(text)) !== null) {
      const name = m[1];
      const kwargs = {};
      const tail = m[2] || '';
      const parts = tail.split('|').filter(p => p.length > 0);
      for (const p of parts) {
        const eq = p.indexOf('=');
        if (eq < 0) continue;
        const k = p.slice(0, eq).trim();
        const v = p.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        kwargs[k] = v;
      }
      actions.push({ name, kwargs, raw: m[0], index: m.index, end: m.index + m[0].length });
    }
    return actions;
  }

  function stripActions(text) {
    return text.replace(ACTION_RE, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  }

  function isEffectNode(node) {
    if (!node || typeof node !== 'object') return false;
    for (const k of Object.keys(node)) {
      if (k.startsWith('Param') || k === '_sequence' || k === '_loop' || k === '_loop_param'
          || k === '_compose' || k === '_resolve' || k === '_param') return true;
    }
    return false;
  }

  // Resolve "path.subpath" used by _compose (e.g. "brow.happy", "mouth.smile").
  function lookupPath(path) {
    const tokens = path.split('.');
    let cur = actionMap;
    for (const t of tokens) {
      if (cur && typeof cur === 'object' && t in cur) cur = cur[t];
      else return null;
    }
    return cur;
  }

  function resolveResolve(resolveDict, kwargs) {
    // Resolve-key candidates, NAV_KEYS first (in priority order) then the rest.
    const valuesInOrder = [];
    for (const navKey of NAV_KEYS) {
      if (kwargs[navKey] !== undefined) valuesInOrder.push(kwargs[navKey]);
    }
    for (const k of Object.keys(kwargs)) {
      if (!NAV_KEYS.includes(k) && !valuesInOrder.includes(kwargs[k])) valuesInOrder.push(kwargs[k]);
    }

    if (valuesInOrder.length) {
      const joined = valuesInOrder.join('.');
      if (joined in resolveDict) return resolveDict[joined];
      // single-value resolves, e.g. "on" / "off"
      for (const v of valuesInOrder) {
        if (v in resolveDict) return resolveDict[v];
      }
      if (valuesInOrder.length >= 2) {
        const rev = [...valuesInOrder].reverse().join('.');
        if (rev in resolveDict) return resolveDict[rev];
      }
    }

    // Last resort: any key whose tokens are all present among the kwarg values.
    const valSet = new Set(valuesInOrder);
    for (const key of Object.keys(resolveDict)) {
      const toks = key.split('.');
      if (toks.every(t => valSet.has(t))) return resolveDict[key];
    }
    return null;
  }

  // Containers searched when a bare action name isn't a top-level key
  // (LLM tends to emit [ACTION:smile] instead of [ACTION:mouth|shape=smile]).
  const FALLBACK_CONTAINERS = ['mouth', 'emote', 'brow', 'look', 'lean', 'tail_wiggle', 'breath'];

  function resolveAction(name, kwargs) {
    if (!actionMap) {
      log('warn', `azione sconosciuta: ${name}`);
      return null;
    }
    let node = actionMap[name];
    if (node === undefined) {
      for (const container of FALLBACK_CONTAINERS) {
        const parent = actionMap[container];
        if (parent && typeof parent === 'object' && name in parent) {
          node = parent[name];
          break;
        }
      }
      if (node === undefined) {
        log('warn', `azione sconosciuta: ${name}`);
        return null;
      }
    }
    // Drill into known navigation kwargs as long as a child key matches a kwarg value.
    let safety = 5;
    while (safety-- > 0 && node && typeof node === 'object' && !isEffectNode(node)) {
      let advanced = false;
      for (const navKey of NAV_KEYS) {
        const v = kwargs[navKey];
        if (v !== undefined && v in node) { node = node[v]; advanced = true; break; }
      }
      if (!advanced) break;
    }
    if (node && typeof node === 'object' && node._resolve) {
      const { _resolve, ...rest } = node;
      if (!isEffectNode(rest)) {
        const resolved = resolveResolve(_resolve, kwargs);
        if (!resolved) {
          log('warn', `nessun match _resolve per ${name} ${JSON.stringify(kwargs)}`);
          return null;
        }
        node = resolved;
      }
    }
    if (!node || typeof node !== 'object') {
      log('warn', `azione non risolta: ${name} ${JSON.stringify(kwargs)}`);
      return null;
    }
    return node;
  }

  function scaleFactor(node, kwargs) {
    if (!node._scale || !Array.isArray(node._scale)) return 1;
    let f = 1;
    for (const k of node._scale) {
      const v = parseFloat(kwargs[k]);
      if (!isNaN(v)) f *= v;
    }
    return f;
  }

  // Apply a resolved effect node to Live2D.
  function applyNode(node, kwargs, depth) {
    if (depth > 4) return;
    if (!node || typeof node !== 'object') return;

    const scale = scaleFactor(node, kwargs);

    // _compose runs the referenced actions first.
    if (Array.isArray(node._compose)) {
      for (const path of node._compose) {
        const sub = lookupPath(path);
        if (sub) applyNode(sub, kwargs, depth + 1);
        else log('warn', `compose path mancante: ${path}`);
      }
    }

    // _param sets a single named parameter to the scale value. The _relative
    // flag is currently a no-op: without param read-back there's nothing to add
    // a delta to, so relative and absolute behave the same here.
    if (node._param) {
      Live2D.setTarget(node._param, scale);
    }

    for (const [k, v] of Object.entries(node)) {
      if (!k.startsWith('Param')) continue;
      if (typeof v !== 'number') continue;
      Live2D.setTarget(k, v * scale);
    }

    if (node._loop_param) {
      const amp = (node._amplitude !== undefined ? node._amplitude : 0.5) * (scale || 1);
      const per = node._period_ms || 1500;
      Live2D.startLoop(node._loop_param, amp, per);
    }

    if (Array.isArray(node._sequence)) {
      const steps = sequenceToSteps(node._sequence, scale);
      Live2D.scheduleSequence(steps);
    }

    // _loop + _repeats: expand the loop body into one long sequence (e.g. mouth speak).
    if (Array.isArray(node._loop)) {
      const repeats = node._repeats || 3;
      const steps = [];
      for (let r = 0; r < repeats; r++) steps.push(...sequenceToSteps(node._loop, scale));
      Live2D.scheduleSequence(steps);
    }
  }

  function sequenceToSteps(seq, scale) {
    const steps = [];
    for (const step of seq) {
      const dt = step._t || 100;
      const params = {};
      for (const [k, v] of Object.entries(step)) {
        if (k === '_t') continue;
        if (!k.startsWith('Param')) continue;
        if (typeof v === 'number') params[k] = v * (scale || 1);
      }
      steps.push({ params, dt_ms: dt });
    }
    return steps;
  }

  function applyAction({ name, kwargs }) {
    const node = resolveAction(name, kwargs);
    if (!node) return;
    applyNode(node, kwargs, 0);
    if (window.Outfit && Outfit.syncFromAction) Outfit.syncFromAction(name, kwargs);
    const k = Object.keys(kwargs).map(x => `${x}=${kwargs[x]}`).join('|');
    log('ok', `▶ ${name}${k ? '|' + k : ''}`);
  }

  return { load, parseActions, stripActions, applyAction, setLogger };
})();
