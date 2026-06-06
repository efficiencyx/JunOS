// Typewriter effects for the boot overlay terminal.
// app.js calls BootFX.start() when the overlay is shown and BootFX.typeStatus()
// whenever the live status text changes. Kept separate so the standalone
// boot-preview.html can drive the exact same animation.

(function () {
  const reduceMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Type `text` into `el` one character at a time. `signal.cancelled` lets a
  // newer call abort an in-flight one (the live status updates repeatedly).
  function type(el, text, speed, signal) {
    text = text || '';
    if (reduceMotion) { el.textContent = text; return Promise.resolve(); }
    el.textContent = '';
    return new Promise((resolve) => {
      let i = 0;
      const tick = () => {
        if (signal && signal.cancelled) return resolve();
        el.textContent = text.slice(0, ++i);
        if (i >= text.length) return resolve();
        setTimeout(tick, speed);
      };
      setTimeout(tick, speed);
    });
  }

  // The live status line only appears once every boot-log command has run.
  // Status updates that arrive before then are held; the latest one wins.
  let logStarted = false;
  let logDone = false;
  let pendingStatus = null;
  const afterLog = [];   // callbacks deferred until the log finishes

  function whenLogDone(fn) {
    if (logDone) fn();
    else afterLog.push(fn);
  }

  function finishLog(term) {
    logDone = true;
    if (term) term.classList.add('log-done');   // reveal the live status + hint
    if (pendingStatus != null) {
      const text = pendingStatus;
      pendingStatus = null;
      doTypeStatus(text);
    }
    while (afterLog.length) afterLog.shift()();
  }

  // Boot succeeded: let the green "Ready" settle, zoom into the terminal, then
  // hand back to the caller (which dismisses the overlay). Waits for the log.
  function finish(done) {
    whenLogDone(() => {
      const term = document.querySelector('.boot-term');
      const consoleEl = document.querySelector('.boot-console');
      if (!term || reduceMotion) { if (done) done(); return; }
      setTimeout(() => {
        if (consoleEl) consoleEl.classList.add('finishing');   // fade the chrome
        term.classList.add('zoom');                        // dive into the screen
        term.addEventListener('animationend', () => { if (done) done(); }, { once: true });
      }, 520);   // a beat so "Ready" is readable
    });
  }

  async function runLog() {
    const term = document.querySelector('.boot-term');
    const lines = Array.from(document.querySelectorAll('.boot-log li'));
    if (!term || !lines.length || logStarted) return;
    logStarted = true;

    if (reduceMotion) { finishLog(term); return; }   // no typing; reveal at once

    term.classList.add('typing');   // hides upcoming lines, OK badges, live status
    for (const li of lines) {
      li.classList.add('live');     // reveal this line, then type its command
      const cmd = li.querySelector('.boot-cmd');
      const text = cmd.getAttribute('data-text') || cmd.textContent;
      await type(cmd, text, 20);
      li.classList.add('done');     // pop the OK badge
      await wait(110);
    }
    finishLog(term);
  }

  let statusToken = 0;
  function doTypeStatus(text) {
    const el = document.querySelector('#bootStatus .boot-status-label');
    if (!el) return;
    const token = ++statusToken;
    type(el, text, 32, { get cancelled() { return token !== statusToken; } });
  }

  function typeStatus(text) {
    if (!logDone) { pendingStatus = text; return; }   // defer until the log finishes
    doTypeStatus(text);
  }

  function start() {
    const el = document.querySelector('#bootStatus .boot-status-label');
    if (el) typeStatus(el.textContent.trim());   // seed the initial label (deferred)
    runLog();
  }

  window.BootFX = { start, runLog, typeStatus, finish };
})();
