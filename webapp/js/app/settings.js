import { abortFn, currentConversationId } from './session.js?v=1';
import { sendMessage } from './chat.js?v=73';
import { cancelIdleNudge } from './consolidation.js?v=146';
import { closeSettingsBtn, devNoIdleChk, drawerBackdrop, modelSelect, openSettingsBtn, reasoningSelect, sendBtn, siteVolumeInput, thinkChk, ttsChk, ttsSpeedInput, voiceChk, voiceSilenceInput } from './dom.js?v=77';
import { logAction } from './logging.js?v=78';
import { loadMood, setMoodEditingEnabled } from './mood.js?v=93';
import { loadConversation, setSidebarOpen } from './sidebar.js?v=146';
import { loadTimeline } from './timeline.js?v=4';
import * as Names from '../core/names.js?v=1';
import { locale, t } from '../core/i18n.js?v=1';
import * as Prefs from '../core/prefs.js?v=9';
import * as ui from '../core/ui.js?v=11';
import { hold } from '../core/hold.js?v=2';
import { factoryReset } from './difficulty.js?v=5';
import * as TTS from '../voice/tts.js?v=94';

export function syncThinkToggle() {
  thinkChk.disabled = reasoningSelect.value === 'auto';
}

reasoningSelect.addEventListener('change', syncThinkToggle);
syncThinkToggle();

function persistPref(key, value) {
  localStorage.setItem(key, value);
  Prefs.pushToServer();
}
modelSelect.addEventListener('change', () => persistPref('model', modelSelect.value));
reasoningSelect.addEventListener('change', () => persistPref('reasoning_level', reasoningSelect.value));
thinkChk.addEventListener('change', () => persistPref('think', thinkChk.checked ? '1' : '0'));
devNoIdleChk.addEventListener('change', () => {
  if (devNoIdleChk.checked) cancelIdleNudge();
  persistPref('no_idle_nudges', devNoIdleChk.checked ? '1' : '0');
});
const uiLangSelect = document.getElementById('uiLangSelect');
uiLangSelect.value = localStorage.getItem('ui.lang') || 'auto';
uiLangSelect.addEventListener('change', () => {
  persistPref('ui.lang', uiLangSelect.value);
  location.reload();
});

sendBtn.addEventListener('click', sendMessage);
export function wireNameSettings() {
  const playerInput = document.getElementById('playerNameInput');
  const botInput = document.getElementById('botNameInput');
  if (playerInput) { playerInput.value = Names.getPlayer(); playerInput.placeholder = Names.DEFAULT_PLAYER; }
  if (botInput) { botInput.value = Names.getBot(); botInput.placeholder = Names.DEFAULT_BOT; }
  function commit() {
    if (playerInput) Names.setPlayer(playerInput.value);
    if (botInput) Names.setBot(botInput.value);
    if (playerInput) playerInput.value = Names.getPlayer();
    if (botInput) botInput.value = Names.getBot();
    Prefs.pushToServer();
    // decorate only ever rewrites Jun/Anon, so renaming her twice in
    // one session leaves the first name sitting in the markup. reload
    // for that.
    Names.decorate();
    if (!abortFn && currentConversationId != null) loadConversation(currentConversationId);
  }
  if (playerInput) playerInput.addEventListener('change', commit);
  if (botInput) botInput.addEventListener('change', commit);
}

if (openSettingsBtn) openSettingsBtn.addEventListener('click', () => {
  setSidebarOpen(false);
  ui.toggleDrawer(true);
});
if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', () => ui.toggleDrawer(false));
if (drawerBackdrop) drawerBackdrop.addEventListener('click', () => ui.toggleDrawer(false));

const userChipBtn = document.getElementById('userChipBtn');
if (userChipBtn) userChipBtn.addEventListener('click', () => {
  setSidebarOpen(false);
  ui.toggleDrawer(true);
});

const settingsNavItems = document.querySelectorAll('.settings-navitem');
const settingsPanels = document.querySelectorAll('.settings-panel');
const settingsPanelTitle = document.getElementById('settingsPanelTitle');
settingsNavItems.forEach((item, idx) => {
  item.addEventListener('click', () => {
    const key = item.dataset.panel;
    settingsNavItems.forEach((n) => {
      const on = n === item;
      n.classList.toggle('active', on);
      n.setAttribute('aria-selected', on ? 'true' : 'false');
      n.tabIndex = on ? 0 : -1;
    });
    settingsPanels.forEach((p) => { p.hidden = p.dataset.panel !== key; });
    const label = item.querySelector('span');
    if (settingsPanelTitle && label) settingsPanelTitle.textContent = label.textContent;
    if (key === 'developer') loadMood();
    if (MemoryGraph) MemoryGraph.setActive(key === 'memory');
    if (key === 'memory') { loadMemories(); loadMood(); loadTimeline(); }
  });
  item.tabIndex = item.classList.contains('active') ? 0 : -1;
  item.addEventListener('keydown', (e) => {
    let target = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') target = (idx + 1) % settingsNavItems.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') target = (idx - 1 + settingsNavItems.length) % settingsNavItems.length;
    else if (e.key === 'Home') target = 0;
    else if (e.key === 'End') target = settingsNavItems.length - 1;
    if (target < 0) return;
    e.preventDefault();
    settingsNavItems[target].focus();
    settingsNavItems[target].click();
  });
});

export function updateTtsSpeedLabel() {
  const out = document.getElementById('ttsSpeedVal');
  if (out && ttsSpeedInput) out.textContent = parseFloat(ttsSpeedInput.value).toFixed(2).replace(/0$/, '') + '×';
}
export function setSiteVolume(value) {
  const volume = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
  TTS.setVolume(volume);
  return volume;
}
export function updateSiteVolumeLabel() {
  const out = document.getElementById('siteVolumeVal');
  if (out && siteVolumeInput) out.textContent = Math.round(parseFloat(siteVolumeInput.value) || 0) + '%';
}
export function updateVoiceSilenceLabel() {
  const out = document.getElementById('voiceSilenceVal');
  if (out && voiceSilenceInput) out.textContent = voiceSilenceInput.value + ' ms';
}

export function syncVoiceDeps() {
  const on = { tts: !!(ttsChk && ttsChk.checked), mic: !!(voiceChk && voiceChk.checked) };
  document.querySelectorAll('#settingsDrawer .set-row[data-dep]').forEach((row) => {
    row.classList.toggle('disabled', !on[row.dataset.dep]);
  });
}
syncVoiceDeps();

const memoryCount = document.getElementById('memoryCount');
// the graph only loads once somebody actually opens this panel
let MemoryGraph = null;
async function loadMemories() {
  if (!MemoryGraph) {
    MemoryGraph = await import('./memory-graph.js?v=8');
    const { renderNoteActions } = await import('./memory-actions.js?v=6');
    MemoryGraph.onNoteActions((node, body) => renderNoteActions(node, body, { isAdmin, reload: loadMemories }));
    MemoryGraph.onOpenChat((conv, messageId) => {
      ui.toggleDrawer(false);
      setSidebarOpen(false);
      loadConversation(conv, messageId ? { messageId } : null);
    });
  }
  MemoryGraph.setActive(true);
  MemoryGraph.setStatus(t('common.loading', 'Loading…'));
  try {
    const r = await fetch('/api/memory.php', { credentials: 'same-origin' });
    if (!r.ok) throw new Error('http ' + r.status);
    const memoryData = await r.json();
    if (memoryCount) memoryCount.textContent = Array.isArray(memoryData.notes) ? memoryData.notes.length : 0;
    MemoryGraph.setData(memoryData);
  } catch (e) {
    MemoryGraph.setStatus(t('memory.loadFailed', 'Could not load memories.'));
  }
}
const memoryAddBtn = document.getElementById('memoryAddBtn');
const memoryAddInput = document.getElementById('memoryAddInput');
const memoryAddCategory = document.getElementById('memoryAddCategory');
async function addMemory() {
  const memory = (memoryAddInput?.value || '').trim();
  if (!memory) return;
  try {
    const r = await fetch('/api/memory.php', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memory, category: (memoryAddCategory?.value || '').trim() || 'general' }),
    });
    if (!r.ok) throw new Error('http ' + r.status);
    memoryAddInput.value = '';
  } catch (e) {
    logAction('err', 'failed to add memory');
  }
  loadMemories();
}
if (memoryAddBtn) memoryAddBtn.addEventListener('click', addMemory);
if (memoryAddInput) memoryAddInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addMemory(); });
const memoryClearBtn = document.getElementById('memoryClearBtn');
if (memoryClearBtn) hold(memoryClearBtn, async () => {
  try {
    const r = await fetch('/api/memory.php', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
    if (!r.ok) throw new Error('http ' + r.status);
  } catch (e) {
    logAction('err', 'failed to clear memories');
  }
  loadMemories();
});

const aboutText = document.getElementById('aboutText');
const devAccessRow = document.getElementById('devAccessRow');
const devAccessDesc = document.getElementById('devAccessDesc');
const devKeyInput = document.getElementById('devKeyInput');
const promoteBtn = document.getElementById('promoteBtn');
let isAdmin = false;

export function applyRoleGates(user) {
  isAdmin = user?.role === 'admin';
  document.documentElement.classList.toggle('is-admin', isAdmin);
  setMoodEditingEnabled(isAdmin);
  // Hidden, never taken out of the page. logging.js grabs the
  // buttons inside the developer panel at import time and would
  // throw on a missing node.
  const devTab = document.querySelector('.settings-navitem[data-panel="developer"]');
  if (devTab) devTab.hidden = !isAdmin;
  // Everyone else wipes memories through Factory Reset, the DELETE
  // is admin only.
  if (memoryClearBtn) memoryClearBtn.hidden = !isAdmin;
  for (const id of ['devBadge', 'statusPill', 'resetLive2DBtn', 'ratingsExportRow', 'fleeSkipBtn']) {
    const el = document.getElementById(id);
    if (el) el.hidden = !isAdmin;
  }
  if (isAdmin && devAccessRow) {
    devAccessRow.hidden = false;
    if (devAccessDesc) devAccessDesc.textContent = t('settings.devAccess.enabled', 'Developer access is enabled on this account.');
    if (devKeyInput) devKeyInput.hidden = true;
    if (promoteBtn) promoteBtn.hidden = true;
  }
}

const ABOUT_TAP_GAP_MS = 3000;
let aboutTaps = 0;
let aboutTapTimer = null;
if (aboutText) aboutText.addEventListener('click', () => {
  if (isAdmin) return;
  clearTimeout(aboutTapTimer);
  aboutTapTimer = setTimeout(() => { aboutTaps = 0; }, ABOUT_TAP_GAP_MS);
  if (++aboutTaps < 7) return;
  aboutTaps = 0;
  clearTimeout(aboutTapTimer);
  if (devAccessRow) devAccessRow.hidden = false;
  if (devKeyInput) devKeyInput.focus();
});

if (promoteBtn) promoteBtn.addEventListener('click', async () => {
  promoteBtn.disabled = true;
  try {
    const r = await fetch('/api/auth.php?action=promote', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: devKeyInput?.value || '' }),
    });
    if (r.ok) {
      ui.toast(t('settings.devAccess.unlocked', 'Developer tools unlocked.'), 'ok');
      location.reload();
      return;
    }
    const j = await r.json().catch(() => ({}));
    const msgs = { invalid_dev_key: t('settings.devAccess.wrongKey', 'Wrong key.'), dev_promotion_disabled: t('settings.devAccess.disabled', 'Developer access is disabled on this server.') };
    if (r.status === 429 || j.error === 'rate_limit_exceeded') {
      const retryAfter = Number(j.retry_after || r.headers.get('Retry-After'));
      let wait = t('time.aMoment', 'a moment');
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        const n = Math.ceil(retryAfter < 60 ? retryAfter : retryAfter / 60);
        if (retryAfter < 60) wait = n === 1 ? t('time.second', '1 second') : t('time.seconds', '{n} seconds', { n });
        else wait = n === 1 ? t('time.minute', '1 minute') : t('time.minutes', '{n} minutes', { n });
      }
      if (devAccessDesc) devAccessDesc.textContent = t('settings.devAccess.tooMany', 'Too many attempts. Try again in {wait}.', { wait });
    } else if (devAccessDesc) {
      devAccessDesc.textContent = msgs[j.error] || t('settings.devAccess.failed', 'Could not unlock developer access.');
    }
  } catch (e) {
    if (devAccessDesc) devAccessDesc.textContent = t('common.networkError', 'Network error.');
  }
  promoteBtn.disabled = false;
});

const ratingsExportBtn = document.getElementById('ratingsExportBtn');
if (ratingsExportBtn) ratingsExportBtn.addEventListener('click', () => {
  location.href = 'api/ratings.php?action=export';
});

const passwordRow = document.getElementById('passwordRow');
const passwordDesc = document.getElementById('passwordDesc');
if (passwordRow) passwordRow.addEventListener('submit', async (e) => {
  e.preventDefault();
  const current = document.getElementById('currentPasswordInput');
  const next = document.getElementById('newPasswordInput');
  const btn = document.getElementById('changePasswordBtn');
  const msgs = {
    invalid_credentials: t('settings.password.wrong', 'Current password is wrong.'),
    password_too_short: t('settings.password.short', 'New password needs at least 8 characters.'),
    rate_limit_exceeded: t('settings.password.rateLimit', 'Too many tries, wait an hour.'),
  };
  btn.disabled = true;
  try {
    const r = await fetch('api/auth.php?action=change_password', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: current.value, password: next.value }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      passwordRow.reset();
      passwordDesc.textContent = t('settings.password.changed', 'Changed. Other devices are signed out.');
    } else {
      passwordDesc.textContent = msgs[j.error] || t('settings.password.failed', 'Could not change the password.');
    }
  } catch (err) {
    passwordDesc.textContent = t('common.networkError', 'Network error.');
  }
  btn.disabled = false;
});

const factoryResetBtn = document.getElementById('factoryResetBtn');
if (factoryResetBtn) hold(factoryResetBtn, () => factoryReset().catch(() => {
  logAction('err', 'factory reset failed');
  ui.toast(t('settings.reset.failed', 'Factory reset failed.'), 'error');
}));

const bridgeRow = document.getElementById('bridgeRow');
const bridgeDesc = document.getElementById('bridgeDesc');
const bridgeToken = document.getElementById('bridgeTokenInput');
const bridgePairBtn = document.getElementById('bridgePairBtn');
const bridgeUnpairBtn = document.getElementById('bridgeUnpairBtn');

function showBridge(status) {
  bridgeRow.hidden = !status.enabled;
  const paired = !!status.paired_at;
  bridgeUnpairBtn.hidden = !paired;
  bridgePairBtn.textContent = paired ? t('settings.bridge.newToken', 'New token') : t('settings.bridge.pair', 'Pair');
  if (!paired) bridgeDesc.textContent = t('settings.bridge.notPaired', 'Not paired. Signing in from the game pairs it.');
  else if (status.synced_at) bridgeDesc.textContent = t('settings.bridge.synced', 'Last synced {when}.', { when: new Date(status.synced_at * 1000).toLocaleString(locale) });
  else bridgeDesc.textContent = t('settings.bridge.noSync', 'Paired, no sync yet.');
}

async function loadBridge() {
  try {
    const r = await fetch('api/bridge-pair.php', { credentials: 'same-origin' });
    if (r.ok) showBridge(await r.json());
  } catch (e) {}
}

if (bridgeRow) {
  loadBridge();
  bridgePairBtn.addEventListener('click', async () => {
    bridgePairBtn.disabled = true;
    try {
      const r = await fetch('api/bridge-pair.php', { method: 'POST', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.token) throw new Error('http ' + r.status);
      await loadBridge();
      bridgeToken.value = j.token;
      bridgeToken.hidden = false;
      bridgeToken.select();
      bridgeDesc.textContent = t('settings.bridge.paste', 'Paste it as Token under [Sync] in the mod\'s UserData/JunBridge.cfg. It only shows once.');
    } catch (e) {
      bridgeDesc.textContent = t('settings.bridge.failed', 'Could not pair.');
    }
    bridgePairBtn.disabled = false;
  });
  bridgeUnpairBtn.addEventListener('click', async () => {
    try {
      await fetch('api/bridge-pair.php', { method: 'DELETE', credentials: 'same-origin' });
    } catch (e) {}
    bridgeToken.hidden = true;
    bridgeToken.value = '';
    loadBridge();
  });
}
