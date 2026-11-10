import { hideFaceBubble, replayFaceBubbleIntro, showFaceBubble } from './face-bubble.js?v=93';
import { setSidebarOpen } from './sidebar.js?v=125';
import { DEV, JUN } from './tour-lines.js?v=7';
import { SKIPPED, caption, close, hush, makeRun, unionRect } from '../core/tour-kit.js?v=1';
import { escapeHtml } from '../core/util.js?v=1';
import * as Names from '../core/names.js?v=1';
import * as Prefs from '../core/prefs.js?v=8';
import * as ui from '../core/ui.js?v=1';
import * as Actions from '../live2d/actions.js?v=101';
import * as Live2D from '../live2d/live2d.js?v=91';
import { COLOR_GROUPS } from '../outfit/catalog.js?v=4';
import { colors } from '../outfit/current.js?v=4';
import * as Outfit from '../outfit/outfit.js?v=101';
import * as TTS from '../voice/tts.js?v=92';

const DONE_KEY = 'tour.done';
const LINE_GAP_MS = 420;
const PANEL_SETTLE_MS = 260;
const BYE_MS = 2600;
const CAPTION_OUT_MS = 420;
const OPEN_HOLD_MS = 520;
const OPEN_LIFT_MS = 600;
const CAM_MS = 800;
// between the resting shot (head ~20% of the stage) and face (30%)
const BUST = { head: 0.24, y: 0.4, ms: CAM_MS };

// the colours her skin tries before it gives up, rgb 0..1
const CAMO_WASHES = [[1, .42, .78], [.36, .9, .95], [.62, .5, 1], [1, .84, .3], [.45, .47, .52]];
const CAMO_STEP_MS = 110;

let run = null;

export function due() {
  try { return localStorage.getItem(DONE_KEY) !== '1'; } catch (e) { return false; }
}

function markDone() {
  try { localStorage.setItem(DONE_KEY, '1'); } catch (e) {}
  Prefs.pushToServer();
}

function lineDuration(text) {
  const words = (text.match(/\S+/g) || []).length;
  return Math.max(2600, Math.min(7500, 1100 + words * 280));
}

const row = (sel) => document.querySelector(sel)?.closest('.set-row, .set-block');
const all = (sel) => [...document.querySelectorAll(sel)];

function look(forced) {
  if (!Live2D.hasModel()) return 'flat';
  if (forced) return forced;
  return COLOR_GROUPS.some(g => (colors[g.key] || null) !== (g.defaultColor || null)) ? 'fine' : 'white';
}

function steps(v, voice) {
  const twin = (set, base) => set[base + '_' + v] ? base + '_' + v : base;
  const pick = (base) => twin(JUN, base);
  const heard = voice && TTS.isEnabled();
  return [
    { say: pick('white'), fx: v === 'white' },
    { say: pick('talk'), ring: () => all('.composer'), dev: 'talk' },
    { say: pick(heard ? 'hear' : 'hear_mute'), panel: 'voice', ring: () => [row('#ttsChk')], dev: voice ? 'hear' : 'hear_off' },
    { ring: () => all('#voiceModeBtn:not(:disabled)'), dev: 'mic' },
    { panel: 'general', ring: () => [row('#playerNameInput'), row('#botNameInput')], dev: 'names' },
    { panel: 'memory', ring: () => [row('.mood-controls')], dev: 'memory' },
    { sidebar: true, ring: () => all('#newChatBtn, #searchChatsBtn, #conversationList'), dev: 'chats' },
    { say: pick('date'), panel: 'dates', ring: () => all('.settings-panel[data-panel="dates"] .set-row:not([hidden])'), dev: 'dates' },
    v === 'flat'
      ? { say: 'shop_flat', ring: () => [], dev: 'shop_flat', last: true }
      : { say: pick('shop'), ring: () => [], dev: twin(DEV, 'shop'), go: true },
  ];
}

function showPanel(key) {
  const drawer = document.getElementById('settingsDrawer');
  const open = !!drawer && drawer.classList.contains('open');
  if (!key) {
    if (open) ui.toggleDrawer(false);
    return open;
  }
  const tab = document.querySelector(`.settings-navitem[data-panel="${key}"]`);
  const moved = !open || !tab.classList.contains('active');
  tab.click();
  if (!open) ui.toggleDrawer(true);
  return moved;
}

function showSidebar(on) {
  if (on && document.querySelector('.app-main.sidebar-collapsed')) document.getElementById('expandSidebarBtn')?.click();
  setSidebarOpen(on);
}

async function hypercamo(s) {
  const ids = Live2D.listDrawables();
  for (const rgb of CAMO_WASHES) {
    for (const id of ids) Live2D.setDrawableTint(id, rgb);
    await s.wait(CAMO_STEP_MS);
    for (const id of ids) Live2D.setDrawableTint(id, null);
    await s.wait(CAMO_STEP_MS / 2);
  }
  if (!s.bleached) Outfit.applyAll();
}

function frameHer(s, step) {
  if (Live2D.hasModel() && !s.reduced) Live2D.setCameraPreset('face', step.fx ? { ms: CAM_MS } : BUST);
}

async function speak(s, step) {
  const lines = JUN[step.say];
  const rig = Live2D.hasModel();
  const voiced = TTS.isEnabled();
  const fx = step.fx && !s.reduced;
  if (rig) Live2D.setFidgetsEnabled(false);
  frameHer(s, step);
  for (let i = 0; i < lines.length; i++) {
    const [raw, acts] = lines[i];
    const text = Names.apply(raw);
    replayFaceBubbleIntro();
    showFaceBubble(escapeHtml(text), 'ephemeral');
    if (rig) for (const [name, kwargs] of acts) Actions.applyAction({ name, kwargs });
    const camo = fx && i === 1 ? hypercamo(s).catch(() => {}) : null;
    await s.until((done) => {
      s.talking = voiced && TTS.speak(text, {
        onDone: () => s.wait(LINE_GAP_MS).then(done, () => {}),
        onError: done,
      });
      // a synth job that dies quietly must NOT leave her stuck here
      s.wait(s.talking ? lineDuration(text) * 3 + 5000 : lineDuration(text)).then(done, () => {});
    });
    s.talking = false;
    if (camo) await camo;
  }
  if (rig) {
    if (!s.reduced) Live2D.setCameraPreset('default', { ms: CAM_MS });
    Live2D.resetIdle();
    Live2D.setFidgetsEnabled(true);
  }
}

async function narrate(s, step) {
  const { el } = s;
  if (!step.go) document.body.classList.remove('tour-stage');
  if (step.sidebar) showSidebar(true);
  if (showPanel(step.panel || null)) await s.wait(PANEL_SETTLE_MS);
  const targets = step.ring().filter(Boolean);
  if (!targets.length && !step.last && !step.go) return;
  if (targets.length) targets[0].scrollIntoView({ block: 'nearest' });
  s.aim(targets);
  el.next.textContent = step.go ? 'take her' : step.last ? 'done' : 'next';
  // she begged. there is no way out of this one but yes
  el.skip.hidden = !!step.go;
  el.root.classList.toggle('is-last', !!step.last);
  await caption(s, DEV[step.dev], unionRect(targets));
  el.next.focus({ preventScroll: true });
  await s.until((done) => {
    el.next.onclick = el.block.onclick = done;
    if (!step.last) return;
    // the ask button is live on the last step. pressing it, or
    // closing the panel it sits in, is as done as "done"
    for (const t of targets) t.addEventListener('click', done, { once: true });
    document.getElementById('drawerBackdrop')?.addEventListener('click', done, { once: true });
    document.getElementById('closeSettingsBtn')?.addEventListener('click', done, { once: true });
  });
  if (step.sidebar) showSidebar(false);
  s.toShop = !!step.go;
}

async function voiceInstalled() {
  try {
    const r = await fetch('api/health.php', { credentials: 'same-origin' });
    return r.ok && !!(await r.json()).voice;
  } catch (e) {
    return false;
  }
}

async function play(s) {
  const { el } = s;
  if (!s.reduced) {
    void el.root.offsetWidth;
    el.root.classList.add('is-dark');
  }
  document.body.classList.add('tour-stage');
  const [voice] = await Promise.all([voiceInstalled(), s.reduced ? null : s.wait(OPEN_HOLD_MS)]);
  const v = s.look = look(s.forced);
  // forced white on a coloured rig. leave() puts the colours back
  s.bleached = v === 'white' && s.forced === 'white';
  if (s.bleached) for (const id of Live2D.listDrawables()) Live2D.setDrawableTint(id, null);
  const list = steps(v, voice);
  showPanel(null);
  document.body.classList.add('tour-band');
  frameHer(s, list[0]);
  el.root.classList.remove('is-dark');
  el.root.classList.add('is-lit');
  if (!s.reduced) await s.wait(OPEN_LIFT_MS);

  for (const step of list) {
    if (step.say) {
      // she talks, the app gets out of her way
      hush(s);
      s.aim(null);
      showPanel(null);
      document.body.classList.add('tour-stage');
      await speak(s, step);
    }
    hideFaceBubble();
    if (step.ring) await narrate(s, step);
  }

  s.aim(null);
  showPanel(null);
  if (!s.toShop) document.body.classList.remove('tour-stage');
  el.root.classList.add('is-last');
  el.next.hidden = true;
  el.skip.hidden = true;
  await caption(s, DEV.bye, null);
  await s.wait(BYE_MS);
  el.root.classList.remove('captioned', 'is-lit');
  el.l3.classList.add('out');
  if (!s.reduced) await s.wait(CAPTION_OUT_MS);
}

async function leave(s) {
  s.clearTimers();
  if (s.talking) TTS.stop();
  hideFaceBubble();
  showSidebar(false);
  showPanel(null);
  if (Live2D.hasModel()) {
    Live2D.setCameraPreset('default', { ms: CAM_MS });
    Outfit.applyAll();
    Live2D.resetIdle();
    Live2D.startIdle();
    Live2D.setFidgetsEnabled(true);
  }
  await close(s);
}

// only a finished or skipped run writes tour.done. a closed tab, a
// reload or a throw leaves it unset and she starts over next boot
export async function start(forced, goShop) {
  if (run) return;
  const s = run = makeRun();
  s.forced = forced;
  let finished = false;
  try {
    await play(s);
    finished = true;
  } catch (e) {
    if (e === SKIPPED) finished = true;
    else console.warn('[tour]', e);
  }
  const shop = s.toShop && goShop;
  if (finished && !shop) markDone();
  try {
    await leave(s);
  } finally {
    run = null;
  }
  if (shop) goShop(markDone, s.look);
}
