import { appendMsg, currentConversationId, discardActiveResponse, messages, renderMarkdown, setConversationTitle, setCurrentConversationId, updateEmptyState } from '../app.js?v=71';
import { IDLE_AFTER_JOIN_MS, cancelAutoReset, reportActivity, resetIdleNudge, scheduleIdleNudge } from './consolidation.js?v=71';
import { conversationSidebar, messagesEl, mobileConversationTitle, mobileMenuBtn, narrowSidebarQuery, reloadPromptBtn, resetLive2DBtn, sidebarBackdrop, sidebarBackground } from './dom.js?v=71';
import { announceMobileReply, faceBubble, hideFaceBubble, latestAssistantReply, scheduleFaceBubbleHide, setLatestAssistantReply, showFaceBubble } from './face-bubble.js?v=71';
import { logAction } from './logging.js?v=71';
import { makeStreamBuffer } from './stream-filters.js?v=71';
import { escapeHtml, phoneMode } from './util.js?v=71';

const conversationTitles = new Map();
let sidebarRefreshGeneration = 0;
let conversationLoadGeneration = 0;
export async function refreshSidebar() {
  if (!window.History) return;
  const ul = document.getElementById('conversationList');
  if (!ul) return;
  const refreshGeneration = ++sidebarRefreshGeneration;
  let convs;
  try { convs = await History.list(); } catch (e) { return; }
  if (refreshGeneration !== sidebarRefreshGeneration) return;
  ul.innerHTML = '';
  conversationTitles.clear();
  for (const c of convs) {
    const li = document.createElement('li');
    li.className = 'conv-item' + (c.id === currentConversationId ? ' active' : '');
    li.dataset.id = String(c.id);
    const title = c.title || 'New conversation';
    conversationTitles.set(c.id, title);
    li.innerHTML = `<button class="conv-open" type="button"><span class="conv-title">${escapeHtml(title)}</span></button>`
      + `<button class="conv-rename" type="button" title="Rename conversation" aria-label="Rename conversation">`
      + `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="M15 5l4 4"/></svg>`
      + `</button>`
      + `<button class="conv-delete" type="button" title="Delete conversation" aria-label="Delete conversation">`
      + `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>`
      + `</button>`;
    const openBtn = li.querySelector('.conv-open');
    if (c.id === currentConversationId) openBtn.setAttribute('aria-current', 'page');
    openBtn.addEventListener('click', () => {
      setSidebarOpen(false);
      loadConversation(c.id);
    });
    const renameBtn = li.querySelector('.conv-rename');
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startRename(li, c.id);
    });
    const delBtn = li.querySelector('.conv-delete');
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteConversation(c.id, title);
    });
    ul.appendChild(li);
  }
  if (currentConversationId != null) setConversationTitle(conversationTitles.get(currentConversationId));
}

function startRename(li, id) {
  if (!window.History) return;
  const titleSpan = li.querySelector('.conv-title');
  if (!titleSpan) return;
  const oldTitle = conversationTitles.get(id) ?? titleSpan.textContent;

  const input = document.createElement('input');
  input.className = 'conv-title-input';
  input.type = 'text';
  input.value = oldTitle;
  titleSpan.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const restore = (text) => {
    const span = document.createElement('span');
    span.className = 'conv-title';
    span.textContent = text;
    input.replaceWith(span);
  };

  const commit = async () => {
    if (settled) return;
    settled = true;
    const next = input.value.trim();
    if (!next || next === oldTitle) {
      restore(oldTitle);
      return;
    }
    try {
      await History.rename(id, next);
      conversationTitles.set(id, next);
      restore(next);
      if (id === currentConversationId) setConversationTitle(next);
    } catch (e) {
      ui.toast('Failed to rename conversation: ' + e.message, 'error');
      restore(oldTitle);
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      settled = true;
      restore(oldTitle);
    }
  });
  input.addEventListener('blur', commit);
}

async function deleteConversation(id, title) {
  if (!window.History) return;
  const ok = await ui.confirm({
    title: 'Delete chat',
    message: `Do you want to delete Jun's memory of "${title}"?`,
    confirmLabel: 'Delete',
    cancelLabel: 'Cancel',
    danger: true,
  });
  if (!ok) return;
  if (id === currentConversationId) {
    discardActiveResponse();
    conversationLoadGeneration++;
  }
  try {
    await History.delete(id);
    if (id === currentConversationId) {
      const convs = await History.list();
      if (convs.length > 0) {
        await refreshSidebar();
        await loadConversation(convs[0].id);
      } else {
        const { id: newId } = await History.create();
        await refreshSidebar();
        await loadConversation(newId);
      }
    } else {
      await refreshSidebar();
    }
  } catch (e) {
    ui.toast('Failed to delete conversation: ' + e.message, 'error');
  }
}

function markSidebarActive(id) {
  document.querySelectorAll('#conversationList .conv-item').forEach(el => {
    const active = Number(el.dataset.id) === id;
    el.classList.toggle('active', active);
    const openBtn = el.querySelector('.conv-open');
    if (!openBtn) return;
    if (active) openBtn.setAttribute('aria-current', 'page');
    else openBtn.removeAttribute('aria-current');
  });
}

export async function loadConversation(id) {
  discardActiveResponse();
  const loadGeneration = ++conversationLoadGeneration;
  setCurrentConversationId(id);
  cancelAutoReset();
  hideFaceBubble();
  setLatestAssistantReply('');
  setConversationTitle(conversationTitles.get(id));
  resetIdleNudge(); // fresh context - let Jun nudge again
  reportActivity();
  if (window.TTS) TTS.stop();
  messages.length = 0;
  messagesEl.innerHTML = '';
  updateEmptyState();
  Live2D.resetIdle();
  Live2D.startIdle();
  markSidebarActive(id);
  scheduleIdleNudge(IDLE_AFTER_JOIN_MS);
  if (!window.History) return;
  try {
    const rows = await History.load(id);
    if (loadGeneration !== conversationLoadGeneration || currentConversationId !== id) return;
    let latest = '';
    for (const row of rows) {
      if (row.role === 'user') {
        appendMsg('user', row.content);
        messages.push({ role: 'user', content: row.content });
      } else if (row.role === 'assistant') {
        const el = appendMsg('assistant', '');
        let visible = '';
        const sb = makeStreamBuffer(clean => { visible += clean; });
        sb.push(row.content);
        sb.flush();
        const shown = window.Names ? Names.apply(visible) : visible;
        el.innerHTML = renderMarkdown(shown);
        latest = shown;
        messages.push({ role: 'assistant', content: visible });
      }
    }
    setLatestAssistantReply(latest);
    setConversationTitle(conversationTitles.get(id));
  } catch (e) {
    if (loadGeneration !== conversationLoadGeneration || currentConversationId !== id) return;
    ui.toast('Failed to load conversation: ' + e.message, 'error');
  }
}

let sidebarOpener = null;

export function setSidebarOpen(open) {
  if (!conversationSidebar || !sidebarBackdrop || !mobileMenuBtn) return;
  open = !!open && narrowSidebarQuery.matches;
  const wasOpen = document.body.classList.contains('sidebar-open');
  if (open && !wasOpen) sidebarOpener = document.activeElement;
  document.body.classList.toggle('sidebar-open', open);
  conversationSidebar.classList.toggle('mobile-open', open);
  sidebarBackdrop.classList.toggle('open', open);
  sidebarBackdrop.setAttribute('aria-hidden', String(!open));
  mobileMenuBtn.setAttribute('aria-expanded', String(open));
  mobileMenuBtn.setAttribute('aria-label', open ? 'Close conversations' : 'Open conversations');
  [...sidebarBackground, document.getElementById('toasts'), document.getElementById('devHud')]
    .filter(Boolean).forEach(element => {
    element.inert = open;
    if (open) element.setAttribute('aria-hidden', 'true');
    else element.removeAttribute('aria-hidden');
  });
  if (narrowSidebarQuery.matches) {
    conversationSidebar.setAttribute('aria-hidden', String(!open));
    conversationSidebar.inert = !open;
  } else {
    conversationSidebar.removeAttribute('aria-hidden');
    conversationSidebar.inert = false;
  }
  if (open) {
    const first = conversationSidebar.querySelector('button:not([disabled]), [href]');
    if (first) first.focus();
  } else if (wasOpen && sidebarOpener && sidebarOpener.focus && document.contains(sidebarOpener)) {
    sidebarOpener.focus();
    sidebarOpener = null;
  }
}

function syncSidebarLayout() {
  setSidebarOpen(false);
  if (!narrowSidebarQuery.matches && conversationSidebar) {
    conversationSidebar.removeAttribute('aria-hidden');
    conversationSidebar.inert = false;
  }
}

if (mobileMenuBtn) mobileMenuBtn.addEventListener('click', () => setSidebarOpen(true));
if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', () => setSidebarOpen(false));
if (mobileConversationTitle) {
  mobileConversationTitle.addEventListener('click', (event) => {
    if (!phoneMode() || !latestAssistantReply) return;
    showFaceBubble(renderMarkdown(latestAssistantReply), 'phone');
    announceMobileReply(latestAssistantReply);
    scheduleFaceBubbleHide(latestAssistantReply, 'phone');
    if (event.detail === 0) faceBubble.focus({ preventScroll: true });
  });
}
if (conversationSidebar) {
  conversationSidebar.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('sidebar-open')) {
      e.preventDefault();
      setSidebarOpen(false);
      return;
    }
    if (e.key !== 'Tab' || !document.body.classList.contains('sidebar-open')) return;
    const focusable = [...conversationSidebar.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.hidden && el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}
if (narrowSidebarQuery.addEventListener) narrowSidebarQuery.addEventListener('change', syncSidebarLayout);
else narrowSidebarQuery.addListener(syncSidebarLayout);
syncSidebarLayout();

const newChatBtn = document.getElementById('newChatBtn');
if (newChatBtn) {
  newChatBtn.addEventListener('click', async () => {
    if (!window.History) return;
    reportActivity();
    setSidebarOpen(false);
    discardActiveResponse();
    const requestGeneration = ++conversationLoadGeneration;
    newChatBtn.disabled = true;
    try {
      const { id } = await History.create();
      await refreshSidebar();
      if (requestGeneration !== conversationLoadGeneration) return;
      await loadConversation(id);
    } catch (e) {
      if (requestGeneration !== conversationLoadGeneration) return;
      ui.toast('Failed to create conversation: ' + e.message, 'error');
    } finally {
      newChatBtn.disabled = false;
    }
  });
}

resetLive2DBtn.addEventListener('click', () => {
  cancelAutoReset();
  Live2D.resetIdle();
  Live2D.startIdle();
  logAction('ok', '↺ reset pose');
});

reloadPromptBtn.addEventListener('click', () => {
  logAction('ok', 'system prompt will be reloaded on next send');
});
