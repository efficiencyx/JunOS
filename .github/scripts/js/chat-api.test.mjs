// chat() is the one place a turn's flags get put on the wire, and
// chat.php only ever sees what it posts. it used to drop invite
// on the floor, so the drawer's ask-her-out buttons sent a plain
// chat line and she never got told to call the trip tool.
//
// run: node --test .github/scripts/js
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { chat } = await import('../../../webapp/js/core/chat-api.js');

function send(turn) {
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return new Response('data: [DONE]\n\n', { status: 200 });
  };
  return new Promise((resolve, reject) => {
    chat(turn, { onDone: () => resolve(sent), onError: reject });
  });
}

test('the invite flag reaches chat.php', async () => {
  const sent = await send({ messages: [{ role: 'user', content: 'lunch?' }], invite: 'date' });
  assert.equal(sent.url, 'api/chat.php');
  assert.equal(sent.body.invite, 'date');
});

test('a plain turn posts an empty invite, which chat.php drops', async () => {
  const sent = await send({ messages: [], invite: '' });
  assert.equal(sent.body.invite, '');
});

test('a watch turn carries its frames and the watch block', async () => {
  const watch = { turn: 'tick', source: 'file', title: 'x', at: 40, length: 600, paused: false };
  const sent = await send({ messages: [], ephemeral: true, frames: ['/9j/'], audio: 'UklGRg==', watch });
  assert.deepEqual(sent.body.frames, ['/9j/']);
  assert.equal(sent.body.audio, 'UklGRg==');
  assert.deepEqual(sent.body.watch, watch);
});
