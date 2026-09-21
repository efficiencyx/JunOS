// blackjack, turn based. Anon hits or stands, then she gets one
// move, then Anon again, until both stand or somebody busts.
// standing is final. her move is one ephemeral turn with the
// hands in an OOC direction, the word she answers with is the
// move. no dealer rule, she can stand on 12 or bust on 19,
// that's her problem. the table is a full-page mode like voice
// mode, chat chrome hidden, stage stays up on the face preset so
// her lines land in the face bubble.
window.Cards = (function () {
  const SUITS = ['♠', '♥', '♦', '♣'];
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

  let sendEvent = null;
  let isBusy = () => false;
  let overlay = null, herRow, youRow, herVal, youVal, tallyEl, statusEl, hitBtn, standBtn, nextBtn;
  let deck = [], her = [], you = [];
  let hand = 0, score = { you: 0, her: 0 };
  let youStood = false, herStood = false;
  let phase = 'idle';
  let active = false;

  const bot = () => (window.Names ? Names.getBot() : 'Jun');

  function newDeck() {
    const d = [];
    for (const s of SUITS) for (const r of RANKS) d.push({ r, s });
    for (let i = d.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [d[i], d[j]] = [d[j], d[i]];
    }
    return d;
  }

  function draw() {
    if (deck.length < 15) deck = newDeck();
    return deck.pop();
  }

  function value(cards) {
    let total = 0, aces = 0;
    for (const c of cards) {
      if (c.r === 'A') { aces++; total += 11; }
      else if (c.r === 'J' || c.r === 'Q' || c.r === 'K') total += 10;
      else total += Number(c.r);
    }
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return total;
  }

  const show = (cards) => cards.map(c => c.r + c.s).join(' ');

  function tallyText() {
    if (score.you === score.her) return `tied ${score.you}-${score.her}`;
    return score.you > score.her ? `Anon leads ${score.you}-${score.her}` : `${bot()} leads ${score.her}-${score.you}`;
  }

  // ponytail: sendTouchEvent drops the event while she's still
  // talking, so wait her out. 30 s is longer than any reply. a
  // refused send (fled, or gave up waiting) answers null so the
  // caller can fall back.
  function send(text) {
    return new Promise((resolve) => {
      if (!sendEvent || !active) return resolve(null);
      const t0 = Date.now();
      const tick = () => {
        if (!active) return resolve(null);
        if (isBusy() && Date.now() - t0 < 30000) return setTimeout(tick, 500);
        if (!sendEvent(text, resolve)) resolve(null);
      };
      tick();
    });
  }

  function deal() {
    her = [draw(), draw()];
    you = [draw(), draw()];
    youStood = herStood = false;
    hand++;
    phase = 'player';
    render();
    const yv = value(you), hv = value(her);
    if (yv === 21 && hv === 21) settle('push', 'both of you were dealt blackjack, push');
    else if (yv === 21) settle('you', 'Anon was dealt blackjack');
    else if (hv === 21) settle('her', `${bot()} was dealt blackjack`);
  }

  function hit() {
    if (phase !== 'player') return;
    you.push(draw());
    if (value(you) > 21) settle('her', `Anon hit and busted at ${value(you)} (${show(you)})`);
    else herTurn();
  }

  function stand() {
    if (phase !== 'player') return;
    youStood = true;
    herTurn();
  }

  // HIT or STAND is the first of the two words she says. no word
  // at all (error, stopped, a line that dodges the question) and
  // the plain dealer rule stands in, hit under 17, so the hand
  // still ends.
  function readMove(reply) {
    const m = (reply || '').match(/\b(hit|stand|stay|stop)\b/i);
    if (m) return m[1].toLowerCase() === 'hit' ? 'hit' : 'stand';
    return value(her) < 17 ? 'hit' : 'stand';
  }

  // one card per turn while Anon is still playing. once Anon
  // stands she keeps going on her own until she stands or busts.
  async function herTurn() {
    phase = 'her';
    render();
    const yv = value(you);
    while (active && phase === 'her' && !herStood) {
      const hv = value(her);
      if (hv >= 21) { herStood = true; break; }
      setStatus(`${bot()} is thinking…`);
      const anon = youStood ? `Anon is standing on ${yv} with ${show(you)}` : `Anon holds ${show(you)} = ${yv} and is still playing`;
      const reply = await send(`(Card table, hand ${hand}, your move: you hold ${show(her)} = ${hv}. ${anon}. Say HIT to take another card or STAND to stop, that word first, then one short line.)`);
      if (!active || phase !== 'her') return;
      if (readMove(reply) === 'stand') { herStood = true; break; }
      her.push(draw());
      render();
      if (value(her) > 21) return settle('you', `${bot()} hit and busted at ${value(her)} (${show(her)})`);
      if (!youStood) break;
    }
    if (!active || phase !== 'her') return;
    if (youStood && herStood) return showdown();
    phase = 'player';
    render();
  }

  function showdown() {
    const yv = value(you), hv = value(her);
    if (yv > hv) settle('you', `Anon stood on ${yv}, ${bot()} stopped at ${hv}`);
    else if (hv > yv) settle('her', `Anon stood on ${yv}, ${bot()} made ${hv}`);
    else settle('push', `both on ${yv}, push`);
  }

  function settle(winner, how) {
    phase = 'done';
    if (winner === 'you') score.you++;
    if (winner === 'her') score.her++;
    render();
    const won = winner === 'push' ? 'Nobody wins the hand.' : (winner === 'you' ? 'Anon wins the hand.' : `${bot()} wins the hand.`);
    setStatus(won);
    send(`(Card table, hand ${hand}: ${how}. ${won} Score: ${tallyText()}.)`);
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function cardEl(c, down) {
    const el = document.createElement('div');
    el.className = 'card' + (down ? ' down' : '') + (c.s === '♥' || c.s === '♦' ? ' red' : '');
    el.textContent = down ? '' : c.r + c.s;
    return el;
  }

  function render() {
    const hole = phase !== 'done';
    herRow.replaceChildren(...her.map((c, i) => cardEl(c, hole && i === 1)));
    youRow.replaceChildren(...you.map(c => cardEl(c, false)));
    herVal.textContent = hole ? String(value([her[0]])) + ' + ?' : String(value(her));
    youVal.textContent = String(value(you));
    tallyEl.textContent = `hand ${hand} · ${tallyText()}`;
    hitBtn.disabled = standBtn.disabled = phase !== 'player';
    nextBtn.hidden = phase !== 'done';
    if (phase === 'player') setStatus(herStood ? `${bot()} is standing. your move` : 'your move');
  }

  function build() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'cards-overlay';
    overlay.hidden = true;
    overlay.setAttribute('aria-label', 'Blackjack table');
    overlay.innerHTML = `
      <button class="voice-overlay-btn cards-close" type="button" aria-label="Leave the table" title="Leave the table">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <div class="cards-tally"></div>
      <div class="cards-hand cards-her"><div class="cards-label"><span class="cards-who"></span> <span class="cards-val"></span></div><div class="cards-row"></div></div>
      <div class="cards-felt">
        <div class="cards-hand cards-you"><div class="cards-label">You <span class="cards-val"></span></div><div class="cards-row"></div></div>
        <div class="cards-status"></div>
        <div class="cards-actions">
          <button class="secondary cards-hit" type="button">Hit</button>
          <button class="secondary cards-stand" type="button">Stand</button>
          <button class="cards-next" type="button" hidden>Next hand</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    herRow = overlay.querySelector('.cards-her .cards-row');
    youRow = overlay.querySelector('.cards-you .cards-row');
    herVal = overlay.querySelector('.cards-her .cards-val');
    youVal = overlay.querySelector('.cards-you .cards-val');
    tallyEl = overlay.querySelector('.cards-tally');
    statusEl = overlay.querySelector('.cards-status');
    hitBtn = overlay.querySelector('.cards-hit');
    standBtn = overlay.querySelector('.cards-stand');
    nextBtn = overlay.querySelector('.cards-next');
    hitBtn.addEventListener('click', hit);
    standBtn.addEventListener('click', stand);
    nextBtn.addEventListener('click', deal);
    overlay.querySelector('.cards-close').addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && active) close(); });
  }

  function open() {
    build();
    if (active) return;
    active = true;
    overlay.querySelector('.cards-who').textContent = bot();
    score = { you: 0, her: 0 };
    hand = 0;
    deck = newDeck();
    overlay.hidden = false;
    void overlay.offsetHeight;
    document.body.classList.add('cards-mode');
    if (window.Live2D) Live2D.setCameraPreset('face');
    deal();
  }

  function close() {
    if (!active) return;
    const folded = phase === 'player' || phase === 'her' ? ' Anon left the last hand unfinished.' : '';
    const played = hand;
    const tally = tallyText();
    active = false;
    phase = 'idle';
    document.body.classList.remove('cards-mode');
    setTimeout(() => { if (!active) overlay.hidden = true; }, 300);
    if (window.Live2D && !(window.VoiceMode && VoiceMode.isActive())) Live2D.setCameraPreset('default');
    if (played > 0 && sendEvent) {
      sendEvent(`(Card table: Anon gets up after ${played} hand${played === 1 ? '' : 's'}, final score ${tally}.${folded})`);
    }
  }

  function isActive() { return active; }

  function init(opts) {
    sendEvent = opts.sendEvent || null;
    isBusy = opts.isBusy || isBusy;
  }

  return { init, open, close, isActive };
})();
