import { SKIPPED, caption, close, makeRun, unionRect } from '../core/tour-kit.js?v=1';

// app/main.js leaves the look here on the way out of the tour
const FLAG = 'tour.shop';

const STEPS = (look) => [
  ['.wd-body', 'The racks', 'pick a thing for its options and colours, or drag it onto her.'],
  ['.wd-rail', 'Body and hair', look === 'white'
    ? 'her skin and hair are in these. that is the part that went white.'
    : 'her skin and hair are in these too.'],
  ['.wd-looks', 'Saved looks', 'keep an outfit, get it back later.'],
  ['.head-home', 'Head home', 'when you two are done. she walks out wearing it.'],
];

export async function shopLeg() {
  let look = null;
  try {
    look = localStorage.getItem(FLAG);
    localStorage.removeItem(FLAG);
  } catch (e) {}
  if (!look) return;
  const s = makeRun();
  const { el } = s;
  el.root.classList.add('is-lit');
  try {
    const steps = STEPS(look);
    for (const [sel, label, cap] of steps) {
      const targets = [...document.querySelectorAll(sel)];
      if (!targets.length) continue;
      s.aim(targets);
      el.next.textContent = sel === steps.at(-1)[0] ? 'done' : 'next';
      await caption(s, [label, cap], unionRect(targets));
      el.next.focus({ preventScroll: true });
      await s.until((done) => { el.next.onclick = el.block.onclick = done; });
    }
  } catch (e) {
    if (e !== SKIPPED) console.warn('[tour]', e);
  }
  await close(s);
}
