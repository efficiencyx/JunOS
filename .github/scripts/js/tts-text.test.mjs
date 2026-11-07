// where replies get cut for TTS and which language each chunk goes out as.
// nothing else in CI runs this, node --check only parses it
//
// run: node --test .github/scripts/js
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('./dom-stub-hooks.mjs', import.meta.url);

globalThis.window = globalThis;
const TTS = await import('../../../webapp/js/voice/tts.js');
const { scriptLang, previewLine } = await import('../../../webapp/js/voice/languages.js');

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

test('fullwidth and danda sentence ends cut a chunk', () => {
  assert.equal(cuts('你好！今天天气很好。', false), '你好！');
  assert.equal(cuts('今天天气很好。我们', false), '今天天气很好。');
  assert.equal(cuts('真的吗？好', false), '真的吗？');
  assert.equal(cuts('嗯～我想想', false), '嗯～');
  assert.equal(cuts('मैं ठीक हूँ। तुम', false), 'मैं ठीक हूँ।');
});

test('the first chunk soft-splits Chinese once a few hanzi are in', () => {
  assert.equal(cuts('今天天气很好，我们去散步吧', true), '今天天气很好，');
  assert.equal(cuts('你好，', true), null);
  assert.equal(cuts('我觉得；也许', true), '我觉得；');
});

test('scripts route Mandarin and Hindi, kana stays off Mandarin', () => {
  assert.equal(scriptLang('你好，今天天气很好。'), 'mandarin');
  assert.equal(scriptLang('我是Jun，很高兴认识你。'), 'mandarin');
  assert.equal(scriptLang('नमस्ते, कैसे हो?'), 'hindi');
  assert.equal(scriptLang('Hello there.'), null);
  assert.equal(scriptLang('今日はいい天気ですね。'), 'english');
  assert.equal(scriptLang('ありがとう'), 'english');
});

test('preview lines follow the language', () => {
  assert.equal(previewLine('italian', 'Anon'), 'Ciao Anon, ti piace questa voce?');
  assert.equal(previewLine('auto', 'Anon'), 'Hi Anon, do you like this voice?');
});

test('Kokoro predicts script and stopword languages', () => {
  TTS.setEnabled(true);
  TTS.setEngine('kokoro');
  TTS.setLang('auto');
  assert.equal(TTS.predictLang('你好吗'), 'mandarin');
  assert.equal(TTS.predictLang('क्या हाल है'), 'hindi');
  assert.equal(TTS.predictLang('ciao amore, come stai oggi?'), 'italian');
  assert.equal(TTS.predictLang('how are you doing with the cat'), 'english');
  TTS.setLang('mandarin');
  assert.equal(TTS.predictLang('how are you'), 'mandarin');
  TTS.setLang('english');
  assert.equal(TTS.predictLang('你好吗'), null);
});

test('pocket-tts never gets a script language', () => {
  TTS.setEngine('pockettts');
  TTS.setLang('auto');
  assert.equal(TTS.predictLang('what are you doing with the cat'), 'english');
  assert.equal(TTS.predictLang('je ne sais pas pour les chats'), 'french_24l');
  assert.notEqual(TTS.predictLang('你好吗'), 'mandarin');
  TTS.setLang('english');
  assert.equal(TTS.predictLang('je ne sais pas'), null);
});
