import { modelSelect } from './dom.js?v=77';
import * as Names from '../core/names.js?v=1';
import * as ui from '../core/ui.js?v=1';

// her answer to an edit survives the reload that redraws the reader
const replies = new Map();

function button(label, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  return b;
}

function sendJson(method, url, body) {
  return fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function herReply(text) {
  const p = document.createElement('p');
  p.className = 'memory-her-reply';
  p.textContent = Names.apply(text);
  return p;
}

// devs edit the note straight away, everyone else can only ask her
export function renderNoteActions(node, body, { isAdmin, reload }) {
  const journal = node.type === 'journal-leaf';
  if (journal && !isAdmin) return;
  const target = journal ? { journal: node.date } : { id: node.noteId };
  const box = document.createElement('div');
  box.className = 'memory-actions';
  const said = replies.get(node.noteId);
  if (said) { replies.delete(node.noteId); box.appendChild(herReply(said)); }

  if (isAdmin) {
    const input = document.createElement('textarea');
    input.rows = 3;
    input.maxLength = journal ? 1600 : 800;
    input.value = node.text;
    input.setAttribute('aria-label', journal ? 'Edit this journal entry' : 'Edit this memory');
    const save = button('Save', 'secondary');
    const del = button('Delete', 'secondary danger');
    const row = document.createElement('div');
    row.className = 'memory-actions-row';
    row.append(save, del);
    box.append(input, row);
    save.addEventListener('click', async () => {
      const memory = input.value.trim();
      if (!memory || memory === node.text) return;
      const r = await sendJson('PUT', 'api/memory.php', { ...target, memory }).catch(() => null);
      if (!r || !r.ok) { ui.toast('Memory not saved.', 'error'); return; }
      reload();
    });
    del.addEventListener('click', async () => {
      const what = journal ? 'journal entry' : 'memory';
      const ok = await ui.confirm({ title: 'Delete ' + what, message: `Delete this ${what}? This cannot be undone.`, confirmLabel: 'Delete', cancelLabel: 'Cancel', danger: true });
      if (!ok) return;
      const r = await sendJson('DELETE', 'api/memory.php', target).catch(() => null);
      if (!r || !r.ok) { ui.toast('Memory not deleted.', 'error'); return; }
      reload();
    });
    body.appendChild(box);
    return;
  }

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Ask her to change this';
  const input = document.createElement('textarea');
  input.rows = 3;
  input.maxLength = 500;
  input.placeholder = 'What should she change or forget, and why?';
  input.setAttribute('aria-label', 'Your request');
  const ask = button('Ask her', 'secondary');
  const status = document.createElement('div');
  status.setAttribute('aria-live', 'polite');
  details.append(summary, input, ask, status);
  box.appendChild(details);
  ask.addEventListener('click', async () => {
    const request = input.value.trim();
    if (!request) return;
    ask.disabled = true;
    status.replaceChildren(Object.assign(document.createElement('p'), { className: 'memory-source', textContent: 'She is thinking it over…' }));
    let res = null;
    try {
      const r = await sendJson('POST', 'api/memory.php?action=request', { id: node.noteId, request, model: modelSelect?.value || '' });
      if (r.status === 429) throw new Error('Too many requests. Try again later.');
      if (!r.ok) throw new Error('She could not answer right now.');
      res = await r.json();
    } catch (e) {
      status.replaceChildren(Object.assign(document.createElement('p'), { className: 'memory-source', textContent: e.message }));
      ask.disabled = false;
      return;
    }
    const reply = res.reply || (res.decision === 'refuse' ? 'She left it as it is.' : '');
    if (res.decision === 'refuse') {
      status.replaceChildren(herReply(reply));
      ask.disabled = false;
      return;
    }
    if (res.decision === 'delete') ui.toast(Names.apply(reply || 'She let that memory go.'), 'ok');
    else if (reply) replies.set(node.noteId, reply);
    reload();
  });
  body.appendChild(box);
}
