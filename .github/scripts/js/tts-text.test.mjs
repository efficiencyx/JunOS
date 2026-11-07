// how replies get cut into TTS chunks, and which Kokoro language
// each chunk is routed to. the cutting decides when the first audio
// plays and how big a chunk gets, the routing whether a chunk is
// read by the right G2P at all. nothing else in CI runs this code,
// node --check only parses it.
//
// run: node --test .github/scripts/js
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('./dom-stub-hooks.mjs', import.meta.url);

globalThis.window = globalThis;
const TTS = await import('../../../webapp/js/voice/tts.js');
const { detectKokoroLang } = await import('../../../webapp/js/voice/kokoro-lang.js');

function cuts(text, first) {
  const r = TTS.nextChunk(text, first);
  return r ? r.chunk : null;
}

test('English chunking is unchanged', () => {
  assert.equal(cuts('Hello there. How are', false), 'Hello there.');
  assert.equal(cuts('Oh, hi', true), null);
  assert.equal(cuts('Well, I think, maybe', true), 'Well, I think,');
  // a run of dots is her trailing off, never a cut
  assert.equal(cuts('Wait... what', false), null);
  assert.equal(cuts('No full stop yet', false), null);
});

test('fullwidth sentence ends cut a chunk', () => {
  assert.equal(cuts('你好！今天天氣很好。', false), '你好！');
  assert.equal(cuts('今天天氣很好。我們', false), '今天天氣很好。');
  assert.equal(cuts('真的嗎？好', false), '真的嗎？');
  assert.equal(cuts('嗯～我想想', false), '嗯～');
});

test('the first chunk soft-splits Chinese once a few hanzi are in', () => {
  assert.equal(cuts('今天天氣很好，我們去散步吧', true), '今天天氣很好，');
  // two hanzi isn't enough, same as "Oh," in English
  assert.equal(cuts('你好，', true), null);
  assert.equal(cuts('我覺得；也許', true), '我覺得；');
});

test('Kokoro routes by script', () => {
  assert.equal(detectKokoroLang('你好，今天天氣很好。'), 'mandarin');
  assert.equal(detectKokoroLang('我是Jun，很高興認識你。'), 'mandarin');
  assert.equal(detectKokoroLang('Hello there.'), 'english');
  assert.equal(detectKokoroLang('OK!'), 'english');
  assert.equal(detectKokoroLang(''), 'english');
});

test('Japanese stays off Mandarin, kanji or not', () => {
  assert.equal(detectKokoroLang('今日はいい天気ですね。'), 'english');
  assert.equal(detectKokoroLang('ｶﾀｶﾅ漢字'), 'english');
  assert.equal(detectKokoroLang('ありがとう'), 'english');
});

test('predictLang names what Kokoro should warm', () => {
  TTS.setEnabled(true);
  TTS.setEngine('kokoro');
  TTS.setLang('auto');
  assert.equal(TTS.predictLang('你好嗎'), 'mandarin');
  assert.equal(TTS.predictLang('how are you'), null);
  TTS.setLang('mandarin');
  assert.equal(TTS.predictLang('how are you'), 'mandarin');
  TTS.setLang('english');
  assert.equal(TTS.predictLang('你好嗎'), null);
});

test('pocket-tts prediction is untouched', () => {
  TTS.setEngine('pockettts');
  TTS.setLang('auto');
  assert.equal(TTS.predictLang('what are you doing with the cat'), 'english');
  assert.equal(TTS.predictLang('je ne sais pas pour les chats'), 'french_24l');
  TTS.setLang('english');
  assert.equal(TTS.predictLang('je ne sais pas'), null);
});
