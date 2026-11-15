export const HOLD_MS = 3000;

export function hold(btn, onConfirm, ms = HOLD_MS) {
  let timer = null;
  btn.classList.add('hold');
  btn.style.setProperty('--hold-ms', ms + 'ms');
  const isKey = (e) => e.key === ' ' || e.key === 'Enter';
  const stop = (e) => {
    if (e && e.type === 'keyup' && !isKey(e)) return;
    clearTimeout(timer);
    timer = null;
    btn.classList.remove('holding');
  };
  const start = (e) => {
    if (e.type === 'keydown') {
      if (!isKey(e)) return;
      e.preventDefault();
      if (e.repeat) return;
    } else if (e.button !== 0) return;
    if (timer || btn.disabled) return;
    btn.dataset.holdLabel = btn.textContent;
    btn.classList.add('holding');
    timer = setTimeout(() => { stop(); onConfirm(); }, ms);
  };
  btn.addEventListener('pointerdown', start);
  btn.addEventListener('keydown', start);
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'keyup', 'blur']) btn.addEventListener(ev, stop);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}
