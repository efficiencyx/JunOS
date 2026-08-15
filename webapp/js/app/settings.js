import { abortFn, currentConversationId, sendMessage } from '../app.js?v=2';
import { cancelIdleNudge } from './consolidation.js?v=2';
import { closeSettingsBtn, devNoIdleChk, drawerBackdrop, modelSelect, openSettingsBtn, reasoningSelect, sendBtn, siteVolumeInput, thinkChk, ttsChk, ttsSpeedInput, voiceChk, voiceSilenceInput } from './dom.js?v=2';
import { logAction } from './logging.js?v=2';
import { loadMood } from './mood.js?v=2';
import { loadConversation, setSidebarOpen } from './sidebar.js?v=2';

export function syncThinkToggle() {
  thinkChk.disabled = reasoningSelect.value === 'auto';
}

// On device LiteRT-LM takes neither of these, it always generates the same way.
// Showing them cost a tester a whole round of "auto answers, hard doesn't" when
// the setting had never done anything.
export function applyProviderCapabilities(provider) {
  if (provider !== 'litertlm-android') return;
  for (const id of ['reasoningRow', 'thinkRow']) {
    const row = document.getElementById(id);
    if (row) row.style.display = 'none';
  }
}
reasoningSelect.addEventListener('change', syncThinkToggle);
syncThinkToggle();

function persistPref(key, value) {
  localStorage.setItem(key, value);
  if (window.Prefs) Prefs.pushToServer();
}
modelSelect.addEventListener('change', () => persistPref('model', modelSelect.value));
reasoningSelect.addEventListener('change', () => persistPref('reasoning_level', reasoningSelect.value));
thinkChk.addEventListener('change', () => persistPref('think', thinkChk.checked ? '1' : '0'));
devNoIdleChk.addEventListener('change', () => {
  if (devNoIdleChk.checked) cancelIdleNudge();
  persistPref('no_idle_nudges', devNoIdleChk.checked ? '1' : '0');
});

sendBtn.addEventListener('click', sendMessage);
export function wireNameSettings() {
  const playerInput = document.getElementById('playerNameInput');
  const botInput = document.getElementById('botNameInput');
  if (!window.Names) return;
  if (playerInput) { playerInput.value = Names.getPlayer(); playerInput.placeholder = Names.DEFAULT_PLAYER; }
  if (botInput) { botInput.value = Names.getBot(); botInput.placeholder = Names.DEFAULT_BOT; }
  function commit() {
    if (playerInput) Names.setPlayer(playerInput.value);
    if (botInput) Names.setBot(botInput.value);
    if (playerInput) playerInput.value = Names.getPlayer();
    if (botInput) botInput.value = Names.getBot();
    if (window.Prefs) Prefs.pushToServer();
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
    if (window.MemoryGraph) MemoryGraph.setActive(key === 'memory');
    if (key === 'memory') { loadMemories(); loadMood(); }
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
  if (window.TTS && TTS.setVolume) TTS.setVolume(volume);
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
async function loadMemories() {
  if (!window.MemoryGraph) return;
  MemoryGraph.setActive(true);
  MemoryGraph.setStatus('Loading…');
  try {
    const r = await fetch('/api/memory.php', { credentials: 'same-origin' });
    if (!r.ok) throw new Error('http ' + r.status);
    const memoryData = await r.json();
    if (memoryCount) memoryCount.textContent = Array.isArray(memoryData.notes) ? memoryData.notes.length : 0;
    MemoryGraph.setData(memoryData);
  } catch (e) {
    MemoryGraph.setStatus('Could not load memories.');
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
if (memoryClearBtn) memoryClearBtn.addEventListener('click', async () => {
  const ok = await ui.confirm({
    title: 'Delete all memories',
    message: 'Delete every saved note and journal entry? This cannot be undone.',
    confirmLabel: 'Delete all',
    cancelLabel: 'Cancel',
    danger: true,
  });
  if (!ok) return;
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

const aboutRow = document.getElementById('aboutRow');
const devAccessRow = document.getElementById('devAccessRow');
const devAccessDesc = document.getElementById('devAccessDesc');
const adminKeyInput = document.getElementById('adminKeyInput');
const promoteBtn = document.getElementById('promoteBtn');
let isAdmin = false;

export function applyRoleGates(user) {
  isAdmin = user?.role === 'admin';
  // Hidden, never taken out of the page. logging.js grabs the buttons inside
  // the developer panel at import time and would throw on a missing node.
  const devTab = document.querySelector('.settings-navitem[data-panel="developer"]');
  if (devTab) devTab.hidden = !isAdmin;
  // Everyone else wipes memories through Factory Reset, the DELETE is admin only.
  if (memoryClearBtn) memoryClearBtn.hidden = !isAdmin;
  const devBadge = document.getElementById('devBadge');
  if (devBadge) devBadge.hidden = !isAdmin;
  if (isAdmin && devAccessRow) {
    devAccessRow.hidden = false;
    if (devAccessDesc) devAccessDesc.textContent = 'Developer access is enabled on this account.';
    if (adminKeyInput) adminKeyInput.hidden = true;
    if (promoteBtn) promoteBtn.hidden = true;
  }
}

const ABOUT_TAP_GAP_MS = 3000;
let aboutTaps = 0;
let aboutTapTimer = null;
if (aboutRow) aboutRow.addEventListener('click', () => {
  if (isAdmin) return;
  clearTimeout(aboutTapTimer);
  aboutTapTimer = setTimeout(() => { aboutTaps = 0; }, ABOUT_TAP_GAP_MS);
  if (++aboutTaps < 7) return;
  aboutTaps = 0;
  clearTimeout(aboutTapTimer);
  if (devAccessRow) devAccessRow.hidden = false;
  if (adminKeyInput) adminKeyInput.focus();
});

if (promoteBtn) promoteBtn.addEventListener('click', async () => {
  promoteBtn.disabled = true;
  try {
    const r = await fetch('/api/auth.php?action=promote', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: adminKeyInput?.value || '' }),
    });
    if (r.ok) {
      ui.toast('Developer tools unlocked.', 'ok');
      location.reload();
      return;
    }
    const j = await r.json().catch(() => ({}));
    const msgs = { invalid_admin_key: 'Wrong key.', admin_promotion_disabled: 'Developer access is disabled on this server.' };
    if (devAccessDesc) devAccessDesc.textContent = msgs[j.error] || 'Could not unlock developer access.';
  } catch (e) {
    if (devAccessDesc) devAccessDesc.textContent = 'Network error.';
  }
  promoteBtn.disabled = false;
});

const factoryResetBtn = document.getElementById('factoryResetBtn');
if (factoryResetBtn) factoryResetBtn.addEventListener('click', async () => {
  const ok = await ui.confirm({
    title: 'Factory Reset',
    message: 'Erase every conversation, memory and setting on this account? This cannot be undone.',
    confirmLabel: 'Erase everything',
    cancelLabel: 'Cancel',
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await fetch('/api/auth.php?action=factory_reset', { method: 'POST', credentials: 'same-origin' });
    if (!r.ok) throw new Error('http ' + r.status);
  } catch (e) {
    logAction('err', 'factory reset failed');
    ui.toast('Factory reset failed.', 'error');
    return;
  }
  if (window.Prefs) Prefs.clearLocal();
  location.reload();
});
