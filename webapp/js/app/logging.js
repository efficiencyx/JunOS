import { actionLogCount, actionLogEl, clearToolLogBtn, debugCopyBtns, debugReplyEl, debugSystemPromptEl, debugThinkingEl, debugUserTurnEl, missingParamsEl, stageStatus, toolLogCount, toolLogEl, toolLogModeBtn, toolLogRawEl } from './dom.js?v=77';
import { escapeHtml } from '../core/util.js?v=1';

let logCount = 0;
export function logAction(level, text) {
  logCount++;
  actionLogCount.textContent = logCount;
  const row = document.createElement('div');
  row.className = 'row';
  const ts = new Date().toLocaleTimeString();
  row.innerHTML = `<span class="ts">${ts}</span> <span class="${level}">${escapeHtml(text)}</span>`;
  actionLogEl.appendChild(row);
  actionLogEl.scrollTop = actionLogEl.scrollHeight;
}

let toolCallCount = 0, toolEntries = 0;
export function logToolStatus(s) {
  if (!toolLogEl || !s || !s.name) return;
  if (toolEntries++ === 0) { toolLogEl.textContent = ''; toolLogRawEl.textContent = ''; }
  const row = document.createElement('div');
  row.className = 'row';
  const ts = new Date().toLocaleTimeString();
  if (s.state === 'running') {
    const args = s.args && Object.keys(s.args).length ? JSON.stringify(s.args, null, 2) : '';
    row.innerHTML = `<span class="ts">${ts}</span> <span class="info">🔧 ${escapeHtml(s.name)}</span>`
      + (args ? `<span class="tool-args">${escapeHtml(args)}</span>` : '');
  } else {
    toolCallCount++;
    toolLogCount.textContent = toolCallCount;
    const ms = typeof s.duration_ms === 'number' ? ` ${s.duration_ms}ms` : '';
    const result = (s.result || '').trim() || '(empty result)';
    row.innerHTML = `<span class="ts">${ts}</span> <span class="ok">✓ ${escapeHtml(s.name)}${ms}</span> <span>→ ${escapeHtml(result)}</span>`;
  }
  toolLogEl.appendChild(row);
  toolLogEl.scrollTop = toolLogEl.scrollHeight;
  const raw = s.state === 'running' ? s.call : s.message;
  const dir = !raw ? 'tag salvaged from the reply, never sent back' : s.state === 'running' ? 'model -> tool' : 'tool -> model';
  toolLogRawEl.append(`// ${ts} ${dir}\n${JSON.stringify(raw ?? s, null, 2)}\n\n`);
  toolLogRawEl.scrollTop = toolLogRawEl.scrollHeight;
}

export function logMissing(param) {
  const row = document.createElement('div');
  row.className = 'row warn';
  row.textContent = `param mancante: ${param}`;
  missingParamsEl.appendChild(row);
}

export function setStageStatus(text, isError) {
  if (!text) { stageStatus.classList.add('hidden'); return; }
  stageStatus.classList.remove('hidden');
  stageStatus.classList.toggle('error', !!isError);
  stageStatus.textContent = text;
}

let thinkingSeen = false;
export function beginDebugTurn() {
  thinkingSeen = false;
  debugThinkingEl.textContent = 'No thinking on the last turn.';
  debugReplyEl.textContent = '';
}

export function setDebugPrompt(dbg) {
  if (typeof dbg.system_prompt === 'string') debugSystemPromptEl.textContent = dbg.system_prompt;
  if (typeof dbg.user_turn === 'string') {
    debugUserTurnEl.textContent = (dbg.audio_attached ? '[audio attached]\n' : '') + dbg.user_turn;
  }
}

function appendTo(el, text) {
  el.append(text);
  el.scrollTop = el.scrollHeight;
}
export function appendDebugThinking(text) {
  if (!thinkingSeen) { thinkingSeen = true; debugThinkingEl.textContent = ''; }
  appendTo(debugThinkingEl, text);
}
export const appendDebugReply = (text) => appendTo(debugReplyEl, text);

for (const btn of debugCopyBtns) {
  btn.addEventListener('click', async () => {
    const el = document.getElementById(btn.dataset.copy);
    try {
      await navigator.clipboard.writeText(el.textContent);
      btn.textContent = 'copied';
      setTimeout(() => { btn.textContent = 'copy'; }, 1200);
    } catch {
      // no clipboard API over plain http on the LAN, select it so ctrl+c works
      getSelection().selectAllChildren(el);
    }
  });
}

toolLogModeBtn.addEventListener('click', () => {
  const raw = toolLogRawEl.hidden;
  toolLogModeBtn.textContent = raw ? 'formatted' : 'raw';
  toolLogEl.hidden = raw;
  toolLogRawEl.hidden = !raw;
});
clearToolLogBtn.addEventListener('click', () => {
  toolLogEl.textContent = 'No tool calls yet.';
  toolLogRawEl.textContent = 'No tool calls yet.';
  toolCallCount = 0;
  toolEntries = 0;
  toolLogCount.textContent = '0';
});
