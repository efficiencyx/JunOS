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
      ['\u{1F96A}', 'a club sandwich'], ['\u{1F35C}', 'a bowl of ramen'], ['\u{1F373}', 'omurice'],
      ['\u{1F35B}', 'a katsu curry'], ['\u{1F957}', 'a big salad'], ['\u{1F355}', 'a slice of pizza'],
      ['\u{1F9CA}', 'an iced coffee'], ['\u{1F34B}', 'a lemonade'],
    ],
    dinner: [
      ['\u{1F969}', 'a steak'], ['\u{1F35D}', 'pasta carbonara'], ['\u{1F363}', 'a sushi platter'],
      ['\u{1F35A}', 'mushroom risotto'], ['\u{1F41F}', 'grilled fish'], ['\u{1F377}', 'a glass of red wine'],
      ['\u{1F370}', 'tiramisu'], ['\u{1F9C1}', 'cheesecake'],
    ],
  };
  const meal = new Date().getHours() < 16 ? 'lunch' : 'dinner';
  const FALLBACK = {
    arrive: "Okay. It's nicer than I expected. Don't make it weird.",
    order: "...You ordered for me. Fine. Let's see if you were paying attention.",
    leave: 'Walk me home. And no, that was not a thank you.',
  };

  const picks = { me: '', her: '' };
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
    document.getElementById('menuTitle').textContent = meal === 'lunch' ? 'Lunch menu' : 'Dinner menu';
    document.getElementById('pageTitle').innerHTML = meal === 'lunch' ? 'Out to <b>lunch</b>' : 'Out to <b>dinner</b>';
    const her = window.Names ? Names.getBot() : 'Jun';
    for (const [emoji, name] of MENU[meal]) {
      const row = document.createElement('div');
      row.className = 'dish';
      const e = document.createElement('span'); e.className = 'dish-emoji'; e.textContent = emoji;
      const n = document.createElement('span'); n.className = 'dish-name'; n.textContent = name;
      row.append(e, n);
      for (const who of ['me', 'her']) {
        const b = document.createElement('button');
        b.textContent = who === 'me' ? 'for me' : 'for ' + her;
        b.dataset.who = who;
        b.dataset.name = name;
        b.addEventListener('click', () => pick(who, name));
        row.appendChild(b);
      }
      list.appendChild(row);
    }
  }

  function pick(who, name) {
    picks[who] = picks[who] === name ? '' : name;
    list.querySelectorAll(`button[data-who="${who}"]`).forEach(b => b.classList.toggle('on', b.dataset.name === picks[who]));
    const her = window.Names ? Names.getBot() : 'Jun';
    summary.textContent = [picks.me && `you: ${picks.me}`, picks.her && `${her}: ${picks.her}`].filter(Boolean).join(' · ');
    orderBtn.disabled = !(picks.me && picks.her);
  }

  async function goHome() {
    billBtn.disabled = true;
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
    orderBtn.disabled = true;
    list.querySelectorAll('button').forEach(b => { b.disabled = true; });
    await say('order');
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
    TripLoader.setStage(meal === 'lunch' ? 'Lunch, finally' : 'Table for two');
    await TripLoader.finish();
    status.textContent = '';
    await say('arrive');
  } catch (e) {
    console.error(e);
    status.textContent = 'Load error: ' + e.message;
    TripLoader.fail('Load error: ' + e.message);
  }
})();
