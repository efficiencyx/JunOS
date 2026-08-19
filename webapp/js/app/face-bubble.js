import { currentConversationTitle, setConversationTitle } from '../app.js?v=6';
import { mobileConversationTitle, mobileReplyStatus, sidebarBackground, stageEl } from './dom.js?v=6';
import { phoneMode, visualRect } from './util.js?v=6';

export let latestAssistantReply = '';
export const faceBubble = (() => {
  const el = document.createElement('div');
  el.className = 'face-bubble';
  el.tabIndex = 0;
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', (window.Names ? Names.getBot() : 'Jun') + ' reply');
  el.hidden = true;
  document.body.appendChild(el);
  return el;
})();
sidebarBackground.push(faceBubble);
let faceBubbleRaf = 0;
let lastFaceBubbleLeft = null;
let lastFaceBubbleTop = null;
let lastFaceBubbleWidth = null;
let faceBubbleHideTimer = 0;
let pendingFaceBubbleHide = null;
let faceBubbleText = '';

function positionFaceBubble() {
  const a = window.Live2D && Live2D.faceAnchor && Live2D.faceAnchor();
  if (!a) return;
  const viewport = visualRect();
  const stage = stageEl.getBoundingClientRect();
  const headerEl = document.querySelector('.app-header');
  const header = headerEl.getBoundingClientRect();
  const composer = document.querySelector('.composer-area').getBoundingClientRect();
  const phone = phoneMode();
  const mobileShell = window.matchMedia('(max-width: 900px)').matches;
  const headerStyle = mobileShell ? getComputedStyle(headerEl) : null;
  const sideInsetLeft = headerStyle ? Math.max(8, parseFloat(headerStyle.paddingLeft) || 0) : 8;
  const sideInsetRight = headerStyle ? Math.max(8, parseFloat(headerStyle.paddingRight) || 0) : 8;
  const safeLeft = Math.max(stage.left + 8, viewport.left + sideInsetLeft);
  const safeRight = Math.min(stage.right - 8, viewport.right - sideInsetRight);
  const safeTop = Math.max(stage.top + 40, viewport.top + (mobileShell ? header.height + 40 : 8));
  const safeBottom = Math.min(stage.bottom - 8, phone ? composer.top - 8 : viewport.bottom - 8);
  const avail = safeRight - safeLeft;
  const w = Math.max(phone ? 240 : 150, Math.min(phone ? Math.min(360, avail) : Math.min(330, avail), a.modelW * 0.6));
  const scale = w / 330;
  if (w !== lastFaceBubbleWidth) {
    lastFaceBubbleWidth = w;
    faceBubble.style.setProperty('--fb-w', w + 'px');
    faceBubble.style.setProperty('--fb-scale', String(scale));
  }
  const text = faceBubble.querySelector('.fb-text');
  if (text) {
    if (phone) {
      const name = faceBubble.querySelector('.fb-name');
      const nameH = (name ? name.offsetHeight : 0) + 10 * scale;
      const availH = Math.min(
        Math.max(140, a.y - 12 - safeTop),
        safeBottom - safeTop,
        viewport.height * 0.46,
      );
      text.style.maxHeight = Math.max(0, availH - nameH) + 'px';
    } else if (text.style.maxHeight) {
      text.style.maxHeight = '';
    }
  }
  const bw = faceBubble.offsetWidth, bh = faceBubble.offsetHeight;
  let left, top;
  if (phone) {
    left = a.x - bw / 2;
    top = a.y - bh - 12;
  } else {
    left = a.x - a.headW * 0.5 - bw;
    if (left < safeLeft) left = Math.min(a.x + a.headW * 0.5, safeRight - bw);
    top = a.y + a.modelH * 0.18;
  }
  left = Math.max(safeLeft, Math.min(left, safeRight - bw));
  top = Math.max(safeTop, Math.min(top, safeBottom - bh));
  if (left !== lastFaceBubbleLeft || top !== lastFaceBubbleTop) {
    lastFaceBubbleLeft = left;
    lastFaceBubbleTop = top;
    faceBubble.style.left = left + 'px';
    faceBubble.style.top = top + 'px';
  }
}

export function scheduleFaceBubblePosition() {
  if (faceBubbleRaf) return;
  faceBubbleRaf = requestAnimationFrame(function tick() {
    faceBubbleRaf = faceBubble.hidden ? 0 : requestAnimationFrame(tick);
    positionFaceBubble();
  });
}

export function showFaceBubble(html, source = 'ephemeral') {
  clearTimeout(faceBubbleHideTimer);
  pendingFaceBubbleHide = null;
  faceBubble.dataset.source = source;
  const botName = window.Names ? Names.getBot() : 'Jun';
  faceBubble.setAttribute('aria-label', `${botName} reply`);
  let name = faceBubble.querySelector('.fb-name');
  let txt = faceBubble.querySelector('.fb-text');
  if (!name || !txt) {
    faceBubble.textContent = '';
    name = document.createElement('div');
    name.className = 'fb-name';
    txt = document.createElement('div');
    txt.className = 'fb-text';
    faceBubble.append(name, txt);
  }
  name.textContent = botName;
  txt.innerHTML = html;
  if (faceBubble.hidden) {
    faceBubble.hidden = false;
    faceBubble.classList.remove('intro');
    void faceBubble.offsetWidth;
    faceBubble.classList.add('intro');
  }
  scheduleFaceBubblePosition();
}

// showFaceBubble only plays the open animation if the card was hidden, so a
// second line just swaps the text with no movement. callers putting several
// lines in a row use this to make each one open again.
export function replayFaceBubbleIntro() {
  faceBubble.classList.remove('intro');
  void faceBubble.offsetWidth;
  faceBubble.classList.add('intro');
}

export function hideFaceBubble() {
  clearTimeout(faceBubbleHideTimer);
  faceBubbleHideTimer = 0;
  pendingFaceBubbleHide = null;
  faceBubble.hidden = true;
  faceBubble.classList.remove('intro');
  cancelAnimationFrame(faceBubbleRaf);
  faceBubbleRaf = 0;
}

function hideFaceBubbleAfterReading() {
  faceBubbleHideTimer = 0;
  const focused = document.activeElement;
  if (faceBubble.contains(focused)) {
    try {
      if (focused.matches(':focus-visible')) return;
    } catch (e) {
      return;
    }
  }
  hideFaceBubble();
}

function faceBubbleDelay(text, source) {
  if (source !== 'phone') return 10000;
  const rendered = faceBubble.querySelector('.fb-text');
  const words = (((rendered && rendered.textContent) || text).trim().match(/\S+/g) || []).length;
  return Math.max(6000, Math.min(30000, words * 240));
}

function startFaceBubbleHideTimer(text, source) {
  clearTimeout(faceBubbleHideTimer);
  pendingFaceBubbleHide = null;
  faceBubbleText = text;
  faceBubbleHideTimer = setTimeout(hideFaceBubbleAfterReading, faceBubbleDelay(text, source));
}

export function scheduleFaceBubbleHide(text, source) {
  clearTimeout(faceBubbleHideTimer);
  pendingFaceBubbleHide = { text, source };
  faceBubbleText = text;
  if (window.TTS && TTS.isSpeaking && TTS.isSpeaking()) return;
  startFaceBubbleHideTimer(text, source);
}

export function finishPendingFaceBubbleHide() {
  if (!pendingFaceBubbleHide || faceBubble.hidden) return;
  startFaceBubbleHideTimer(pendingFaceBubbleHide.text, pendingFaceBubbleHide.source);
}

export function restartFaceBubbleHide() {
  if (faceBubble.hidden || !faceBubbleText) return;
  scheduleFaceBubbleHide(faceBubbleText, faceBubble.dataset.source || 'ephemeral');
}

export function announceMobileReply(text) {
  if (!mobileReplyStatus || !phoneMode() || !text.trim()) return;
  mobileReplyStatus.textContent = '';
  requestAnimationFrame(() => {
    const botName = window.Names ? Names.getBot() : 'Jun';
    mobileReplyStatus.textContent = `${botName} replied: ${text}`;
  });
}

export function setLatestAssistantReply(text) {
  latestAssistantReply = text.trim();
  if (mobileConversationTitle) {
    mobileConversationTitle.disabled = !latestAssistantReply || !phoneMode();
    mobileConversationTitle.title = latestAssistantReply ? 'Show latest reply' : currentConversationTitle;
  }
  setConversationTitle(currentConversationTitle);
}
