import { IDLE_AFTER_REPLY_MS, TYPING_POLL_MS, consolidating, reportActivity, resetIdleNudge, scheduleIdleNudge, showConsolidatingBubble, syncConsolidationStatus } from './consolidation.js?v=19';
import { chatInput, devNoIdleChk, missingParamsEl, modelSelect, narrowSidebarQuery, reasoningSelect, sendBtn, siteVolumeInput, stageEl, thinkChk } from './dom.js?v=11';
import { faceBubble, hideFaceBubble, latestAssistantReply, restartFaceBubbleHide, scheduleFaceBubblePosition, setLatestAssistantReply } from './face-bubble.js?v=18';
import { logAction, logMissing, setStageStatus } from './logging.js?v=11';
import { loadMood } from './mood.js?v=18';
import { applyProviderCapabilities, applyRoleGates, setSiteVolume, syncThinkToggle, updateSiteVolumeLabel, wireNameSettings } from './settings.js?v=20';
import { loadConversation, refreshSidebar, setSidebarOpen } from './sidebar.js?v=19';
import { escapeHtml, mealNow } from '../core/util.js?v=1';
import { wireTts } from './wire-tts.js?v=19';
import { wireVoice } from './wire-voice.js?v=20';
import { WELCOME_TIERS, fetchWelcome, playWelcome, previewWelcome } from './welcome.js?v=18';
import * as Names from '../core/names.js?v=1';
import * as Prefs from '../core/prefs.js?v=1';
import * as ui from '../core/ui.js?v=1';
import * as ChatAPI from '../core/chat-api.js?v=2';
import * as MobileViewport from '../core/viewport.js?v=1';
import * as Actions from '../live2d/actions.js?v=4';
import * as Live2D from '../live2d/live2d.js?v=4';
import * as ModelTouch from '../live2d/touch.js?v=4';
import * as Outfit from '../outfit/outfit.js?v=3';
import { playIntro } from '../wardrobe/reactions.js?v=3';
import * as BootFX from './boot-fx.js?v=1';
import * as Cards from './cards.js?v=2';
import * as History from './history.js?v=1';
import { startSkybox } from '../trip/skybox.js?v=1';
import * as TripLoader from '../trip/trip-loader.js?v=1';
import { DevHud, abortFn, currentConversationId, setDevHud } from './session.js?v=1';
import { rerenderBubbleStream, sendMessage, sendTouchEvent } from './chat.js?v=2';

// the one app global left, on purpose. it's a console handle,
// Welcome.preview('panicked') replays that welcome scene
window.Welcome = { preview: previewWelcome, tiers: WELCOME_TIERS };

faceBubble.addEventListener('pointerdown', restartFaceBubbleHide);
faceBubble.addEventListener('scroll', restartFaceBubbleHide, { capture: true, passive: true });
faceBubble.addEventListener('focus', restartFaceBubbleHide);
faceBubble.addEventListener('keydown', restartFaceBubbleHide);
faceBubble.addEventListener('focusout', (event) => {
  if (!faceBubble.contains(event.relatedTarget)) restartFaceBubbleHide();
});
if (window.ResizeObserver) new ResizeObserver(scheduleFaceBubblePosition).observe(faceBubble);
window.addEventListener('resize', scheduleFaceBubblePosition);
MobileViewport.subscribe((state) => {
  if (state.visualChanged || state.layoutChanged) scheduleFaceBubblePosition();
  if (!state.phoneChanged) return;
  hideFaceBubble();
  setLatestAssistantReply(latestAssistantReply);
  rerenderBubbleStream(state.isPhone);
});

const composer = document.querySelector('.composer');
if (composer) {
  composer.addEventListener('pointerdown', () => {
    if (consolidating) showConsolidatingBubble();
  });
}
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
chatInput.addEventListener('input', () => {
  reportActivity();
  if (abortFn) return;
  resetIdleNudge();
  scheduleIdleNudge(IDLE_AFTER_REPLY_MS);
});
window.addEventListener('pagehide', () => {
  navigator.sendBeacon('api/consolidate.php?action=activity&enabled=1');
});
setInterval(() => {
  if (abortFn || !currentConversationId) return;
  if (chatInput.value.trim() === '') return;
  resetIdleNudge();
  scheduleIdleNudge(IDLE_AFTER_REPLY_MS);
}, TYPING_POLL_MS);

const appMain = document.querySelector('.app-main');
const collapseBtn = document.getElementById('collapseSidebarBtn');
const expandBtn = document.getElementById('expandSidebarBtn');
if (appMain && localStorage.getItem('sidebar.collapsed') === '1') {
  appMain.classList.add('sidebar-collapsed');
}
[collapseBtn, expandBtn].filter(Boolean).forEach(btn => {
  btn.addEventListener('click', () => {
    if (!appMain) return;
    if (narrowSidebarQuery.matches) {
      setSidebarOpen(false);
      return;
    }
    const next = !appMain.classList.contains('sidebar-collapsed');
    appMain.classList.toggle('sidebar-collapsed', next);
    localStorage.setItem('sidebar.collapsed', next ? '1' : '0');
  });
});

document.querySelectorAll('.chip[data-prompt]').forEach(chip => {
  chip.addEventListener('click', () => {
    chatInput.value = chip.dataset.prompt;
    chatInput.focus();
  });
});

ui.setStatus('idle', 'idle');

function showBoot() {
  const bo = document.getElementById('bootOverlay');
  if (bo) {
    bo.removeAttribute('data-ready');
    bo.setAttribute('aria-hidden', 'false');
  }
  BootFX.start();
}

export async function boot(me) {
  const currentUser = me.user || null;
  applyRoleGates(currentUser);

  // not awaited here, it's off the boot path. read at the dates
  // panel further down
  const tripStateP = fetch('api/trip.php', { credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : null).catch(() => null);

  // devhud.js owns Ctrl+Shift+D, so only admins get that module
  if (currentUser?.role === 'admin') setDevHud(await import('./devhud.js?v=1'));
  startSkybox();
  // marked is a global and app.js's loadScripts only brings it in
  // side by side with this module. at module scope it's not there
  // yet, boot() runs once both are done.
  marked.setOptions({ gfm: true, breaks: true });
  ModelTouch.init({
    sendEvent: sendTouchEvent,
    isBusy: () => !!abortFn,
    onTouch: () => {
      if (abortFn) return;
      resetIdleNudge();
      scheduleIdleNudge(IDLE_AFTER_REPLY_MS);
    },
  });
  Cards.init({ sendEvent: sendTouchEvent, isBusy: () => !!abortFn });

  // coming back from the shop or a date, the return cutscene
  // REPLACES the boot terminal. skipping BootFX.start also makes
  // BootFX.finish a no-op later.
  const fromTrip = ['wardrobe', 'date', 'karaoke'].includes(new URLSearchParams(location.search).get('from'));
  if (fromTrip) {
    history.replaceState(null, '', location.pathname);
    TripLoader.mount({ reverse: true });
    const bo = document.getElementById('bootOverlay');
    if (bo) {
      bo.setAttribute('data-ready', '1');
      bo.setAttribute('aria-hidden', 'true');
    }
  } else {
    showBoot();
  }

  const emailEl = document.getElementById('userEmail');
  if (me.user && emailEl) emailEl.textContent = me.user.email || '';

  // fill in the synced preferences BEFORE any module reads its
  // local keys
  await Prefs.pullFromServer();
  Names.load();
  Names.decorate();
  wireNameSettings();

  const storedVolume = parseFloat(localStorage.getItem('audio.volume') || '1');
  const siteVolume = setSiteVolume(storedVolume);
  if (siteVolumeInput) {
    siteVolumeInput.value = String(Math.round(siteVolume * 100));
    updateSiteVolumeLabel();
    siteVolumeInput.addEventListener('input', () => {
      setSiteVolume(parseFloat(siteVolumeInput.value) / 100);
      updateSiteVolumeLabel();
    });
    siteVolumeInput.addEventListener('change', () => {
      const volume = setSiteVolume(parseFloat(siteVolumeInput.value) / 100);
      localStorage.setItem('audio.volume', String(volume));
      Prefs.pushToServer();
    });
  }

  const savedReasoning = localStorage.getItem('reasoning_level');
  if (savedReasoning && [...reasoningSelect.options].some(o => o.value === savedReasoning)) {
    reasoningSelect.value = savedReasoning;
  }
  if (localStorage.getItem('think') !== null) {
    thinkChk.checked = localStorage.getItem('think') === '1';
  }
  if (localStorage.getItem('no_idle_nudges') !== null) {
    devNoIdleChk.checked = localStorage.getItem('no_idle_nudges') === '1';
  }
  syncThinkToggle();
  // lock the composer up front until the first status check
  // answers, but leave the banner alone. it only ever speaks for
  // something the server actually said is true, so a normal load
  // never flashes a consolidation notice and then takes it back.
  chatInput.disabled = true;
  sendBtn.disabled = true;
  await syncConsolidationStatus();
  // a trip is the same session. time out there is NOT an absence.
  if (!fromTrip) await fetchWelcome();
  reportActivity(true);
  // gauges get fetched before Live2D.init, or the empty-state
  // greeting sits on neutral values waiting for the .moc3 (the
  // Cubism model file) to load. setMood can park values before
  // init, startIdle applies the baseline.
  loadMood();

  Actions.setLogger(logAction);
  Live2D.setOnMissingParam(logMissing);
  if (DevHud) DevHud.init();

  try {
    const live2dInfo = await Live2D.init({ stageEl, onStatus: (m) => {
      setStageStatus(m);
      if (fromTrip) TripLoader.setStage(m);
    } });
    setTimeout(() => setStageStatus(null), 1500);
    if (fromTrip) {
      TripLoader.setStage('Home again');
      TripLoader.finish();
    }
    Live2D.startIdle();
    playWelcome();

    const actionMap = await Actions.load('action_map.json');

    validateActionMap(live2dInfo.paramIds, actionMap);

    await Outfit.load();
    Outfit.applyAll();
  } catch (e) {
    console.error(e);
    if (fromTrip) TripLoader.fail('Live2D load error: ' + e.message);
    setStageStatus('Live2D load error: ' + e.message, true);
    ui.toast('Live2D load error: ' + e.message, 'error');
    ui.setStatus('error', 'error');
  }

  await wireTts();

  await wireVoice();
  // whatever she granted is spent the moment you're back on this
  // page, walked home or typed the URL, same thing
  const tripState = await tripStateP;
  if (tripState && tripState.where) {
    fetch('api/trip.php?action=home', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  }
  wireDatesPanel(!!(tripState && tripState.can_force));

  const bootOverlay = document.getElementById('bootOverlay');
  const bootHint = document.getElementById('bootHint');
  const setBoot = (label, hint, tone) => {
    if (label) BootFX.typeStatus(label);
    if (bootHint && hint != null) {
      bootHint.textContent = hint;
      if (tone) bootHint.setAttribute('data-tone', tone);
      else bootHint.removeAttribute('data-tone');
    }
  };
  const dismissBoot = () => {
    if (!bootOverlay) return;
    document.documentElement.removeAttribute('data-pre-auth');
    setBoot('Ready', 'Connected', 'ok');
    const hide = () => {
      bootOverlay.setAttribute('data-ready', '1');
      bootOverlay.setAttribute('aria-hidden', 'true');
    };
    BootFX.finish(hide);
  };

  async function waitForProvider() {
    let attempt = 0;
    const bot = Names.getBot();
    const phases = [
      'Waking the model',
      'Brewing Coffee for ' + Names.getPlayer(),
      'Recharging ' + bot,
      bot + ' is taking its time',
    ];
    for (;;) {
      attempt++;
      try {
        const m = await ChatAPI.listModels();
        if (m && m.models && m.models.length) return m;
        setBoot('Pulling models', m && m.provider && m.provider !== 'ollama'
          ? 'No models reported by the provider yet - still booting?'
          : 'No models installed yet - `ollama pull <model>`', 'err');
      } catch (e) {
        const phase = phases[Math.min(attempt - 1, phases.length - 1)];
        setBoot(phase, bot + ' is still sleeping - retrying…', 'err');
      }
      await new Promise(r => setTimeout(r, Math.min(1000 + attempt * 250, 3000)));
    }
  }

  const m = await waitForProvider();
  applyProviderCapabilities(m.provider);
  // hide the shared hf.co/efficiencyx/ prefix in labels only.
  // requests still need the full model name.
  const shortName = (n) => n.replace(/^hf\.co\/[^/]+\//, '');
  modelSelect.innerHTML = m.models.map(n =>
    `<option value="${escapeHtml(n)}">${escapeHtml(shortName(n))}</option>`).join('');
  const prefer = [
    'hf.co/efficiencyx/Jun-LoRA-12B-GGUF:Q8_0',
    'hf.co/efficiencyx/Jun-LoRA-12B-GGUF:Q6_K',
    'hf.co/efficiencyx/Jun-LoRA-12B-GGUF:Q4_K_M',
    'hf.co/efficiencyx/Jun-LoRA-E4B-GGUF:Q8_0',
    'hf.co/efficiencyx/Jun-LoRA-E4B-GGUF:Q6_K',
    'hf.co/efficiencyx/Jun-LoRA-E4B-GGUF:Q4_K_M',
    'hf.co/efficiencyx/Jun-LoRA-E2B-GGUF:Q8_0',
    'hf.co/efficiencyx/Jun-LoRA-E2B-GGUF:Q6_K',
    'hf.co/efficiencyx/Jun-LoRA-E2B-GGUF:Q4_K_M',
    'llama3.1:8b', 'llama3.1:latest',
  ];
  const isChat = (n) => !/embed/i.test(n);
  const saved = localStorage.getItem('model');
  const picked = (saved && m.models.includes(saved) ? saved : null)
    || (m.default_model && m.models.includes(m.default_model) ? m.default_model : null)
    || prefer.find(p => m.models.includes(p))
    || m.models.find(isChat)
    || m.models[0];
  if (picked) modelSelect.value = picked;
  dismissBoot();

  try {
    let convs = await History.list();
    if (convs.length === 0) {
      const { id } = await History.create();
      convs = [{ id, title: null }];
    }
    await refreshSidebar();
    await loadConversation(convs[0].id);
  } catch (e) {
    console.warn('[History] init failed:', e.message);
  }
}

// Settings > Dates. "Ask her" is just a chat line, she decides and
// calls the tool. "Force her" is the old direct jump, admin only
// (or FREE_ROAM=on), and it still has to write the grant first or
// the page bounces straight back here.
// same cutoff as date.js, the page decides the menu off the same
// clock
const ASK_LINES = {
  shop: "Wanna go to Annalie's shop with me?",
  karaoke: 'Sing with me? Karaoke, tonight.',
  cards: 'Deal me in. One game of blackjack?',
  date: () => mealNow() === 'lunch' ? 'Wanna go out for lunch? My treat.' : 'Wanna go out for dinner tonight? My treat.',
};

function prefetchOnce(hrefs) {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const [href, as] of hrefs) {
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.as = as;
      link.href = href;
      document.head.appendChild(link);
    }
  };
}

async function wireDatesPanel(canForce) {
  const dateTitle = document.getElementById('dateRowTitle');
  if (dateTitle) {
    const label = () => { dateTitle.textContent = mealNow() === 'lunch' ? 'Lunch out' : 'Dinner out'; };
    label();
    setInterval(label, 60000);
  }
  for (const [where, line] of Object.entries(ASK_LINES)) {
    const ask = document.getElementById('ask' + where[0].toUpperCase() + where.slice(1) + 'Btn');
    if (!ask) continue;
    ask.addEventListener('click', () => {
      ui.toggleDrawer(false);
      chatInput.value = typeof line === 'function' ? line() : line;
      sendMessage({ invite: where });
    });
  }
  if (!canForce) return;
  document.querySelectorAll('.force-btn').forEach(b => { b.hidden = false; });

  const grant = (where) => fetch('api/trip.php?action=go', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ where, conversation_id: currentConversationId }),
  }).catch(() => {});

  const wBtn = document.getElementById('wardrobeBtn');
  if (wBtn) {
    const prefetchShop = prefetchOnce([['wardrobe.html', 'document'], ['wardrobe-cutscene.webm', 'video']]);
    wBtn.addEventListener('pointerenter', prefetchShop);
    wBtn.addEventListener('focus', prefetchShop);
    wBtn.addEventListener('click', async () => {
      prefetchShop();
      ui.toggleDrawer(false);
      if (wBtn.disabled) return;
      wBtn.disabled = true;
      await grant('shop');
      try { await playIntro(); } catch (e) {}
      location.href = 'wardrobe.html';
    });
  }

  const dateBtn = document.getElementById('forceDateBtn');
  if (dateBtn) {
    const prefetchDate = prefetchOnce([['date.html', 'document'], ['wardrobe-cutscene.webm', 'video']]);
    dateBtn.addEventListener('pointerenter', prefetchDate);
    dateBtn.addEventListener('focus', prefetchDate);
    dateBtn.addEventListener('click', async () => {
      ui.toggleDrawer(false);
      await grant('date');
      location.href = 'date.html';
    });
  }

  const cardsBtn = document.getElementById('forceCardsBtn');
  if (cardsBtn) cardsBtn.addEventListener('click', () => {
    ui.toggleDrawer(false);
    Cards.open();
  });

  const karaokeBtn = document.getElementById('karaokeOpenBtn');
  if (!karaokeBtn) return;
  const prefetchKaraoke = prefetchOnce([['karaoke.html', 'document']]);
  karaokeBtn.addEventListener('pointerenter', prefetchKaraoke, { once: true });
  karaokeBtn.addEventListener('focus', prefetchKaraoke, { once: true });
  karaokeBtn.addEventListener('click', async () => {
    ui.toggleDrawer(false);
    await grant('karaoke');
    location.href = 'karaoke.html';
  });
  try {
    const response = await fetch('/api/karaoke.php?action=health', { credentials: 'same-origin' });
    const health = response.ok ? await response.json() : null;
    if (health && health.sep) {
      karaokeBtn.disabled = false;
      karaokeBtn.title = health.device === 'cpu'
        ? 'Sing together (CPU - separation is slow)'
        : 'Sing together';
    } else {
      karaokeBtn.title = 'Unavailable: the karaoke sidecar is not running';
    }
  } catch (e) {
    karaokeBtn.title = 'Unavailable: could not reach the karaoke sidecar';
  }
}

function validateActionMap(modelParamIds, actionMap) {
  const known = new Set(modelParamIds);
  const referenced = new Set();
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('Param')) referenced.add(k);
      else if (k === '_param' && typeof v === 'string') referenced.add(v);
      else if (k === '_loop_param' && typeof v === 'string') referenced.add(v);
      else if (typeof v === 'object') walk(v);
    }
  }
  walk(actionMap);
  const missing = [...referenced].filter(p => !known.has(p));
  if (missing.length) {
    logAction('warn', `boot: ${missing.length} params missing in model: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}`);
    for (const p of missing) {
      const row = document.createElement('div');
      row.className = 'row warn';
      row.textContent = p;
      missingParamsEl.appendChild(row);
    }
  } else {
    logAction('ok', `boot: all ${referenced.size} mapped params exist`);
  }
}
