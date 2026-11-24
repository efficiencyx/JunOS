// which UI language a browser tag or a pinned ui.lang lands on
//
// run: node --test .github/scripts/js
import { test } from 'node:test';
import assert from 'node:assert/strict';

let fresh = 0;
async function boot({ pinned = null, languages = [] }) {
  globalThis.localStorage = { getItem: () => pinned };
  Object.defineProperty(globalThis, 'navigator', { value: { languages, language: languages[0] }, configurable: true });
  return import('../../../webapp/js/core/i18n.js?case=' + fresh++);
}

test('traditional Chinese tags land on zh-TW', async () => {
  for (const tag of ['zh-TW', 'zh-tw', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-TW', 'zh-hant-hk']) {
    assert.equal((await boot({ languages: [tag] })).lang, 'zh-TW', tag);
  }
});

test('every other Chinese tag stays zh', async () => {
  for (const tag of ['zh', 'zh-CN', 'zh-SG', 'zh-Hans', 'zh-Hans-TW']) {
    assert.equal((await boot({ languages: [tag] })).lang, 'zh', tag);
  }
});

test('a pinned zh-TW wins over the browser', async () => {
  const m = await boot({ pinned: 'zh-TW', languages: ['en-US'] });
  assert.equal(m.lang, 'zh-TW');
  assert.equal(m.locale, 'zh-TW');
  assert.ok(m.SUPPORTED.includes('zh-TW'));
});

test('the browser region is kept as the locale', async () => {
  const m = await boot({ languages: ['zh-HK', 'en'] });
  assert.equal(m.lang, 'zh-TW');
  assert.equal(m.locale, 'zh-HK');
});

test('a pinned zh is not upgraded by a Taiwan browser', async () => {
  assert.equal((await boot({ pinned: 'zh', languages: ['zh-TW'] })).lang, 'zh');
});
