
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

  const SUBST_RE = /\{\s*f_(playerName|botName)\s*\}/gi;
  function apply(text) {
    if (!text) return text;
    return text.replace(SUBST_RE, (_, key) =>
      key.toLowerCase() === 'playername' ? player : bot);
  }

  // keep half written streaming placeholders out of the reply we show
  const TOKENS = ['{f_playername}', '{f_botname}'];
  function pendingPartial(buf) {
    const open = buf.lastIndexOf('{');
    if (open < 0) return 0;
    const tail = buf.slice(open).toLowerCase();
    if (tail.indexOf('}') !== -1) return 0;
    for (const tok of TOKENS) {
      if (tok.startsWith(tail)) return buf.length - open;
    }
    return 0;
  }

  return { load, getPlayer, getBot, setPlayer, setBot, apply, pendingPartial,
           DEFAULT_PLAYER, DEFAULT_BOT };
})();
