
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

  // storage and the model both stay on Jun/Anon FOREVER. she's a fine-tune
  // trained on those two literal strings, feed her "Aurora" and she has no
  // idea who that is. so the custom names exist only in the two places a
  // human looks: the bubble we paint, and the box he types in. everything
  // between those points is canonical.
  const renamed = () => player !== DEFAULT_PLAYER || bot !== DEFAULT_BOT;

  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // \b is wrong here, plenty of names end in an apostrophe or a non-ascii
  // letter and \b puts a boundary in the middle of those. so we match the
  // neighbours ourselves and hand them back untouched.
  function wordRe(words) {
    return new RegExp('(^|[^\\p{L}\\p{N}_])(' + words.map(esc).join('|') +
                      ')(?![\\p{L}\\p{N}_])', 'giu');
  }

  const CANON_RE = wordRe([DEFAULT_BOT, DEFAULT_PLAYER]);

  function apply(text) {
    if (!text) return text;
    let out = text.replace(SUBST_RE, (_, key) =>
      key.toLowerCase() === 'playername' ? player : bot);
    if (!renamed()) return out;
    return out.replace(CANON_RE, (_, pre, word) =>
      pre + (word.toLowerCase() === DEFAULT_PLAYER.toLowerCase() ? player : bot));
  }

  // the inverse, on everything the user types before it goes anywhere near
  // the model or the db. bot first so naming her "Anon" doesn't round trip
  // through the player branch and come out as the wrong person.
  function canonicalize(text) {
    if (!text || !renamed()) return text;
    return text.replace(wordRe([bot, player]), (_, pre, word) =>
      pre + (word.toLowerCase() === bot.toLowerCase() ? DEFAULT_BOT : DEFAULT_PLAYER));
  }

  // keep half written names out of the reply we show. tokens split across
  // token chunks all the time, and "An" rendered NOW can't be un-rendered
  // when the "on" lands 40ms later.
  const TOKENS = ['{f_playername}', '{f_botname}'];
  function pendingPartial(buf) {
    const open = buf.lastIndexOf('{');
    if (open >= 0) {
      const tail = buf.slice(open).toLowerCase();
      if (tail.indexOf('}') === -1) {
        for (const tok of TOKENS) {
          if (tok.startsWith(tail)) return buf.length - open;
        }
      }
    }
    if (!renamed()) return 0;
    for (const word of [DEFAULT_BOT, DEFAULT_PLAYER]) {
      for (let n = Math.min(word.length - 1, buf.length); n > 0; n--) {
        const tail = buf.slice(buf.length - n);
        if (!word.toLowerCase().startsWith(tail.toLowerCase())) continue;
        // only a real prefix if a word actually starts there
        if (n < buf.length && /[\p{L}\p{N}_]/u.test(buf[buf.length - n - 1])) continue;
        return n;
      }
    }
    return 0;
  }

  // the markup ships with Jun and Anon written into it in about twenty
  // places. rather than templating every one, walk it once at boot and run
  // the same apply() the chat bubbles use. anything under [data-no-rename]
  // is skipped, that's for copy which is ABOUT the defaults ("leave blank
  // for the default (Jun)") and gets nonsense if you rename it.
  const ATTRS = ['placeholder', 'title', 'aria-label', 'content'];
  function decorate(root) {
    if (!renamed()) return;
    root = root || document.body;
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement && node.parentElement.closest('[data-no-rename]')
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const next = apply(n.nodeValue);
      if (next !== n.nodeValue) n.nodeValue = next;
    }
    for (const el of root.querySelectorAll('[' + ATTRS.join('],[') + ']')) {
      if (el.closest('[data-no-rename]')) continue;
      for (const a of ATTRS) {
        const v = el.getAttribute(a);
        if (v == null) continue;
        const next = apply(v);
        if (next !== v) el.setAttribute(a, next);
      }
    }
    if (document.title) document.title = apply(document.title);
  }

  return { load, getPlayer, getBot, setPlayer, setBot, apply, canonicalize,
           pendingPartial, decorate, DEFAULT_PLAYER, DEFAULT_BOT };
})();
