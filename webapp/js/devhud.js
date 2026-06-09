// Floating developer HUD: live tokens/s + token counts from the chat stream, plus
// VRAM / model RAM / host RAM and the loaded model, polled from api/stats.php while
// open. Toggled from the Developer settings panel or Ctrl+Shift+D. Device-local —
// the visibility flag lives in localStorage and isn't synced across browsers.

window.DevHud = (function () {
  const STORAGE_KEY = 'omega.devhud.v1';
  const GEOM_KEY = 'omega.devhud.geom.v1';
  const POLL_MS = 3000;

  let root = null;        // the overlay element
  let fields = {};        // id -> value <span>
  let pollTimer = null;
  let visible = false;

  // Live per-generation counters (authoritative numbers arrive from the backend at
  // the end; until then we approximate tok/s from token events ourselves).
  let gen = { t0: 0, tFirst: 0, tokens: 0, final: null };

  function fmtBytes(n) {
    if (!n) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(n < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
  }

  function row(label, id) {
    return `<div class="devhud-row"><span class="devhud-k">${label}</span>` +
           `<span class="devhud-v" id="devhud-${id}">—</span></div>`;
  }

  function build() {
    root = document.createElement('div');
    root.id = 'devHud';
    root.className = 'devhud';
    root.hidden = true;
    root.innerHTML =
      '<div class="devhud-head"><span>dev</span>' +
      '<button class="devhud-close" title="Hide (Ctrl+Shift+D)" aria-label="Hide dev HUD">×</button></div>' +
      '<div class="devhud-body">' +
        row('tok/s', 'tps') +
        row('TTFT', 'ttft') +
        row('gen tok', 'gentok') +
        row('prompt tok', 'ptok') +
        row('context', 'ctx') +
        '<div class="devhud-sep"></div>' +
        row('VRAM', 'vram') +
        row('model RAM', 'mram') +
        row('host RAM', 'hram') +
        row('model', 'model') +
      '</div>';
    document.body.appendChild(root);
    root.querySelector('.devhud-close').addEventListener('click', () => set(false));
    fields = {};
    root.querySelectorAll('.devhud-v').forEach((el) => { fields[el.id.replace('devhud-', '')] = el; });

    restoreGeom();
    enableDrag(root.querySelector('.devhud-head'));
    // The CSS resize grip changes size directly; mirror the new size into storage.
    if (window.ResizeObserver) {
      new ResizeObserver(() => { if (visible && root.offsetWidth) saveGeom(); }).observe(root);
    }
  }

  // --- geometry (position + size) persistence ---

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(v, hi)); }

  function saveGeom() {
    const r = root.getBoundingClientRect();
    try {
      localStorage.setItem(GEOM_KEY, JSON.stringify({
        left: Math.round(r.left), top: Math.round(r.top),
        w: root.offsetWidth, h: root.offsetHeight,
      }));
    } catch (e) {}
  }

  function restoreGeom() {
    let g = null;
    try { g = JSON.parse(localStorage.getItem(GEOM_KEY) || 'null'); } catch (e) {}
    if (!g) return;
    // Switch from the CSS right-anchor to explicit left/top, kept on-screen.
    root.style.right = 'auto';
    root.style.left = clamp(g.left, 0, window.innerWidth - 60) + 'px';
    root.style.top = clamp(g.top, 0, window.innerHeight - 30) + 'px';
    if (g.w) root.style.width = g.w + 'px';
    if (g.h) root.style.height = g.h + 'px';
  }

  function enableDrag(handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0;
    function onMove(e) {
      const w = root.offsetWidth, h = root.offsetHeight;
      root.style.left = clamp(ox + (e.clientX - sx), 0, window.innerWidth - w) + 'px';
      root.style.top = clamp(oy + (e.clientY - sy), 0, window.innerHeight - h) + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      saveGeom();
    }
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('.devhud-close')) return;
      const r = root.getBoundingClientRect();
      root.style.right = 'auto';
      root.style.left = r.left + 'px';
      root.style.top = r.top + 'px';
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      e.preventDefault();
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function put(id, text) { if (fields[id]) fields[id].textContent = text; }

  function set(on) {
    visible = !!on;
    if (root) root.hidden = !visible;
    try { localStorage.setItem(STORAGE_KEY, visible ? '1' : '0'); } catch (e) {}
    const chk = document.getElementById('devHudChk');
    if (chk) chk.checked = visible;
    if (visible) { poll(); startPolling(); } else { stopPolling(); }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  async function poll() {
    try {
      const r = await fetch('api/stats.php', { cache: 'no-store' });
      if (!r.ok) return;
      const s = await r.json();
      put('vram', fmtBytes(s.vram_bytes));
      put('mram', fmtBytes(s.ram_model_bytes));
      if (s.host) {
        put('hram', `${fmtBytes(s.host.used)} / ${fmtBytes(s.host.total)}`);
      }
      const m = (s.models && s.models[0]) || null;
      if (m) {
        const tag = [m.params, m.quant].filter(Boolean).join(' ');
        put('model', tag ? `${m.name} · ${tag}` : m.name);
      } else {
        put('model', 'none loaded');
      }
    } catch (e) { /* upstream down — leave stale values */ }
  }

  // --- chat stream hooks (called from app.js) ---

  function beginGen() {
    gen = { t0: performance.now(), tFirst: 0, tokens: 0, final: null };
    put('tps', '…'); put('ttft', '…'); put('gentok', '0'); put('ptok', '—'); put('ctx', '—');
  }

  function tickToken() {
    if (!gen.t0) return;
    const now = performance.now();
    if (!gen.tFirst) { gen.tFirst = now; put('ttft', ((now - gen.t0) / 1000).toFixed(2) + ' s'); }
    gen.tokens++;
    const dt = (now - gen.tFirst) / 1000;
    if (dt > 0.05) put('tps', (gen.tokens / dt).toFixed(1));
    put('gentok', String(gen.tokens));
  }

  // Authoritative end-of-stream numbers from Ollama (via chat.php).
  function setGenStats(s) {
    if (!s) return;
    gen.final = s;
    if (s.eval_count && s.eval_duration) {
      put('tps', (s.eval_count / (s.eval_duration / 1e9)).toFixed(1));
      put('gentok', String(s.eval_count));
    }
    if (s.prompt_eval_count) put('ptok', String(s.prompt_eval_count));
    if (s.num_ctx) {
      const used = (s.prompt_eval_count || 0) + (s.eval_count || 0);
      const pct = Math.round((used / s.num_ctx) * 100);
      put('ctx', `${used} / ${s.num_ctx} (${pct}%)`);
    }
  }

  function init() {
    build();
    let stored = '0';
    try { stored = localStorage.getItem(STORAGE_KEY) || '0'; } catch (e) {}
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) { e.preventDefault(); set(!visible); }
    });
    const chk = document.getElementById('devHudChk');
    if (chk) chk.addEventListener('change', () => set(chk.checked));
    set(stored === '1');
  }

  return { init, set, toggle: () => set(!visible), beginGen, tickToken, setGenStats };
})();
