import { modelSelect } from './dom.js?v=77';
import * as Names from '../core/names.js?v=1';
import * as ui from '../core/ui.js?v=13';
import { t } from '../core/i18n.js?v=3';

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
    input.setAttribute('aria-label', journal ? t('memory.editJournal', 'Edit this journal entry') : t('memory.edit', 'Edit this memory'));
    const save = button(t('common.save', 'Save'), 'secondary');
    const del = button(t('common.delete', 'Delete'), 'secondary danger');
    const row = document.createElement('div');
    row.className = 'memory-actions-row';
    row.append(save, del);
    box.append(input, row);
    save.addEventListener('click', async () => {
      const memory = input.value.trim();
      if (!memory || memory === node.text) return;
      const r = await sendJson('PUT', 'api/memory.php', { ...target, memory }).catch(() => null);
      if (!r || !r.ok) { ui.toast(t('memory.notSaved', 'Memory not saved.'), 'error'); return; }
      reload();
    });
    del.addEventListener('click', async () => {
      const ok = await ui.confirm({
        title: journal ? t('memory.deleteJournal', 'Delete journal entry') : t('memory.delete', 'Delete memory'),
        message: journal ? t('memory.deleteJournalConfirm', 'Delete this journal entry? This cannot be undone.') : t('memory.deleteConfirm', 'Delete this memory? This cannot be undone.'),
        confirmLabel: t('ui.holdDelete', 'Hold to delete'), cancelLabel: t('common.cancel', 'Cancel'), hold: true,
      });
      if (!ok) return;
      const r = await sendJson('DELETE', 'api/memory.php', target).catch(() => null);
      if (!r || !r.ok) { ui.toast(t('memory.notDeleted', 'Memory not deleted.'), 'error'); return; }
      reload();
    });
    body.appendChild(box);
    return;
  }

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = t('memory.askChange', 'Ask her to change this');
  const input = document.createElement('textarea');
  input.rows = 3;
  input.maxLength = 500;
  input.placeholder = t('memory.askPlaceholder', 'What should she change or forget, and why?');
  input.setAttribute('aria-label', t('memory.request', 'Your request'));
  const ask = button(t('settings.ask', 'Ask her'), 'secondary');
  const status = document.createElement('div');
  status.setAttribute('aria-live', 'polite');
  details.append(summary, input, ask, status);
  box.appendChild(details);
  ask.addEventListener('click', async () => {
    const request = input.value.trim();
    if (!request) return;
    ask.disabled = true;
    status.replaceChildren(Object.assign(document.createElement('p'), { className: 'memory-source', textContent: t('memory.thinking', 'She is thinking it over…') }));
    let res = null;
    try {
      const r = await sendJson('POST', 'api/memory.php?action=request', { id: node.noteId, request, model: modelSelect?.value || '' });
      if (r.status === 429) throw new Error(t('memory.tooMany', 'Too many requests. Try again later.'));
      if (!r.ok) throw new Error(t('memory.noAnswer', 'She could not answer right now.'));
      res = await r.json();
    } catch (e) {
      status.replaceChildren(Object.assign(document.createElement('p'), { className: 'memory-source', textContent: e.message }));
      ask.disabled = false;
      return;
    }
    const reply = res.reply || (res.decision === 'refuse' ? t('memory.leftIt', 'She left it as it is.') : '');
    if (res.decision === 'refuse') {
      status.replaceChildren(herReply(reply));
      ask.disabled = false;
      return;
    }
    if (res.decision === 'delete') ui.toast(Names.apply(reply || t('memory.letGo', 'She let that memory go.')), 'ok');
    else if (reply) replies.set(node.noteId, reply);
    reload();
  });
  body.appendChild(box);
}
