import { chatInput, sendBtn } from './dom.js?v=8';
import { replayFaceBubbleIntro, scheduleFaceBubbleHide, showFaceBubble } from './face-bubble.js?v=8';
import { loadMood } from './mood.js?v=8';
import { escapeHtml } from './util.js?v=8';

const CAMERA_MS = 450;
const SCENE_TAIL_MS = 1800;
const LINE_GAP_MS = 420;
let pending = null;

// backup pace only, for a run with TTS off or a job that never comes back.
// when the voice works, IT says when a line is done.
function lineDuration(text) {
  const words = (text.match(/\S+/g) || []).length;
  return Math.max(2600, Math.min(7500, 1100 + words * 280));
}

// colors the vignette, the sweep and the line under the dialogue box. left
// empty for the warm tiers, where the mood accent app/mood.js already paints
// is already the right color and follows the gauges for free.
const TIER_TINT = {
  panicked: 'hsl(8 85% 62%)',
  unravelled: 'hsl(280 45% 58%)',
  hollow: 'hsl(215 18% 52%)',
};

// small movement running under the keyframed sequence for the Whole scene.
// [param, amplitude, period_ms]
const TIER_LOOPS = {
  none: [['ParamTailWiggle', 0.35, 1100]],
  missed: [['ParamTailWiggle', 0.6, 850], ['ParamBodyY', 0.18, 3000]],
  ached: [['ParamTailWiggle', 0.9, 620], ['ParamBodyY', 0.25, 2600], ['ParamEarsWiggle', 0.3, 900]],
  panicked: [['ParamBodyX', 0.06, 170], ['ParamHeadZ', 0.05, 210], ['ParamBodyY', 0.1, 1500]],
  unravelled: [['ParamBodyY', 0.12, 5200], ['ParamTailWiggle', 0.15, 2600]],
  hollow: [['ParamBodyY', 0.06, 7000]],
};

// one per absence tier. the reaction IS the point of the zoom, so each one is
// built around what the face does, not the body. the body is mostly out of
// frame at the 'face' preset anyway.
const SCENES = {
  none: [
    { params: { ParamEyeOpen: 1.2, ParamIrisZoom: 0.2, ParamHeadZ: -4 }, dt_ms: 0 },
    { params: { ParamEarL: 1, ParamEarR: 1, ParamMouthForm: 0.7, ParamHeadZ: -6 }, dt_ms: 260 },
    { params: { ParamEyesHappy: 0.5, ParamHeadZ: 0, ParamIrisZoom: 0 }, dt_ms: 900 },
  ],
  missed: [
    { params: { ParamEyeOpen: 1.3, ParamIrisZoom: 0.45, ParamBrowLY: 0.3, ParamBrowRY: 0.3 }, dt_ms: 0 },
    { params: { ParamEarL: 1, ParamEarR: 1, ParamHeadZ: -8, ParamHeadY: 0.15 }, dt_ms: 320 },
    { params: { ParamMouthForm: 0.8, ParamEyesHappy: 0.5, ParamBlush: 0.25, ParamBrowLY: 0.1, ParamBrowRY: 0.1 }, dt_ms: 700 },
    { params: { ParamHeadZ: -3, ParamIrisZoom: 0.1, ParamHeadY: 0 }, dt_ms: 1200 },
  ],
  ached: [
    { params: { ParamEyeOpen: 1.4, ParamIrisZoom: 0.7, ParamEarL: 1, ParamEarR: 1, ParamBrowLY: 0.5, ParamBrowRY: 0.5 }, dt_ms: 0 },
    { params: { ParamMouthOpen: 0.35, ParamHeadY: 0.2 }, dt_ms: 260 },
    { params: { ParamHeart: 1, ParamEyesHappy: 1, ParamMouthForm: 1, ParamMouthOpen: 0, ParamBlush: 0.55 }, dt_ms: 520 },
    { params: { ParamHeadZ: -10, ParamHeadY: 0, ParamBrowLY: 0.3, ParamBrowRY: 0.3 }, dt_ms: 800 },
    { params: { ParamHeart: 0, ParamIrisZoom: 0.25, ParamHeadZ: -4 }, dt_ms: 2200 },
  ],
  panicked: [
    { params: { ParamEyeLShock: 1, ParamEyeRShock: 1, ParamPupilWiggle: 1, ParamEyeOpen: 1 }, dt_ms: 0 },
    { params: { ParamBrowLY: 0.8, ParamBrowRY: 0.8, ParamBrowLRot: 0.4, ParamBrowRRot: -0.4, ParamMouthOpen: 0.5 }, dt_ms: 200 },
    { params: { ParamHeadX: -0.3, ParamEyeballLX: -0.4, ParamEyeballRX: -0.4 }, dt_ms: 400 },
    { params: { ParamHeadX: 0.3, ParamEyeballLX: 0.4, ParamEyeballRX: 0.4 }, dt_ms: 400 },
    { params: { ParamEyeLShock: 0, ParamEyeRShock: 0, ParamHeadX: 0, ParamEyeballLX: 0, ParamEyeballRX: 0, ParamMouthOpen: 0.2 }, dt_ms: 600 },
    { params: { ParamPupilWiggle: 0.3, ParamBlush: 0.4, ParamMouthOpen: 0, ParamMouthForm: -0.2 }, dt_ms: 1400 },
  ],
  unravelled: [
    { params: { ParamHeadY: -0.5, ParamEyeOpen: 0.5, ParamEarL: -0.8, ParamEarR: -0.8 }, dt_ms: 0 },
    { params: { ParamHeadY: -0.5, ParamEyeballLY: 0.6, ParamEyeballRY: 0.6, ParamEyeOpen: 0.7 }, dt_ms: 1400 },
    { params: { ParamHeadY: 0, ParamEyeballLY: 0, ParamEyeballRY: 0, ParamPupilWiggle: 0.5 }, dt_ms: 900 },
    { params: { ParamBrowLY: -0.3, ParamBrowRY: -0.3, ParamMouthForm: -0.3, ParamPupilWiggle: 0 }, dt_ms: 1600 },
  ],
  // almost nothing, ON PURPOSE. the flatness IS the reaction, and that one
  // slow blink is the only sign she noticed him at all.
  hollow: [
    { params: { ParamEyeOpen: 0.75, ParamIrisZoom: -0.5, ParamEarL: -1, ParamEarR: -1 }, dt_ms: 0 },
    { params: { ParamEyeOpen: 0, ParamHeadX: 0.1 }, dt_ms: 1800 },
    { params: { ParamEyeOpen: 0.7, ParamHeadX: 0.15, ParamMouthForm: -0.15 }, dt_ms: 900 },
    { params: { ParamHeadX: 0 }, dt_ms: 3000 },
  ],
};

// a believable absence per tier, so a preview shows a time that fits the line
// next to it. pass seconds as the second argument to set your own.
const TIER_AWAY = {
  none: 120, missed: 12600, ached: 41827,
  panicked: 108061, unravelled: 302449, hollow: 1600000,
};
export const WELCOME_TIERS = Object.keys(TIER_AWAY);

// debug way in. replays the scene on a tier you pick without emptying the
// queue or touching the gauges, so a preview never spends a real greeting.
export async function previewWelcome(tier = 'unravelled', away = TIER_AWAY[tier] ?? 90061) {
  // ALWAYS sent, 'none' included. leave the tier out and the server derives
  // one from the duration, which is the exact opposite of forcing it.
  const query = new URLSearchParams({ preview: '1', away: String(away), tier, hour: String(new Date().getHours()) });
  try {
    const response = await fetch('api/consolidate.php?action=welcome&' + query, { credentials: 'same-origin' });
    if (!response.ok) { console.warn('welcome preview failed:', response.status); return; }
    pending = await response.json();
    playWelcome();
  } catch (e) {
    console.warn('welcome preview failed:', e);
  }
}

// fetched at boot BEFORE the first activity report of the session. the server
// measures the absence off last_activity and that report wipes it.
export async function fetchWelcome() {
  try {
    // server runs in UTC. the greeting goes off the clock on HIS wall.
    const response = await fetch('api/consolidate.php?action=welcome&hour=' + new Date().getHours(), { credentials: 'same-origin' });
    if (!response.ok) return;
    const payload = await response.json();
    if (payload && payload.show && Array.isArray(payload.lines) && payload.lines.length) pending = payload;
  } catch (e) { /* offline: no greeting, nothing else breaks */ }
}

let sceneTimers = [];
let endScene = null;

const sceneFx = (() => {
  const el = document.createElement('div');
  el.className = 'welcome-scene-fx';
  el.hidden = true;
  el.setAttribute('aria-hidden', 'true');
  const sweep = document.createElement('div');
  sweep.className = 'welcome-scene-sweep';
  el.appendChild(sweep);
  document.body.appendChild(el);
  return el;
})();

function enterScene(tier) {
  const tint = TIER_TINT[tier];
  if (tint) sceneFx.style.setProperty('--scene-tint', tint);
  else sceneFx.style.removeProperty('--scene-tint');
  sceneFx.hidden = false;
  // two frames. the element has to be laid out and not hidden before the
  // class changes, or the opacity and letterbox have nothing to move from.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.body.classList.add('welcome-scene');
  }));
}

function exitScene() {
  document.body.classList.remove('welcome-scene');
  setTimeout(() => {
    if (!document.body.classList.contains('welcome-scene')) sceneFx.hidden = true;
  }, 600);
}

// a long absence queues up six of them, and being stuck in the face zoom for
// twenty five seconds with no escape is worse than showing no scene at all.
function abortOnInteraction() {
  const stop = () => { if (endScene) endScene(); };
  chatInput.addEventListener('focus', stop, { once: true });
  chatInput.addEventListener('keydown', stop, { once: true });
  sendBtn.addEventListener('click', stop, { once: true });
  return () => {
    chatInput.removeEventListener('focus', stop);
    chatInput.removeEventListener('keydown', stop);
    sendBtn.removeEventListener('click', stop);
  };
}

export function playWelcome() {
  if (!pending) return;
  const { lines, tier, mood_changed: moodChanged } = pending;
  pending = null;
  const player = window.Names ? Names.getPlayer() : 'Anon';
  // wrapped in a span so welcome.css can fade the words in after the panel
  // has opened. without it .fb-text is a plain text node with nothing to aim
  // at.
  const resolved = lines.map(line => '<span>' + escapeHtml(line.replaceAll('{f_playerName}', player)) + '</span>');
  const live2d = window.Live2D;
  const at = (ms, fn) => sceneTimers.push(setTimeout(fn, ms));

  const loops = TIER_LOOPS[tier] || TIER_LOOPS.none;
  const speaks = !!(window.TTS && TTS.isEnabled && TTS.isEnabled());

  const detach = abortOnInteraction();
  endScene = () => {
    endScene = null;
    detach();
    for (const t of sceneTimers) clearTimeout(t);
    sceneTimers = [];
    exitScene();
    if (speaks) TTS.stop();
    if (!live2d) return;
    for (const [param] of loops) live2d.stopLoop(param);
    // voice mode uses the same 'face' preset. if it took over mid scene then
    // handing the camera back yanks it out of a zoom it still wants.
    if (!(window.VoiceMode && VoiceMode.isActive())) live2d.setCameraPreset('default');
    live2d.resetIdle();
    live2d.startIdle();
    live2d.setFidgetsEnabled(true);
  };

  enterScene(tier);
  if (live2d) {
    live2d.setFidgetsEnabled(false);
    live2d.setCameraPreset('face');
    // let the camera arrive before she reacts, or it happens off screen
    at(CAMERA_MS, () => {
      live2d.scheduleSequence(SCENES[tier] || SCENES.none);
      for (const [param, amp, period] of loops) live2d.startLoop(param, amp, period);
    });
  }

  const plains = lines.map(line => line.replaceAll('{f_playerName}', player));

  // lines advance when the VOICE finishes them, not on a timer. a fixed pace
  // yanked the text away mid sentence on anything longer than a few words.
  // with no TTS we guess from the word count instead.
  function showLine(i) {
    if (!endScene) return;
    if (i >= plains.length) {
      at(SCENE_TAIL_MS, () => endScene && endScene());
      return;
    }
    const last = i === plains.length - 1;
    replayFaceBubbleIntro();
    showFaceBubble(resolved[i], 'ephemeral');

    let advanced = false;
    const next = () => {
      if (advanced || !endScene) return;
      advanced = true;
      showLine(i + 1);
    };

    // speak() kills whatever is playing, which is exactly what we want.
    // nothing else should be running, and one job at a time is what gives us
    // an onDone per line to wait on.
    const spoken = speaks && TTS.speak(plains[i], {
      onDone: () => at(LINE_GAP_MS, next),
      onError: next,
    });
    // scheduleFaceBubbleHide defers itself while TTS is talking, so the last
    // card has to be set up AFTER the job exists or its read timer starts
    // right NOW.
    if (last) scheduleFaceBubbleHide(resolved[i], 'ephemeral');

    if (spoken) {
      // synthesis can die without a word, or the tab gets throttled. NEVER
      // leave the scene waiting on a callback that isn't coming.
      at(lineDuration(plains[i]) * 3 + 5000, next);
    } else {
      at(lineDuration(plains[i]), next);
    }
  }

  at(CAMERA_MS, () => showLine(0));
  if (moodChanged) loadMood();
}
