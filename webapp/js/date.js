// the date page. same skeleton as wardrobe.js, but her lines come
// from the model: every turn is one ephemeral turn (nothing
// stored, gauges still move) carrying an OOC stage direction, and
// the reply goes through say() in core/speech-card.js. the trip
// endpoint writes the memory note on the way home, the turns
// themselves leave nothing behind.
//
// she orders for herself. Anon taps his own dish on the card, hers
// comes out of her reply as an ORDER: tag (SUGGEST: is her
// proposing one for him). there is no button that picks for her.

import * as Auth from './core/auth.js?v=1';
import { api, apiJson } from './core/api.js?v=1';
import * as ChatAPI from './core/chat-api.js?v=2';
import * as Names from './core/names.js?v=1';
import * as Prefs from './core/prefs.js?v=1';
import { say } from './core/speech-card.js?v=5';
import { localTimeString, mealNow } from './core/util.js?v=1';
import * as Live2D from './live2d/live2d.js?v=76';
import * as Outfit from './outfit/outfit.js?v=76';
import * as Scene from './trip/scene.js?v=1';
import { startSkybox } from './trip/skybox.js?v=2';
import * as TripLoader from './trip/trip-loader.js?v=1';

async function main() {
  startSkybox();
  const status = document.getElementById('stageStatus');
  const list = document.getElementById('menuList');
  const input = document.getElementById('sayInput');
  const sendBtn = document.getElementById('sendBtn');
  const orderBtn = document.getElementById('orderBtn');
  const billBtn = document.getElementById('billBtn');
  const lastLine = document.getElementById('lastLine');
  const skipBtn = document.getElementById('skipBtn');
  const ticket = document.getElementById('kitchen');
  const ticketText = document.getElementById('kitchenText');

  // first column is the dish's drawing in scene/table.svg
  // (#fd-<key>), last is seconds in the kitchen. the wait is the slower
  // of the two plates, so two drinks is half a minute and a steak
  // next to a risotto is ~4 min of having to actually talk
  const MENU = {
    lunch: [
      ['club', 'a club sandwich', 'The club sandwich', 'From the kitchen', 100],
      ['ramen', 'a bowl of ramen', 'Ramen', 'From the kitchen', 140],
      ['omurice', 'omurice', 'Omurice', 'From the kitchen', 130],
      ['curry', 'a katsu curry', 'Katsu curry', 'From the kitchen', 160],
      ['salad', 'a big salad', 'Garden salad', 'From the kitchen', 80],
      ['pizza', 'a slice of pizza', 'Pizza by the slice', 'From the kitchen', 90],
      ['coffee', 'an iced coffee', 'Iced coffee', 'Something to sip', 30],
      ['lemonade', 'a lemonade', 'Cloudy lemonade', 'Something to sip', 30],
    ],
    dinner: [
      ['steak', 'a steak', 'Steak frites', 'The main affair', 220],
      ['carbonara', 'pasta carbonara', 'Carbonara', 'The main affair', 160],
      ['sushi', 'a sushi platter', 'Sushi selection', 'The main affair', 190],
      ['risotto', 'mushroom risotto', 'Mushroom risotto', 'The main affair', 230],
      ['fish', 'grilled fish', 'Grilled fish', 'The main affair', 200],
      ['wine', 'a glass of red wine', 'House red', 'By the glass', 30],
      ['tiramisu', 'tiramisu', 'Tiramisu', 'A sweet ending', 70],
      ['cheesecake', 'cheesecake', 'Cheesecake', 'A sweet ending', 70],
    ],
  };
  // three rooms, and which one you walk into is seeded off the
  // trip's start timestamp. same date keeps the same restaurant
  // across a refresh, because a reload mid-meal that teleports you
  // somewhere else is worse than never varying at all. next date
  // is somewhere new.
  const VENUES = [
    { name: 'Trattoria La Lanterna', scene: 'diner-lantern.svg' },
    { name: 'Café Marigold', scene: 'diner-marigold.svg' },
    { name: 'The counter on Vane Street', scene: 'diner-counter.svg' },
  ];
  let venue = VENUES[0];
  const meal = mealNow();
  const dishes = MENU[meal];
  document.body.dataset.meal = meal;
  const FALLBACK = {
    arrive: "Okay. It's nicer than I expected. Don't make it weird.",
    talk: "...Say that again. I was reading.",
    order: "Fine. Let's see if the kitchen is as good as the menu makes it sound.",
    lull: "...Are they growing it back there? Because it feels like they're growing it.",
    served: 'Oh. Okay. That actually looks good. Hands off mine.',
    leave: 'Walk me home. And no, that was not a thank you.',
  };

  const picks = { me: '', her: '' };
  let suggested = '';
  let mentioned = '';
  let ready = false;
  let ordered = false;
  let served = false;
  let busy = false;
  let canSkip = false;
  const kitchen = { start: 0, due: 0, lulls: 0, timer: 0 };
  let lastLineAt = 0;
  let history = [];
  let conversationId = 0;
  const her = () => Names.getBot();

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
    if (phase === 'arrive') return `${OOC}you and Anon just sat down at ${venue.name} for ${meal} and opened the menu. Say one or two lines out loud, in character, as you look around and at him. No narration. ${menuNote()})`;
    if (phase === 'talk') {
      if (ordered && !served) return `${OOC}you ordered (${picks.me} for Anon, ${picks.her} for you) and the two of you are waiting for the food to come out. Answer him out loud, in character, one to three lines. No narration.)`;
      if (ordered) return `${OOC}at the table eating, Anon has ${picks.me} and you have ${picks.her}. Answer him out loud, in character, one to three lines. No narration.)`;
      return `${OOC}reading the menu together. Answer him out loud, in character, one to three lines. No narration. ${menuNote()})`;
    }
    if (phase === 'waiter') {
      if (picks.her) return `${OOC}the waiter takes the order: ${picks.me} for Anon, ${picks.her} for you, your own pick. React out loud in one or two lines, in character. No narration.)`;
      return `${OOC}the waiter is at the table and Anon just ordered ${picks.me}. Tell him what you are having, ending your line with ORDER: <dish from the menu>. One or two lines, in character. No narration. ${menuNote()})`;
    }
    if (phase === 'lull') return `${OOC}still waiting for the food, the kitchen is taking its time and neither of you has said anything for a while. Break the silence out loud, in character, one or two lines: him, the place, the wait, whatever is on your mind. No narration.)`;
    if (phase === 'served') return `${OOC}the waiter just brought the food: ${picks.me} for Anon, ${picks.her} for you. React out loud in one or two lines, in character, as you dig in. No narration.)`;
    return `${OOC}the ${meal} is over, Anon asked for the bill and you two are getting up to walk home. Say one or two lines out loud, in character. No narration.)`;
  }

  function turn(content) {
    return new Promise((resolve) => {
      if (!conversationId) return resolve('');
      let text = '';
      history.push({ role: 'user', content });
      ChatAPI.chat(
        { messages: [...history], conversation_id: conversationId, ephemeral: true,
          client_time: localTimeString(), outfit_context: Outfit.describe() },
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
    line = Names.apply(line);
    line = line || fallback;
    status.textContent = '';
    lastLine.textContent = line;
    lastLineAt = Date.now();
    busy = false;
    renderMarks();
    return line;
  }

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
    skipBtn.hidden = !canSkip || !kitchen.timer || served;
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
    document.getElementById('menuNames').textContent = `${Names.getPlayer()} & ${h}`;
    document.getElementById('menuDate').textContent = `${meal === 'lunch' ? 'Lunch' : 'Dinner'} · ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}`;
    document.getElementById('menuPlace').textContent = venue.name;
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
    const dish = (who) => dishes.find(d => d[1] === picks[who]);
    const cook = Math.max(dish('me')[4], dish('her')[4]) * (0.85 + Math.random() * 0.3);
    kitchen.start = Date.now();
    kitchen.due = kitchen.start + cook * 1000;
    kitchen.timer = setInterval(tickKitchen, 1000);
    document.body.classList.add('ordered');
    orderBtn.hidden = true;
    ticket.hidden = false;
    tickKitchen();
    setComposer();
    await say(line);
  }

  // one clock for the whole wait. the food only lands between
  // turns, never on top of a reply that's still streaming, and if
  // he goes quiet she fills the silence. twice max, after that
  // it's his problem
  function tickKitchen() {
    if (served) return;
    const now = Date.now();
    const left = Math.max(0, kitchen.due - now);
    ticket.style.setProperty('--done', String(Math.min(1, (now - kitchen.start) / (kitchen.due - kitchen.start))));
    const text = left > 90e3 ? `The kitchen's on it · about ${Math.round(left / 60e3)} min`
      : left > 25e3 ? "The kitchen's on it · almost ready" : 'Coming out now';
    if (ticketText.textContent !== text) ticketText.textContent = text;
    if (busy || !ready) return;
    if (!left) { serve(); return; }
    if (kitchen.lulls < 2 && left > 20e3 && now - lastLineAt > 40e3 && !input.value.trim() && !document.hidden) {
      kitchen.lulls++;
      ask(note('lull'), FALLBACK.lull).then(say);
    }
  }

  async function serve() {
    served = true;
    clearInterval(kitchen.timer);
    for (const who of ['me', 'her']) {
      const food = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      food.setAttribute('href', '#fd-' + dishes.find(d => d[1] === picks[who])[0]);
      document.getElementById(who === 'me' ? 'plateMe' : 'plateHer').replaceChildren(food);
    }
    document.body.classList.add('served');
    ticket.hidden = true;
    billBtn.hidden = false;
    setComposer();
    say(await ask(note('served'), FALLBACK.served));
  }

  async function goHome() {
    if (busy) return;
    billBtn.disabled = true;
    billBtn.textContent = 'Heading home…';
    await say(await ask(note('leave'), FALLBACK.leave));
    try {
      await apiJson('trip.php?action=home', { meal, dishes: picks });
    } catch (e) {}
    location.href = 'index.html?from=date';
  }

  const me = await Auth.me().catch(() => null);
  if (!me) { location.replace('index.html'); return; }
  // she has to have agreed in chat. a dead endpoint (android has
  // none) counts as open, this is a story rule not a security one
  const trip = await api('trip.php')
    .then(r => r.ok ? r.json() : null).catch(() => null);
  if (trip && trip.gated && trip.where !== 'date') { location.replace('index.html'); return; }
  canSkip = me.user?.role === 'admin' || !!trip?.can_force;
  // mount AFTER the gate. otherwise a bounced user sits through the
  // whole walk just to get redirected at the end of it
  TripLoader.mount();
  TripLoader.setStage('Finding your table');
  // no trip row (gate off, or the android build that has no endpoint)
  // means no seed, so fall back to the day. at least it moves.
  const seed = (trip && Number(trip.since)) || Math.floor(Date.now() / 864e5);
  venue = VENUES[Math.abs(seed) % VENUES.length];
  document.body.dataset.venue = venue.scene.replace(/^diner-|\.svg$/g, '');
  Scene.inject('.room', 'scene/' + venue.scene + '?v=2');
  Scene.inject('.table', 'scene/table.svg?v=3');
  conversationId = trip ? Number(trip.conversation_id) || 0 : 0;

  await Prefs.pullFromServer();
  Names.load();
  Names.decorate();
  renderMenu();

  // the tail of the chat she agreed in, so the lines follow on
  // from it instead of starting cold. <audio> rows are a
  // placeholder, not words
  if (conversationId) {
    try {
      const rows = await api(`conversations.php?action=messages&id=${conversationId}`)
        .then(r => r.ok ? r.json() : []);
      history = rows.filter(r => r.content !== '<audio>').slice(-20).map(r => ({ role: r.role, content: r.content }));
    } catch (e) {}
  }

  document.getElementById('composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy || !ready) return;
    input.value = '';
    const spoken = Names.canonicalize(text);
    say(await ask(`${spoken}\n\n${note('talk')}`, FALLBACK.talk));
    input.focus();
  });
  orderBtn.addEventListener('click', callWaiter);
  billBtn.addEventListener('click', goHome);
  skipBtn.addEventListener('click', () => {
    kitchen.due = Date.now();
    tickKitchen();
  });

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
    say(await ask(note('arrive'), FALLBACK.arrive));
  } catch (e) {
    console.error(e);
    status.textContent = 'Load error: ' + e.message;
    TripLoader.fail('Load error: ' + e.message);
  }
}

main();
