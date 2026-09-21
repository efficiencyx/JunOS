// blackjack. she deals, the table is a panel over the chat, and
// every settled hand goes out as an ephemeral stage direction so
// she can gloat or sulk in the face bubble.
window.Cards = (function () {
  const SUITS = ['♠', '♥', '♦', '♣'];
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

  let sendEvent = null;
  let isBusy = () => false;
  let panel = null, herRow, youRow, herVal, youVal, tallyEl, noteEl, hitBtn, standBtn, nextBtn;
  let deck = [], her = [], you = [];
  let hand = 0, score = { you: 0, her: 0 };
  let phase = 'idle';

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

  function deal() {
    her = [draw(), draw()];
    you = [draw(), draw()];
    hand++;
    phase = 'player';
    render();
    const yv = value(you), hv = value(her);
    if (yv === 21 || hv === 21) {
      if (yv === 21 && hv === 21) settle('push', 'both of you were dealt blackjack, push');
      else if (yv === 21) settle('you', 'Anon was dealt blackjack');
      else settle('her', `${bot()} was dealt blackjack`);
    }
  }

  function hit() {
    if (phase !== 'player') return;
    you.push(draw());
    if (value(you) > 21) settle('her', `Anon hit and busted at ${value(you)} (${show(you)})`);
    else render();
  }

  function stand() {
    if (phase !== 'player') return;
    while (value(her) < 17) her.push(draw());
    const yv = value(you), hv = value(her);
    if (hv > 21) settle('you', `Anon stood on ${yv}, ${bot()} drew to ${hv} and busted (${show(her)})`);
    else if (yv > hv) settle('you', `Anon stood on ${yv}, ${bot()} stopped at ${hv}`);
    else if (hv > yv) settle('her', `Anon stood on ${yv}, ${bot()} made ${hv}`);
    else settle('push', `both on ${yv}, push`);
  }

  function settle(winner, how) {
    phase = 'done';
    if (winner === 'you') score.you++;
    if (winner === 'her') score.her++;
    render();
    const won = winner === 'push' ? 'Nobody wins the hand.' : (winner === 'you' ? 'Anon wins the hand.' : `${bot()} wins the hand.`);
    send(`(Card table, hand ${hand}: ${how}. ${won} Score: ${tallyText()}.)`);
  }

  // ponytail: sendTouchEvent drops the event while she's still
  // talking, so wait her out. 30 s is longer than any reply.
  function send(text) {
    if (!sendEvent) return;
    nextBtn.disabled = true;
    const t0 = Date.now();
    const tick = () => {
      if (isBusy() && Date.now() - t0 < 30000) return setTimeout(tick, 500);
      sendEvent(text);
      nextBtn.disabled = false;
    };
    tick();
  }

  function cardEl(c, down) {
    const el = document.createElement('div');
    el.className = 'card' + (down ? ' down' : '') + (c.s === '♥' || c.s === '♦' ? ' red' : '');
    el.textContent = down ? '' : c.r + c.s;
    return el;
  }

  function render() {
    herRow.replaceChildren(...her.map((c, i) => cardEl(c, phase === 'player' && i === 1)));
    youRow.replaceChildren(...you.map(c => cardEl(c, false)));
    herVal.textContent = phase === 'player' ? String(value([her[0]])) + ' + ?' : String(value(her));
    youVal.textContent = String(value(you));
    tallyEl.textContent = `hand ${hand} · ${tallyText()}`;
    hitBtn.disabled = standBtn.disabled = phase !== 'player';
    nextBtn.hidden = phase !== 'done';
  }

  function build() {
    if (panel) return;
    panel = document.createElement('section');
    panel.className = 'card-table';
    panel.hidden = true;
    panel.setAttribute('aria-label', 'Blackjack table');
    panel.innerHTML = `
      <header><span class="ct-title">Blackjack</span><span class="ct-tally"></span><button class="icon-btn ct-leave" title="Leave the table" aria-label="Leave the table">×</button></header>
      <div class="ct-hand"><div class="ct-label"><span class="ct-who"></span> <span class="ct-val"></span></div><div class="ct-cards ct-her"></div></div>
      <div class="ct-hand"><div class="ct-label">You <span class="ct-val"></span></div><div class="ct-cards ct-you"></div></div>
      <div class="ct-actions">
        <button class="secondary ct-hit">Hit</button>
        <button class="secondary ct-stand">Stand</button>
        <button class="ct-next" hidden>Next hand</button>
      </div>`;
    document.body.appendChild(panel);
    herRow = panel.querySelector('.ct-her');
    youRow = panel.querySelector('.ct-you');
    [herVal, youVal] = panel.querySelectorAll('.ct-val');
    tallyEl = panel.querySelector('.ct-tally');
    hitBtn = panel.querySelector('.ct-hit');
    standBtn = panel.querySelector('.ct-stand');
    nextBtn = panel.querySelector('.ct-next');
    panel.querySelector('.ct-who').textContent = bot();
    hitBtn.addEventListener('click', hit);
    standBtn.addEventListener('click', stand);
    nextBtn.addEventListener('click', deal);
    panel.querySelector('.ct-leave').addEventListener('click', close);
  }

  function open() {
    build();
    if (!panel.hidden) return;
    score = { you: 0, her: 0 };
    hand = 0;
    deck = newDeck();
    panel.hidden = false;
    deal();
  }

  function close() {
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    const final = phase === 'player' ? ' Anon folded the last hand.' : '';
    phase = 'idle';
    if (hand > 0) send(`(Card table: Anon gets up after ${hand} hand${hand === 1 ? '' : 's'}, final score ${tallyText()}.${final})`);
  }

  function init(opts) {
    sendEvent = opts.sendEvent || null;
    isBusy = opts.isBusy || isBusy;
  }

  return { init, open, close };
})();
