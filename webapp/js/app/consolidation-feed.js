// one EventSource for the banner, the dev terminal and the filing game

const STALL_MS = 30000;

let source = null;
let lastId = '';
let lastAt = 0;
let quietUntil = 0;
let watchdog = null;
const listeners = new Set();

function emit(ev) {
  for (const fn of listeners) {
    try { fn(ev); } catch (e) { console.error(e); }
  }
}

function open() {
  lastAt = Date.now();
  source = new EventSource('api/consolidate.php?action=stream' + (lastId ? '&from=' + encodeURIComponent(lastId) : ''));
  source.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch (e) { return; }
    lastAt = Date.now();
    if (ev.id) lastId = ev.id;
    if (ev.type === 'call') quietUntil = (ev.quiet_until || 0) * 1000;
    emit(ev);
    if (ev.type === 'done') stop();
  };
}

// the worker restarts a wedged pass itself, this only covers a dead connection
function check() {
  if (!source || Date.now() - Math.max(lastAt, quietUntil) < STALL_MS) return;
  source.close();
  emit({ type: 'stall', client: true });
  open();
}

export function start() {
  if (source) return;
  open();
  if (!watchdog) watchdog = setInterval(check, 1000);
}

export function stop() {
  if (source) { source.close(); source = null; }
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
  quietUntil = 0;
}

export function running() { return !!source; }

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
