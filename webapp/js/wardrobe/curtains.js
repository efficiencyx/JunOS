import * as Live2D from '../live2d/live2d.js?v=4';
import { hooks } from '../outfit/hooks.js?v=1';

const changes = [];
let changing = false;
let curtains = null;
let stage = null;

function positionCurtains() {
  const preview = document.body.classList.contains('looks-open') && document.querySelector('.wd-looks-stage');
  if (preview) {
    const r = preview.getBoundingClientRect();
    curtains.style.inset = `${r.top}px ${innerWidth - r.right}px ${innerHeight - r.bottom}px ${r.left}px`;
  } else {
    curtains.style.inset = '';
  }
}

async function drawCurtains(closed) {
  curtains.classList.toggle('closed', closed);
  await Promise.all([...curtains.children].flatMap(c => c.getAnimations()).map(a => a.finished.catch(() => {})));
}

async function changeBehindCurtains() {
  changing = true;
  stage.setAttribute('aria-busy', 'true');
  try {
    while (changes.length) {
      positionCurtains();
      await drawCurtains(true);
      do {
        const batch = changes.splice(0);
        for (const job of batch) {
          try { job.resolve(await job.apply()); }
          catch (error) { job.reject(error); }
        }
        await Live2D.texturesSettled();
        await new Promise(resolve => setTimeout(resolve, 180));
      } while (changes.length);
      await drawCurtains(false);
    }
  } finally {
    curtains.classList.remove('closed');
    stage.removeAttribute('aria-busy');
    changing = false;
  }
}

function change(apply) {
  return new Promise((resolve, reject) => {
    changes.push({ apply, resolve, reject });
    if (!changing) changeBehindCurtains();
  });
}

export function armCurtains() {
  curtains = document.querySelector('.fitting-curtains');
  stage = document.getElementById('stage');
  if (window.ResizeObserver) new ResizeObserver(positionCurtains).observe(stage);
  else window.addEventListener('resize', positionCurtains);
  new MutationObserver(positionCurtains).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  hooks.curtains = change;
}
