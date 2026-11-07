// kana = Japanese, which Kokoro can't do here. its kanji look like hanzi,
// so any kana keeps the chunk off Mandarin
const KANA_RE = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]/;
const HANZI_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
const DEVANAGARI_RE = /[\u0900-\u097f]/;

export const SCRIPT_LANGS = new Set(['mandarin', 'hindi']);

export function scriptLang(text) {
  const s = text || '';
  if (KANA_RE.test(s)) return 'english';
  if (HANZI_RE.test(s)) return 'mandarin';
  if (DEVANAGARI_RE.test(s)) return 'hindi';
  return null;
}

const PREVIEW_LINES = {
  french_24l: (n) => `Salut ${n}, tu aimes cette voix ?`,
  german_24l: (n) => `Hallo ${n}, gefällt dir diese Stimme?`,
  hindi: () => 'नमस्ते, क्या तुम्हें यह आवाज़ पसंद है?',
  italian: (n) => `Ciao ${n}, ti piace questa voce?`,
  mandarin: () => '你好，你喜欢这个声音吗？',
  portuguese: (n) => `Oi ${n}, você gosta desta voz?`,
  spanish_24l: (n) => `Hola ${n}, ¿te gusta esta voz?`,
};

export function previewLine(langId, name) {
  const line = PREVIEW_LINES[langId];
  return line ? line(name) : `Hi ${name}, do you like this voice?`;
}
