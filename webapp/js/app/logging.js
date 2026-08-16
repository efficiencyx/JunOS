import { actionLogCount, actionLogEl, clearRawBtn, clearToolLogBtn, missingParamsEl, rawStreamEl, stageStatus, toolLogCount, toolLogEl } from './dom.js?v=5';
import { escapeHtml } from './util.js?v=5';

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

let toolCallCount = 0;
export function logToolStatus(s) {
  if (!toolLogEl || !s || !s.name) return;
  if (toolCallCount === 0) toolLogEl.textContent = '';
  const row = document.createElement('div');
  row.className = 'row';
  const ts = new Date().toLocaleTimeString();
  if (s.state === 'running') {
    const args = s.args && Object.keys(s.args).length ? JSON.stringify(s.args) : '';
    row.innerHTML = `<span class="ts">${ts}</span> <span class="info">🔧 ${escapeHtml(s.name)}(${escapeHtml(args)})</span>`;
  } else {
    toolCallCount++;
    toolLogCount.textContent = toolCallCount;
    const ms = typeof s.duration_ms === 'number' ? ` ${s.duration_ms}ms` : '';
    const result = (s.result || '').trim() || '(empty result)';
    row.innerHTML = `<span class="ts">${ts}</span> <span class="ok">✓ ${escapeHtml(s.name)}${ms}</span> <span>→ ${escapeHtml(result)}</span>`;
  }
  toolLogEl.appendChild(row);
  toolLogEl.scrollTop = toolLogEl.scrollHeight;
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

export function appendRaw(text) {
  rawStreamEl.append(document.createTextNode(text));
  rawStreamEl.scrollTop = rawStreamEl.scrollHeight;
}
clearRawBtn.addEventListener('click', () => { rawStreamEl.textContent = ''; });
clearToolLogBtn.addEventListener('click', () => {
  toolLogEl.textContent = 'No tool calls yet.';
  toolCallCount = 0;
  toolLogCount.textContent = '0';
});
