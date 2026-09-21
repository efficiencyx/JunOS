// the date page. same skeleton as wardrobe.js, but her lines come
// from the model: each phase sends one ephemeral turn (nothing
// stored, gauges still move) with an OOC stage direction, and
// the reply goes through WardrobeReactions.say(). the trip
// endpoint writes the memory note on the way home, the turns
// themselves leave nothing behind.
(async () => {
  const status = document.getElementById('stageStatus');
  const list = document.getElementById('menuList');
  const summary = document.getElementById('menuSummary');
  const orderBtn = document.getElementById('orderBtn');
  const billBtn = document.getElementById('billBtn');

  const MENU = {
    lunch: [
      ['🥪', 'a club sandwich', 'The club sandwich', 'Toasted layers, crisp lettuce & golden fries', 'From the kitchen'],
      ['🍜', 'a bowl of ramen', 'Ramen', 'A warming bowl of broth, noodles & greens', 'From the kitchen'],
      ['🍳', 'omurice', 'Omurice', 'Soft omelette, seasoned rice & a little nostalgia', 'From the kitchen'],
      ['🍛', 'a katsu curry', 'Katsu curry', 'Crisp golden cutlet, fragrant curry & rice', 'From the kitchen'],
      ['🥗', 'a big salad', 'Garden salad', 'Seasonal leaves with a bright house dressing', 'From the kitchen'],
      ['🍕', 'a slice of pizza', 'Pizza by the slice', 'Tomato, melted cheese & a crisp crust', 'From the kitchen'],
      ['🧊', 'an iced coffee', 'Iced coffee', 'Freshly brewed, poured over ice', 'Something to sip'],
      ['🍋', 'a lemonade', 'Cloudy lemonade', 'Fresh lemon, a little sweetness & lots of ice', 'Something to sip'],
    ],
    dinner: [
      ['🥩', 'a steak', 'Steak frites', 'Seared steak, golden fries & herb butter', 'The main affair'],
      ['🍝', 'pasta carbonara', 'Carbonara', 'Silky pasta, pecorino & cracked black pepper', 'The main affair'],
      ['🍣', 'a sushi platter', 'Sushi selection', 'A delicate assortment, freshly prepared', 'The main affair'],
      ['🍚', 'mushroom risotto', 'Mushroom risotto', 'Creamy arborio rice & earthy mushrooms', 'The main affair'],
      ['🐟', 'grilled fish', 'Grilled fish', 'Lightly charred, with lemon & seasonal greens', 'The main affair'],
      ['🍷', 'a glass of red wine', 'House red', 'A mellow glass to take your time over', 'By the glass'],
      ['🍰', 'tiramisu', 'Tiramisu', 'Coffee-soaked layers & a dusting of cocoa', 'A sweet ending'],
      ['🧁', 'cheesecake', 'Cheesecake', 'A creamy slice with a buttery biscuit base', 'A sweet ending'],
    ],
  };
  const meal = new Date().getHours() < 16 ? 'lunch' : 'dinner';
  document.body.dataset.meal = meal;
  const FALLBACK = {
    arrive: "Okay. It's nicer than I expected. Don't make it weird.",
    order: "...You ordered for me. Fine. Let's see if you were paying attention.",
    leave: 'Walk me home. And no, that was not a thank you.',
  };

  const picks = { me: '', her: '' };
  let ready = false;
  let ordered = false;
  let history = [];
  let conversationId = 0;

  const clientTime = () => {
    try {
      return new Date().toLocaleString(undefined, {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
      });
    } catch (e) { return new Date().toString(); }
  };

  function direction(phase) {
    const head = '(OOC stage direction, not spoken by Anon: ';
    if (phase === 'arrive') return head + `you and Anon just sat down at a small restaurant for ${meal}. Say one or two lines out loud, in character, as you look around and at him. No narration.)`;
    if (phase === 'order') return head + `at the restaurant. Anon ordered ${picks.me} for himself and ${picks.her} for you. React out loud in one or two lines, in character. Whether you like it is yours to decide. No narration.)`;
    return head + `the ${meal} is over, Anon asked for the bill and you two are getting up to walk home. Say one or two lines out loud, in character. No narration.)`;
  }

  // one ephemeral turn. the [A:...] tags are stripped after the
  // fact rather than mid-stream, the card shows the whole line at
  // once anyway
  function ask(phase) {
    return new Promise((resolve) => {
      if (!window.ChatAPI || !conversationId) return resolve(FALLBACK[phase]);
      let text = '';
      const finish = () => {
        text = text.replace(/\[\s*A(?:CTIONS?)?\s*:[^\]]*\]/gi, '').replace(/\s+/g, ' ').trim();
        if (window.Names) text = Names.apply(text);
        resolve(text || FALLBACK[phase]);
      };
      const stage = { role: 'user', content: direction(phase) };
      history.push(stage);
      ChatAPI.chat(
        { messages: [...history], conversation_id: conversationId, ephemeral: true,
          client_time: clientTime(), outfit_context: window.Outfit ? Outfit.describe() : '' },
        {
          onToken: (t) => { text += t; },
          onDone: () => {
            if (text.trim()) history.push({ role: 'assistant', content: text });
            finish();
          },
          onError: finish,
        }
      );
    });
  }

  async function say(phase) {
    status.textContent = '…';
    const line = await ask(phase);
    status.textContent = '';
    if (window.WardrobeReactions) await WardrobeReactions.say(line);
  }

  function renderMenu() {
    document.getElementById('menuTitle').textContent = meal === 'lunch' ? 'The lunch menu' : 'The dinner menu';
    document.getElementById('menuSubtitle').textContent = meal === 'lunch' ? 'A slow afternoon, a table for two' : 'A little candlelight. Something delicious.';
    document.getElementById('mealLabel').textContent = meal === 'lunch' ? 'Lunch · A sunny little corner' : 'Dinner · Just the two of you';
    document.title = meal === 'lunch' ? 'Lunch for two' : 'Dinner for two';
    const her = window.Names ? Names.getBot() : 'Jun';
    document.getElementById('herLabel').textContent = 'For ' + her;
    let category = '';
    for (const [, name, title, description, section] of MENU[meal]) {
      if (section !== category) {
        category = section;
        const heading = document.createElement('h3');
        heading.className = 'menu-category';
        heading.textContent = section;
        list.appendChild(heading);
      }
      const row = document.createElement('div');
      row.className = 'dish';
      const copy = document.createElement('div');
      copy.className = 'dish-copy';
      const n = document.createElement('span'); n.className = 'dish-name'; n.textContent = title;
      const d = document.createElement('span'); d.className = 'dish-description'; d.textContent = description;
      copy.append(n, d);
      const choices = document.createElement('div');
      choices.className = 'dish-choices';
      for (const who of ['me', 'her']) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = who === 'me' ? 'You' : her;
        b.setAttribute('aria-label', `${title} for ${who === 'me' ? 'you' : her}`);
        b.setAttribute('aria-pressed', 'false');
        b.dataset.who = who;
        b.dataset.name = name;
        b.addEventListener('click', () => pick(who, name));
        choices.appendChild(b);
      }
      row.append(copy, choices);
      list.appendChild(row);
    }
  }

  function pick(who, name) {
    if (ordered) return;
    picks[who] = picks[who] === name ? '' : name;
    list.querySelectorAll(`button[data-who="${who}"]`).forEach(b => {
      const selected = b.dataset.name === picks[who];
      b.classList.toggle('on', selected);
      b.setAttribute('aria-pressed', String(selected));
    });
    const dish = MENU[meal].find(item => item[1] === picks[who]);
    document.getElementById(who === 'me' ? 'pickMe' : 'pickHer').textContent = dish ? dish[2] : 'Still deciding…';
    const count = Number(!!picks.me) + Number(!!picks.her);
    summary.textContent = count === 2 ? 'Two lovely choices. Ready when you are.' : count === 1 ? 'One more choice for the table.' : 'Pick one item each to order.';
    orderBtn.disabled = !(ready && picks.me && picks.her);
  }

  async function goHome() {
    billBtn.disabled = true;
    billBtn.textContent = 'Heading home…';
    document.getElementById('tableCaption').textContent = 'Until next time.';
    await say('leave');
    try {
      await fetch('api/trip.php?action=home', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meal, dishes: picks }),
      });
    } catch (e) {}
    location.href = 'index.html?from=date';
  }

  TripLoader.mount();
  TripLoader.setStage('Finding your table');
  const me = await Auth.me().catch(() => null);
  if (!me) { location.replace('index.html'); return; }
  // she has to have agreed in chat. a dead endpoint (android has
  // none) counts as open, this is a story rule not a security one
  const trip = await fetch('api/trip.php', { credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : null).catch(() => null);
  if (trip && trip.gated && trip.where !== 'date') { location.replace('index.html'); return; }
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

  orderBtn.addEventListener('click', async () => {
    if (!ready || ordered || !picks.me || !picks.her) return;
    ordered = true;
    orderBtn.disabled = true;
    orderBtn.textContent = 'Placing your order…';
    summary.textContent = 'Something good is on its way.';
    list.querySelectorAll('button').forEach(b => { b.disabled = true; });
    for (const who of ['me', 'her']) {
      document.getElementById(who === 'me' ? 'plateMe' : 'plateHer').textContent = MENU[meal].find(item => item[1] === picks[who])[0];
    }
    document.body.classList.add('served');
    document.getElementById('tableCaption').textContent = 'A little moment, just for you two.';
    await say('order');
    summary.textContent = 'Enjoy your time together. Leave whenever you’re ready.';
    orderBtn.hidden = true;
    billBtn.hidden = false;
  });
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
    await say('arrive');
    ready = true;
    orderBtn.disabled = !(picks.me && picks.her);
  } catch (e) {
    console.error(e);
    status.textContent = 'Load error: ' + e.message;
    TripLoader.fail('Load error: ' + e.message);
  }
})();
