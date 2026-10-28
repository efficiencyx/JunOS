import { chatInput } from './dom.js?v=77';

const DRAFT_PREFIX = 'draft.';
const MAX_HEIGHT = 200;
const nativeGrow = typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content');

let draftKey = null;
const mirror = document.getElementById('composerMirror');
const COMMAND = /^\/search(?=\s|$)/;

export function commandLength(text) {
  const m = COMMAND.exec(text || '');
  return m ? m[0].length : 0;
}

// a textarea can't colour part of its text, so while a command
// leads the box the mirror behind it draws the text and the
// textarea only keeps the caret
function syncCommand() {
  if (!mirror) return;
  const text = chatInput.value;
  const n = commandLength(text);
  chatInput.parentElement.classList.toggle('has-command', n > 0);
  if (!n) { mirror.replaceChildren(); return; }
  const cmd = document.createElement('span');
  cmd.className = 'cmd';
  cmd.textContent = text.slice(0, n);
  mirror.replaceChildren(cmd, text.slice(n) + '\n');
  mirror.scrollTop = chatInput.scrollTop;
}

export function resizeComposer() {
  if (nativeGrow) return;
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, MAX_HEIGHT) + 'px';
}

function saveDraft() {
  if (!draftKey) return;
  try {
    const text = chatInput.value;
    if (text.trim()) localStorage.setItem(draftKey, text);
    else localStorage.removeItem(draftKey);
  } catch (e) {}
}

export function setComposerText(text) {
  chatInput.value = text;
  resizeComposer();
  syncCommand();
  saveDraft();
}

// swaps the box over to this chat's draft. typing in one chat and
// opening another must not carry the text across
export function useDraftFor(conversationId) {
  draftKey = conversationId == null ? null : DRAFT_PREFIX + conversationId;
  let text = '';
  try { text = (draftKey && localStorage.getItem(draftKey)) || ''; } catch (e) {}
  chatInput.value = text;
  resizeComposer();
  syncCommand();
}

export function dropDraft(conversationId) {
  try { localStorage.removeItem(DRAFT_PREFIX + conversationId); } catch (e) {}
}

chatInput.addEventListener('input', () => {
  resizeComposer();
  syncCommand();
  saveDraft();
});
chatInput.addEventListener('scroll', () => { if (mirror) mirror.scrollTop = chatInput.scrollTop; });
