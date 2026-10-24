// one EventSource for the banner, the dev terminal and the filing game

const STALL_MS = 30000;
const DRAIN_MS = 10000;

let source = null;
let lastId = '';
let lastAt = 0;
let quietUntil = 0;
let watchdog = null;
let drainTimer = null;
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
  if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
  if (source) return;
  open();
  if (!watchdog) watchdog = setInterval(check, 1000);
}

export function stop() {
  if (source) { source.close(); source = null; }
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
  if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
  quietUntil = 0;
}

// the lock can go before done is read (php -S polls the stream), so
// wait for it. never comes = the status poll's word for how it ended
export function drain(fallbackStatus) {
  if (!source || drainTimer) return;
  drainTimer = setTimeout(() => {
    drainTimer = null;
    stop();
    emit({ type: 'done', status: fallbackStatus || 'error', client: true });
  }, DRAIN_MS);
}

export function running() { return !!source; }

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
