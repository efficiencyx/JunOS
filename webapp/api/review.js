// Loaded as a file rather than inlined because the stack's CSP is
// `script-src 'self'` - an inline <script> here is silently blocked, which
// leaves every message body invisible (transparent textarea, unpainted layer).

// Markers are kept in the output (only dimmed) so the highlight layer stays
// character-for-character aligned with the textarea underneath it.
const paint = t => {
  let s = t.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const wrap = (cls, open, body, close) =>
    `<span class="${cls}"><span class="mk">${open}</span>${body}<span class="mk">${close}</span></span>`;
  s = s.replace(/`([^`\n]+)`/g, (_, b) => wrap('code', '`', b, '`'));
  s = s.replace(/\*\*([^*\n]+)\*\*/g, (_, b) => wrap('st', '**', b, '**'));
  s = s.replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, (_, b) => wrap('em', '*', b, '*'));
  s = s.replace(/~~([^~\n]+)~~/g, (_, b) => wrap('del', '~~', b, '~~'));
  s = s.replace(/\[(A|ACTION):([^\]\n]*)\]/g, '<span class="act">[$1:$2]</span>');
  s = s.replace(/^(\s*)(#{1,6} )(.*)$/gm, '$1<span class="mk">$2</span><span class="hd">$3</span>');
  s = s.replace(/^(\s*)([-*+] |\d+[.)] )/gm, '$1<span class="mk">$2</span>');
  s = s.replace(/^(\s*&gt;.*)$/gm, '<span class="quote">$1</span>');
  return s + '\n';   // trailing newline keeps the layer as tall as the caret can go
};

document.querySelectorAll('.msg').forEach(msg => {
  const ta = msg.querySelector('textarea'), hl = msg.querySelector('.hl');
  if (!ta || !hl) return;
  const original = ta.value;
  const sync = () => {
    hl.innerHTML = paint(ta.value);
    msg.classList.toggle('dirty', ta.value !== original);
  };
  ta.addEventListener('input', sync);
  sync();
  msg.querySelector('.editor').classList.add('painted');
});

addEventListener('keydown', e => {
  if (e.target.matches('select, textarea') || e.metaKey || e.ctrlKey) return;
  const k = e.key.toLowerCase();
  if (k !== 'y' && k !== 'n' && k !== 'enter') return;
  e.preventDefault();
  document.querySelector(k === 'n' ? '.scrap' : '.keep').click();
});
