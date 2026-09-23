import { messagesEl, messagesEmpty } from './dom.js?v=11';
import { hideFaceBubble } from './face-bubble.js?v=18';
import { escapeHtml } from '../core/util.js?v=1';

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
    el.textContent = content;
  }
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  updateEmptyState();
  return el;
}

export function updateEmptyState() {
  if (!messagesEmpty) return;
  if (messagesEl.children.length > 0) {
    messagesEmpty.classList.add('hidden');
  } else {
    messagesEmpty.classList.remove('hidden');
  }
}
