// Kokoro's auto-detect. Kokoro has one model for every language,
// switching costs nothing, so each chunk is routed on its own,
// unlike pocket-tts which locks a whole reply to one checkpoint.
// that also means a language here is told apart by the characters
// it writes, not by stopwords: a chunk either has hanzi in it or
// it doesn't.
//
// one rule per KOKORO_LANGUAGES id in tts/sidecar/config.py, first
// match wins, no match is english. a rule for a language the
// sidecar can't speak is harmless, it puts an id it doesn't offer
// back to english.

// kana means Japanese. its kanji sit in the same range as hanzi,
// and reading them as Mandarin is worse than English's "Chinese
// letter", so any kana keeps the chunk off Mandarin.
const KANA_RE = /[぀-ヿㇰ-ㇿｦ-ﾟ]/;
const HANZI_RE = /[㐀-鿿豈-﫿]/;

const RULES = [
  { id: 'mandarin', test: (s) => HANZI_RE.test(s) && !KANA_RE.test(s) },
];

export function detectKokoroLang(text) {
  const s = text || '';
  for (const r of RULES) if (r.test(s)) return r.id;
  return 'english';
}

// what the Play button says, so a voice is previewed in the
// language it's for. no entry falls back to the English line.
export const PREVIEW_LINES = {
  mandarin: '你好，你喜歡這個聲音嗎？',
};
