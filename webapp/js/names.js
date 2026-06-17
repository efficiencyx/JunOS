// Player/companion name customization. The fine-tune was trained on game-export
// dialogue and emits `{f_playerName}` / `{f_botName}` placeholders inline with
// its text. Rather than retrain or rewrite tokens at inference, we treat those
// placeholders as a feature: resolve them to the user's chosen names at render
// time (chat display + TTS). Defaults reproduce the original cast (Anon / Jun),
// so leaving the fields untouched behaves exactly as before.
//
// Names are persisted in localStorage and mirrored across browsers via prefs.js
// (keys listed in its TRACKED array).

window.Names = (function () {
  const PLAYER_KEY = 'omega.names.player';
  const BOT_KEY = 'omega.names.bot';
  const DEFAULT_PLAYER = 'Anon';
  const DEFAULT_BOT = 'Jun';

  let player = DEFAULT_PLAYER;
  let bot = DEFAULT_BOT;

  function clean(v, fallback) {
    const s = (v || '').trim();
    return s || fallback;
  }

  // Read from localStorage (call after Prefs.pullFromServer so a synced name wins).
  function load() {
    player = clean(localStorage.getItem(PLAYER_KEY), DEFAULT_PLAYER);
    bot = clean(localStorage.getItem(BOT_KEY), DEFAULT_BOT);
  }

  function getPlayer() { return player; }
  function getBot() { return bot; }

  function setPlayer(v) {
    player = clean(v, DEFAULT_PLAYER);
    localStorage.setItem(PLAYER_KEY, player);
  }
  function setBot(v) {
    bot = clean(v, DEFAULT_BOT);
    localStorage.setItem(BOT_KEY, bot);
  }

  // Whitespace-tolerant so a stray `{ f_botName }` still resolves; the camelCase
  // forms below are the only ones the fine-tune actually emits.
  const SUBST_RE = /\{\s*f_(playerName|botName)\s*\}/gi;
  function apply(text) {
    if (!text) return text;
    return text.replace(SUBST_RE, (_, key) =>
      key.toLowerCase() === 'playername' ? player : bot);
  }

  // Length of a trailing partial placeholder that could still complete on the
  // next token (e.g. "{f_pla"), so a streaming buffer can hold it back instead of
  // flashing the raw fragment before substituting. Lowercased canon — the stream
  // never carries spaces inside a placeholder, so an exact prefix match suffices.
  const TOKENS = ['{f_playername}', '{f_botname}'];
  function pendingPartial(buf) {
    const open = buf.lastIndexOf('{');
    if (open < 0) return 0;
    const tail = buf.slice(open).toLowerCase();
    if (tail.indexOf('}') !== -1) return 0; // already closed — nothing pending
    for (const tok of TOKENS) {
      if (tok.startsWith(tail)) return buf.length - open;
    }
    return 0;
  }

  return { load, getPlayer, getBot, setPlayer, setBot, apply, pendingPartial,
           DEFAULT_PLAYER, DEFAULT_BOT };
})();
