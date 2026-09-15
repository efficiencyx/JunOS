// the stream buffer is what keeps [A:...] tags out of the chat
// bubble while the reply is still arriving, so the avatar can
// react mid sentence. it has to hold back a half received marker
// across chunk boundaries and give it up again when it turns out
// to be plain text. nothing else in CI runs this code, node
// --check only parses it.
//
// run: node --test .github/scripts/js
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('./dom-stub-hooks.mjs', import.meta.url);

globalThis.window = globalThis;
globalThis.__log = [];
await import('../../../webapp/js/actions.js');
const { makeStreamBuffer, makeNameFilter } = await import('../../../webapp/js/app/stream-filters.js');

// parseActions is the real one, applyAction would try to drive
// the Live2D rig. record what would have been applied instead.
let applied = [];
Actions.applyAction = (a) => applied.push(a);

function run(chunks) {
  const out = [];
  applied = [];
  globalThis.__log = [];
  const sb = makeStreamBuffer((t) => out.push(t));
  for (const c of chunks) sb.push(c);
  sb.flush();
  return { text: out.join(''), out, applied };
}

test('a tag split across chunks never reaches the text', () => {
  const r = run(['hey. [A:sm', 'ile] there', ' you are.']);
  assert.equal(r.text, 'hey.  there you are.');
  assert.deepEqual(r.applied.map(a => a.name), ['smile']);
});

test('a lone [ is held back, then released as text when nothing follows', () => {
  const r = run(['array[', '0] is fine']);
  assert.equal(r.text, 'array[0] is fine');
  assert.equal(r.applied.length, 0);
});

test('partial marker prefixes are held, not flashed', () => {
  const out = [];
  const sb = makeStreamBuffer((t) => out.push(t));
  sb.push('ok [A');
  assert.equal(out.join(''), 'ok ');
  sb.push('CTION:wave]!');
  sb.flush();
  assert.equal(out.join(''), 'ok !');
});

test('legacy [ACTION:...] and [A:...] both parse, kwargs and positional', () => {
  const r = run(['[ACTION:look|target=player] [A:sit|left]']);
  assert.equal(r.applied.length, 2);
  assert.equal(r.applied[0].name, 'look');
  assert.equal(r.applied[0].kwargs.target, 'player');
  assert.equal(r.applied[1].name, 'sit');
});

test('a ] inside a tool marker json string does not close it', () => {
  const r = run(['before [TOOL:{"q":"a]b"}] after']);
  assert.equal(r.text, 'before  after');
  assert.equal(r.applied.length, 0);
  assert.ok(globalThis.__log.some(([, t]) => t.includes('tool marker')));
});

test('an unclosed marker at the end is dropped on flush, text before it is kept', () => {
  const r = run(['done talking [A:wave']);
  assert.equal(r.text, 'done talking ');
});

test('name filter passes text through and holds a partial placeholder', () => {
  const out = [];
  globalThis.Names = {
    pendingPartial: (s) => (/\{f_[a-zA-Z]*$/.test(s) ? s.match(/\{f_[a-zA-Z]*$/)[0].length : 0),
    apply: (s) => s.replace(/\{f_playerName\}/g, 'Anon'),
  };
  const nf = makeNameFilter((t) => out.push(t));
  nf.push('hi {f_play');
  assert.equal(out.join(''), 'hi ');
  nf.push('erName}!');
  nf.flush();
  assert.equal(out.join(''), 'hi Anon!');
});
