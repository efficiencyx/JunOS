import { messagesEl, messagesEmpty } from './dom.js?v=77';
import { hideFaceBubble } from './face-bubble.js?v=87';
import { escapeHtml } from '../core/util.js?v=1';
import { commandLength } from './composer.js?v=3';

const MARKDOWN_TAGS = [
  'p', 'br', 'strong', 'em', 's', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'a', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'kbd',
];

export function renderMarkdown(text) {
  if (!window.marked || !window.DOMPurify) return escapeHtml(text || '');
  const html = marked.parse(text || '');
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: MARKDOWN_TAGS,
    ALLOWED_ATTR: ['href', 'title'],
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
  });
  const template = document.createElement('template');
  template.innerHTML = clean;
  template.content.querySelectorAll('a').forEach(link => {
    try {
      const url = new URL(link.getAttribute('href') || '', location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    } catch (_) {
      link.removeAttribute('href');
    }
  });
  return template.innerHTML;
}

export function appendMsg(role, content) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  if (role === 'user') hideFaceBubble();
  if (role === 'assistant') {
    el.innerHTML = renderMarkdown(content);
  } else {
    const n = role === 'user' ? commandLength(content) : 0;
    if (n) {
      const cmd = document.createElement('span');
      cmd.className = 'cmd';
      cmd.textContent = content.slice(0, n);
      el.append(cmd, content.slice(n));
    } else {
      el.textContent = content;
    }
  }
  messagesEl.appendChild(el);
  if (role === 'user') scrollToLatest();
  else followLatest();
  updateEmptyState();
  return el;
}

// 40px of slack, a fractional scrollTop never lands exactly on the bottom
const PINNED_SLACK = 40;
let pinned = true;
const jumpBtn = document.getElementById('jumpToLatestBtn');

function syncPinned() {
  pinned = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= PINNED_SLACK;
  if (jumpBtn) jumpBtn.hidden = pinned;
}
messagesEl.addEventListener('scroll', syncPinned, { passive: true });
if (jumpBtn) jumpBtn.addEventListener('click', scrollToLatest);

export function scrollToLatest() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
  syncPinned();
}

export function followLatest() {
  if (pinned) messagesEl.scrollTop = messagesEl.scrollHeight;
  else if (jumpBtn) jumpBtn.hidden = false;
}

export function updateEmptyState() {
  if (!messagesEmpty) return;
  if (messagesEl.children.length > 0) {
    messagesEmpty.classList.add('hidden');
  } else {
    messagesEmpty.classList.remove('hidden');
  }
}
