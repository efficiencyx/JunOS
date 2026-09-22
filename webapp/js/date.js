// the date page. same skeleton as wardrobe.js, but her lines come
// from the model: every turn is one ephemeral turn (nothing
// stored, gauges still move) carrying an OOC stage direction, and
// the reply goes through WardrobeReactions.say(). the trip
// endpoint writes the memory note on the way home, the turns
// themselves leave nothing behind.
//
// she orders for herself. Anon taps his own dish on the card, hers
// comes out of her reply as an ORDER: tag (SUGGEST: is her
// proposing one for him). there is no button that picks for her.
(async () => {
  const status = document.getElementById('stageStatus');
  const list = document.getElementById('menuList');
  const input = document.getElementById('sayInput');
  const sendBtn = document.getElementById('sendBtn');
  const orderBtn = document.getElementById('orderBtn');
  const billBtn = document.getElementById('billBtn');
  const lastLine = document.getElementById('lastLine');

  const MENU = {
    lunch: [
      ['🥪', 'a club sandwich', 'The club sandwich', 'From the kitchen'],
      ['🍜', 'a bowl of ramen', 'Ramen', 'From the kitchen'],
      ['🍳', 'omurice', 'Omurice', 'From the kitchen'],
      ['🍛', 'a katsu curry', 'Katsu curry', 'From the kitchen'],
      ['🥗', 'a big salad', 'Garden salad', 'From the kitchen'],
      ['🍕', 'a slice of pizza', 'Pizza by the slice', 'From the kitchen'],
      ['🧊', 'an iced coffee', 'Iced coffee', 'Something to sip'],
      ['🍋', 'a lemonade', 'Cloudy lemonade', 'Something to sip'],
    ],
    dinner: [
      ['🥩', 'a steak', 'Steak frites', 'The main affair'],
      ['🍝', 'pasta carbonara', 'Carbonara', 'The main affair'],
      ['🍣', 'a sushi platter', 'Sushi selection', 'The main affair'],
      ['🍚', 'mushroom risotto', 'Mushroom risotto', 'The main affair'],
      ['🐟', 'grilled fish', 'Grilled fish', 'The main affair'],
      ['🍷', 'a glass of red wine', 'House red', 'By the glass'],
      ['🍰', 'tiramisu', 'Tiramisu', 'A sweet ending'],
      ['🧁', 'cheesecake', 'Cheesecake', 'A sweet ending'],
    ],
  };
  const PLACE = { lunch: 'Café Marigold', dinner: 'Trattoria La Lanterna' };
  const meal = new Date().getHours() < 16 ? 'lunch' : 'dinner';
  const dishes = MENU[meal];
  document.body.dataset.meal = meal;
  const FALLBACK = {
    arrive: "Okay. It's nicer than I expected. Don't make it weird.",
    talk: "...Say that again. I was reading.",
    order: "Fine. Let's see if the kitchen is as good as the menu makes it sound.",
    leave: 'Walk me home. And no, that was not a thank you.',
  };

  const picks = { me: '', her: '' };
  let suggested = '';
  let mentioned = '';
  let ready = false;
  let ordered = false;
  let busy = false;
  let history = [];
  let conversationId = 0;
  const her = () => window.Names ? Names.getBot() : 'Jun';

  const clientTime = () => {
    try {
      return new Date().toLocaleString(undefined, {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
      });
    } catch (e) { return new Date().toString(); }
  };

  // "ORDER: the carbonara, please" has to land on a menu row. score
  // each dish by how many of its own words show up, most hits wins,
  // ties go to menu order. the stop list is the filler both names
  // share ("a glass of", "house", "selection")
  const STOP = new Set(['a', 'an', 'the', 'of', 'by', 'glass', 'bowl', 'slice', 'big', 'house', 'selection', 'platter']);
  const keys = (d) => `${d[1]} ${d[2]}`.toLowerCase().split(/\W+/).filter(w => w && !STOP.has(w));
  function matchDish(text) {
    const t = ' ' + text.toLowerCase().replace(/\W+/g, ' ') + ' ';
    let best = null, bestHits = 0;
    for (const d of dishes) {
      const hits = keys(d).filter(k => t.includes(' ' + k + ' ')).length;
      if (hits > bestHits) { best = d; bestHits = hits; }
    }
    return best;
  }

  const TAG_RE = /\[?\b(ORDER|SUGGEST)\s*:\s*([^\n\[\]().!?,;]+)[\])]?/gi;
  // for display the whole bracket goes, or the rest of the sentence
  // when she wrote it bare
  const STRIP_RE = /\[\s*(?:ORDER|SUGGEST)\s*:[^\]\n]*\]?|\b(?:ORDER|SUGGEST)\s*:[^\n.!?]*[.!?]?/gi;
  function readTags(raw) {
    for (const m of raw.matchAll(TAG_RE)) {
      const d = matchDish(m[2]);
      if (!d) continue;
      if (m[1].toUpperCase() === 'ORDER') picks.her = d[1]; else suggested = d[1];
    }
    // she does not always remember the tag. "I'll have the risotto"
    // is an order too
    if (!picks.her) {
      const m = raw.match(/\bI(?:['\u2019]ll|['\u2019]m| will| am) (?:have|having|take|taking|get|getting|go|going|order|ordering)\b(?: with)?([^.!?\n]{0,60})/i);
      const d = m && matchDish(m[1]);
      if (d) picks.her = d[1];
    }
    // ponytail: last dish she named at all, only used if the waiter
    // turn comes back with no order. over-matches on chit chat
    const d = matchDish(raw);
    if (d) mentioned = d[1];
  }

  const OOC = '(OOC stage direction, not spoken by Anon: ';
  const menuNote = () => `The menu: ${dishes.map(d => d[2]).join(', ')}. You choose your own food, nobody orders for you. When you have decided what you want, end your line with ORDER: <the dish as written on the menu>. To suggest a dish for Anon add SUGGEST: <dish>. Anon ${picks.me ? 'is having ' + picks.me : "hasn't picked yet"}.`;
  function note(phase) {
    if (phase === 'arrive') return `${OOC}you and Anon just sat down at ${PLACE[meal]} for ${meal} and opened the menu. Say one or two lines out loud, in character, as you look around and at him. No narration. ${menuNote()})`;
    if (phase === 'talk') {
      if (ordered) return `${OOC}at the table eating, Anon has ${picks.me} and you have ${picks.her}. Answer him out loud, in character, one to three lines. No narration.)`;
      return `${OOC}reading the menu together. Answer him out loud, in character, one to three lines. No narration. ${menuNote()})`;
    }
    if (phase === 'waiter') {
      if (picks.her) return `${OOC}the waiter takes the order: ${picks.me} for Anon, ${picks.her} for you, your own pick. React out loud in one or two lines, in character. No narration.)`;
      return `${OOC}the waiter is at the table and Anon just ordered ${picks.me}. Tell him what you are having, ending your line with ORDER: <dish from the menu>. One or two lines, in character. No narration. ${menuNote()})`;
    }
    return `${OOC}the ${meal} is over, Anon asked for the bill and you two are getting up to walk home. Say one or two lines out loud, in character. No narration.)`;
  }

  function turn(content) {
    return new Promise((resolve) => {
      if (!window.ChatAPI || !conversationId) return resolve('');
      let text = '';
      history.push({ role: 'user', content });
      ChatAPI.chat(
        { messages: [...history], conversation_id: conversationId, ephemeral: true,
          client_time: clientTime(), outfit_context: window.Outfit ? Outfit.describe() : '' },
        {
          onToken: (t) => { text += t; },
          onDone: () => {
            if (text.trim()) history.push({ role: 'assistant', content: text });
            resolve(text);
          },
          onError: () => resolve(text),
        }
      );
    });
  }

  // one ephemeral turn. the tags are stripped after the fact rather
  // than mid-stream, the card shows the whole line at once anyway
  async function ask(content, fallback) {
    busy = true;
    status.textContent = '…';
    setComposer();
    const raw = await turn(content);
    readTags(raw);
    let line = raw.replace(STRIP_RE, '').replace(/\[\s*A(?:CTIONS?)?\s*:[^\]]*\]/gi, '')
      .replace(/\s+/g, ' ').replace(/^[\s,.;:]+/, '').trim();
    if (window.Names) line = Names.apply(line);
    line = line || fallback;
    status.textContent = '';
    lastLine.textContent = line;
    busy = false;
    renderMarks();
    return line;
  }

  const speak = (line) => window.WardrobeReactions ? WardrobeReactions.say(line) : undefined;

  function setComposer() {
    const locked = busy || !ready;
    // NEVER disable this while she's answering. disabling the focused
    // input drops focus, and on a phone that shuts the keyboard and
    // reopens it every single turn. the submit handler guards on busy
    // instead, so a stray Enter just does nothing and keeps your text.
    input.disabled = !ready;
    sendBtn.disabled = locked;
    orderBtn.disabled = locked || ordered;
    billBtn.disabled = locked;
  }

  function renderMarks() {
    const h = her();
    document.getElementById('menuHint').textContent = hintText();
    for (const b of list.querySelectorAll('.dish')) {
      const mine = b.dataset.name === picks.me;
      b.setAttribute('aria-pressed', String(mine));
      const notes = [];
      if (b.dataset.name === picks.her) notes.push(`${h}'s choice`);
      if (b.dataset.name === suggested) notes.push(mine ? `${h} suggested it` : `${h} says try it`);
      b.querySelector('.dish-note').textContent = notes.join(' · ');
    }
    setComposer();
  }

  const hintText = () => `Tap what you'd like. ${her()} orders for herself.`;

  function renderMenu() {
    const h = her();
    document.title = meal === 'lunch' ? 'Lunch for two' : 'Dinner for two';
    document.getElementById('menuNames').textContent = `${window.Names ? Names.getPlayer() : 'Anon'} & ${h}`;
    document.getElementById('menuDate').textContent = `${meal === 'lunch' ? 'Lunch' : 'Dinner'} · ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}`;
    document.getElementById('menuPlace').textContent = PLACE[meal];
    document.getElementById('menuHint').textContent = hintText();
    let course = '';
    for (const d of dishes) {
      if (d[3] !== course) {
        course = d[3];
        const heading = document.createElement('h3');
        heading.className = 'menu-course';
        heading.textContent = course;
        list.appendChild(heading);
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dish';
      b.dataset.name = d[1];
      b.setAttribute('aria-pressed', 'false');
      const title = document.createElement('span'); title.className = 'dish-title'; title.textContent = d[2];
      const mark = document.createElement('span'); mark.className = 'dish-note';
      b.append(title, mark);
      b.addEventListener('click', () => {
        if (ordered) return;
        picks.me = picks.me === d[1] ? '' : d[1];
        renderMarks();
      });
      list.appendChild(b);
    }
  }

  async function callWaiter() {
    if (busy || ordered) return;
    if (!picks.me) {
      // dead disabled button teaches nobody anything. say what's
      // missing and put the cursor on the thing they have to touch
      const hint = document.getElementById('menuHint');
      hint.textContent = `Pick something off the menu first. ${her()} orders for herself.`;
      const first = list.querySelector('.dish');
      if (first) first.focus();
      return;
    }
    ordered = true;
    const line = await ask(note('waiter'), FALLBACK.order);
    // ponytail: she dodged the waiter. whatever dish she named
    // last is what she gets, or the kitchen picks
    if (!picks.her) picks.her = mentioned || dishes[Math.floor(Math.random() * dishes.length)][1];
    for (const who of ['me', 'her']) {
      document.getElementById(who === 'me' ? 'plateMe' : 'plateHer').textContent = dishes.find(d => d[1] === picks[who])[0];
    }
    document.body.classList.add('ordered', 'served');
    orderBtn.hidden = true;
    billBtn.hidden = false;
    setComposer();
    await speak(line);
  }

  async function goHome() {
    if (busy) return;
    billBtn.disabled = true;
    billBtn.textContent = 'Heading home…';
    await speak(await ask(note('leave'), FALLBACK.leave));
    try {
      await fetch('api/trip.php?action=home', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meal, dishes: picks }),
      });
    } catch (e) {}
    location.href = 'index.html?from=date';
  }

  const me = await Auth.me().catch(() => null);
  if (!me) { location.replace('index.html'); return; }
  // she has to have agreed in chat. a dead endpoint (android has
  // none) counts as open, this is a story rule not a security one
  const trip = await fetch('api/trip.php', { credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : null).catch(() => null);
  if (trip && trip.gated && trip.where !== 'date') { location.replace('index.html'); return; }
  // mount AFTER the gate. bounced users used to sit through the whole
  // walk and get redirected at the end of it anyway
  TripLoader.mount();
  TripLoader.setStage('Finding your table');
  Scene.inject('.room', 'scene/diner.svg');
  Scene.inject('.table', 'scene/table.svg');
  conversationId = trip ? Number(trip.conversation_id) || 0 : 0;

  if (window.Prefs) await Prefs.pullFromServer();
  if (window.Names) { Names.load(); Names.decorate(); }
  renderMenu();

  // the tail of the chat she agreed in, so the lines follow on
  // from it instead of starting cold. <audio> rows are a
  // placeholder, not words
  if (conversationId) {
    try {
      const rows = await fetch(`api/conversations.php?action=messages&id=${conversationId}`, { credentials: 'same-origin' })
        .then(r => r.ok ? r.json() : []);
      history = rows.filter(r => r.content !== '<audio>').slice(-20).map(r => ({ role: r.role, content: r.content }));
    } catch (e) {}
  }

  document.getElementById('composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy || !ready) return;
    input.value = '';
    const spoken = window.Names ? Names.canonicalize(text) : text;
    speak(await ask(`${spoken}\n\n${note('talk')}`, FALLBACK.talk));
    input.focus();
  });
  orderBtn.addEventListener('click', callWaiter);
  billBtn.addEventListener('click', goHome);

  try {
    await Live2D.init({
      stageEl: document.getElementById('stage'),
      onStatus: (s) => {
        status.textContent = s;
        TripLoader.setStage(s);
      },
      ignoreSavedPos: true,
    });
    await Outfit.load();
    Outfit.applyAll();
    Live2D.startIdle();
    Live2D.setCameraPreset('face');
    TripLoader.setStage(meal === 'lunch' ? 'Lunch, finally' : 'Table for two');
    await TripLoader.finish();
    status.textContent = '';
    ready = true;
    speak(await ask(note('arrive'), FALLBACK.arrive));
  } catch (e) {
    console.error(e);
    status.textContent = 'Load error: ' + e.message;
    TripLoader.fail('Load error: ' + e.message);
  }
})();
