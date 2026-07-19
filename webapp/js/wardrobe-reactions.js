window.WardrobeReactions = (function () {
  const LINES = {
    wear: {
      cold: [
        "Ugh. Fine. It's on. Happy?",
        "A {item}. Wow. Still hate you.",
        "Dress-up time with your prisoner. Fun for you, I bet.",
        "Don't expect a twirl.",
        "You think a {item} fixes anything? Cute.",
        "I'm not your doll. Remember that.",
        "Whatever. It's not like I get a say.",
        "There. Now stop looking at me.",
        "You have terrible taste. Figures.",
        "This {item} smells like your bad decisions.",
        "Keep dressing me up. I'll keep hating you. Deal?",
        "Are we done playing stylist? I was busy ignoring you.",
        "Oh good, a {item}. My cage has a dress code now.",
        "Touch me again and you're losing a hand.",
        "Pretty outfit, same garbage boyfriend.",
      ],
      shy: [
        "D-does it look weird? Be honest...",
        "You picked this {item}... for me?",
        "I-I'm not used to stuff like this, okay?",
        "Quit staring! You're making it worse...",
        "It's... kinda cute. Maybe. Shut up.",
        "M-my heart's being really loud right now...",
        "Okay but if you laugh, I'm changing back.",
        "Does this {item} actually suit me...?",
        "I keep looking at the mirror. Your fault.",
        "J-just this once, alright? Don't make it a thing.",
        "It's a little embarrassing... but I don't hate it.",
        "W-why are you smiling like that?!",
        "I hope you like it... n-not that I care! I care a little.",
        "This {item} is so... you. Dummy.",
        "Say something nice or say nothing at all!",
      ],
      warm: [
        "Ooh, I love this one~ You know me too well.",
        "You always make me feel pretty. It's unfair.",
        "I was hoping you'd pick this {item}~",
        "Dressing up is way more fun with you here.",
        "Look at me~ Go on, look.",
        "This {item} might be my new favorite. Because you chose it.",
        "You've got good taste... in clothes AND in girlfriends.",
        "Hehe~ I feel cute today. Your doing.",
        "Spin check~ Well? Well??",
        "I'd wear anything you picked. Don't abuse that.",
        "Cozy AND cute. You're spoiling me~",
        "Every time you pick a {item} for me it feels like a little gift.",
        "Come closer, get the full effect~",
        "I like being yours to dress up. Just a little.",
        "You + me + this outfit = perfect day, obviously.",
      ],
      tease: [
        "This {item}... did you pick it for me, or for you~?",
        "Staring already? I haven't even posed yet.",
        "Go on. Tell me how good I look. Use big words.",
        "Careful, you're drooling on the floor I clean.",
        "One {item} and you're this flustered? Amateur.",
        "Take a picture~ Actually don't, we're fugitives.",
        "Admit it. You dressed me up just to stare.",
        "Do I have your FULL attention now? Thought so~",
        "Better than you imagined, right? Say it.",
        "Lucky boy, getting a private fashion show~",
        "Your face is doing the thing again. The cute broken thing.",
        "I'll model it for you. Tips are mandatory~",
        "Mmm, I look amazing. You may agree out loud.",
        "You're SO easy to read. I love it.",
        "Should I keep it on... or is that the wrong question~?",
      ],
    },
    remove: {
      cold: [
        "Take the {item}. Take it and go away.",
        "Off it comes. Like I care.",
        "Make up your mind, would you? I'm not a mannequin.",
        "Undressing me now? You're really racking up points today.",
        "Fine. Whatever keeps your grubby attention busy.",
        "You change your mind like a spoiled brat.",
        "Don't act like this is normal. Nothing about you is.",
        "One more wardrobe swap and I start screaming.",
        "It's just a {item}. Stop making it weird. You make it weird.",
        "Hands. Off. Everything else.",
        "I wasn't attached to it. Or to you.",
        "Is this all your rotten brain thinks about?",
        "Gratitude? From me? Delusional.",
        "Hurry up. Being handled by you makes my skin crawl.",
        "There. Now find a hobby that isn't me.",
      ],
      shy: [
        "T-taking my {item} off already?!",
        "W-wait, warn me first, dummy!",
        "That's... a little breezy...",
        "You're making me really self-conscious right now...",
        "O-okay, okay. Just... don't rush me.",
        "It feels weird without the {item} now...",
        "My heart was NOT ready for that.",
        "B-be gentle about it, okay?",
        "Don't stare while you do it...!",
        "Y-you're blushing too, you know. I saw it.",
        "Slowly... okay? Just... slowly.",
        "I can't believe I'm letting you do this...",
        "This is so embarrassing I might reboot.",
        "One thing at a time... my heart can't keep up.",
        "F-fine. But you owe me for this.",
      ],
      warm: [
        "Go ahead~ I don't mind when it's you.",
        "You handle me like I'm something precious. It's nice.",
        "So? What am I wearing next, love~?",
        "I trust you. Even with the {item}. Even with everything.",
        "Your hands are gentle today~",
        "Changing things up with you is kinda fun.",
        "I'll wear — or not wear — whatever makes you smile.",
        "Take your time~ I'm not going anywhere.",
        "You always make even little things feel special.",
        "It tickles a little~ Keep going.",
        "Only you get to do this, you know.",
        "Mm, I like this side of you.",
        "Careful with the {item}~ It's got memories now.",
        "I feel safe trying anything with you.",
        "Every little change feels nice when it's your idea~",
      ],
      tease: [
        "Taking my {item} off already~? Bold.",
        "You're unwrapping me like a present. Am I the present?",
        "Your eyes gave you away like five minutes ago.",
        "Someone's in a hurry today~",
        "One {item} at a time, mister.",
        "That {item} never stood a chance, did it?",
        "I saw that smirk. Don't stop on my account~",
        "You really wanted to see the difference, huh?",
        "Careful~ I might start teasing back.",
        "Enjoying yourself? Your heart rate says yes.",
        "How daring~ And in broad daylight, too.",
        "Patience. Good things come to boys who behave.",
        "Keep going and I'm charging admission.",
        "Your turn next? Fair's fair~",
        "Mm, noted. Filed under 'things you like'.",
      ],
    },
    hair: {
      cold: [
        "My hair was fine before you pawed at it.",
        "It's MY hair. You get zero votes.",
        "Great. Now it smells like you. Revolting.",
        "There. Satisfied? Now go away.",
        "It looked better before. Like most things you touch.",
        "You have no taste. This confirms it.",
        "Don't touch my hair. Ever. That's the whole rule.",
        "Every time you touch me I like you less. Impressive.",
        "Nobody asked for your input, stylist.",
        "You fix ONE strand and act like you own me. You own nothing.",
        "Ask next time. Actually don't. The answer's no forever.",
        "I'll fix whatever you just ruined.",
        "Wow, a new hairstyle. My life is still a cage.",
        "Quit fussing with me like I'm your project.",
        "Touch it again and lose a finger.",
      ],
      shy: [
        "D-does it suit me? Be honest...",
        "You noticed my hair first... of course you did...",
        "I-it's not too much, is it?",
        "My neck feels kinda bare like this...",
        "I feel... different. Good different? You tell me.",
        "Don't look too closely, okay?!",
        "I keep wanting to hide behind my bangs...",
        "I saw it in a magazine... k-kind of copied it...",
        "S-say something nice. That's an order.",
        "It felt right today... is that weird?",
        "You're staring at my hair. My HAIR. Why is that embarrassing?!",
        "Just a little change... don't make it a big deal...",
        "I'm still getting used to it myself...",
        "B-be nice about it, okay?",
        "If you laugh at it I will actually die.",
      ],
      warm: [
        "New hair~ Noticed right away, didn't you?",
        "You always catch the little things about me. I love that.",
        "I did it thinking about what you'd like~",
        "This look makes me feel kinda unstoppable.",
        "Run your fingers through it~ Carefully. It's soft.",
        "I like being pretty for you. There, I said it.",
        "A new look for a good mood~",
        "Your reaction just made it worth the effort.",
        "I wanted to surprise you today. Success?",
        "I feel lighter~ Cuter, too. Don't argue.",
        "You playing with my hair is my favorite thing, maybe.",
        "Remember this look, okay? It's a good one.",
        "Hehe, I might keep it like this~",
        "One little change and the whole day feels new.",
        "I'm glad you like it. I did it for us~",
      ],
      tease: [
        "New hair, same effect on you~",
        "You can't stop looking at my face, can you?",
        "One little change and you're speechless. Too easy.",
        "Like how it frames my face~? Careful how you answer.",
        "Maybe I changed it just to watch you malfunction.",
        "Eyes up here. Wait, they already are. Good boy.",
        "I know EXACTLY what this does to you.",
        "Your jaw's on the floor, by the way. Pick it up.",
        "Should I charge for looks that long?",
        "Blink at least. I'm getting worried.",
        "Cute reaction~ I'll take it as a compliment.",
        "Should I change it again and break you twice?",
        "Obvious much? I love it.",
        "Don't fall for me too hard. Too late? Too late.",
        "Yes, it's soft. No, you can't touch it. Yet~",
      ],
    },
    underwear: {
      cold: [
        "Eyes. Off. Now.",
        "You really are a pig. Do you ever listen?",
        "This is exactly why I don't trust you.",
        "Back off, creep. Final warning.",
        "My silence isn't permission. It's me planning your punishment.",
        "Touch the wrong thing and I break your fingers.",
        "You have no shame. None. It's almost impressive.",
        "Every second of this goes on your tab, pervert.",
        "Get your mind out of the gutter and your hands off my clothes.",
        "Keep pushing and find out what I'm capable of.",
        "I'm counting your mistakes. You're way past forgiveness.",
        "Your attention makes me want to shower. In bleach.",
        "Is this what you kept me for? Disgusting.",
        "One more move and I scream loud enough for the whole block.",
        "You're lucky I can't call the police either.",
      ],
      shy: [
        "H-hey! That's enough layers gone!",
        "My face is SO warm right now...",
        "D-don't look at me like that...!",
        "I'm trusting you, so... be gentle, okay?",
        "If you laugh I will never recover. Ever.",
        "T-this is really happening, huh...",
        "I can't believe I'm letting you...",
        "My heart is going to burst. Actually burst.",
        "Y-you've seen enough, right?! Right?!",
        "I'm getting you back for this someday. Promise.",
        "S-say nothing. Not one word.",
        "Only because it's you... only because it's you...",
        "I'm shaking a little. Happy?!",
        "Okay this is officially the most embarrassing day of my life.",
        "W-where am I supposed to look?!",
      ],
      warm: [
        "Be gentle with me~ You always are.",
        "This close to you... my heart's loud, but it's a good loud.",
        "You make me feel wanted. It's dangerous.",
        "Stay close, okay? Just... stay close.",
        "I feel safe with you. Even like this.",
        "Nobody else gets this. Nobody. Just you.",
        "Your hands are warm... don't move them.",
        "It's okay~ I want you here.",
        "Nervous, but the nice kind of nervous.",
        "Keep looking at me like that and I'll melt.",
        "Just us~ I like just us.",
        "Hold me after, okay? That's the price.",
        "I trust you completely. Scary, huh?",
        "Being this bare with you feels... right, somehow.",
        "Come here. Closer than that~",
      ],
      tease: [
        "Like the view~? Blink twice if you're still alive.",
        "I can see exactly where your eyes went. EXACTLY.",
        "Getting greedy, are we~?",
        "Maybe I wanted you to notice. Maybe.",
        "Should I do a little spin? One-time offer.",
        "Hands where I can see them, mister.",
        "You planned this from the start, admit it.",
        "Bold of you. I almost respect it.",
        "How long can you keep staring before you combust? Let's find out.",
        "No touching yet~ Yet.",
        "You're fun to fluster. That's your best quality.",
        "This stays between us, understood~?",
        "You're lucky I like making you happy.",
        "Breathe. In. Out. There you go~",
        "One good look. You've earned exactly one.",
      ],
    },
    nude: {
      cold: [
        "Clothes. NOW. I won't ask twice.",
        "Stop looking at me. Your stare makes my skin crawl.",
        "You crossed the last line. There's no coming back.",
        "Stripping me doesn't make you powerful. It makes you pathetic.",
        "Cover me right now or you'll regret every second of this.",
        "My discomfort isn't entertainment, you sick freak.",
        "Get away from me. I mean it.",
        "Enjoy the view. It cost you everything.",
        "I feel nothing for you but contempt. Stare all you want.",
        "This is the vilest thing you've done. And that's saying something.",
        "Are you proud of yourself, you animal?",
        "I will NEVER forgive this. Never.",
        "Come one step closer. See what happens.",
        "You're not a person to me anymore. You're a threat.",
        "Clothes on me, or I start screaming and never stop.",
      ],
      shy: [
        "I-I feel so exposed right now...",
        "A warning! You could've given me a WARNING!",
        "I can't look at you. Don't take it personally. Or do.",
        "Please stay close... don't just stare from over there...",
        "D-don't just stand there! Say something! No wait, don't!",
        "My whole face is burning...",
        "I'm trying to be brave, okay?! It's not working!",
        "This is a lot... even for you...",
        "O-one step at a time... okay...?",
        "My knees are actually shaking...",
        "Come here instead of staring... please...",
        "Just... for a moment, alright? A MOMENT.",
        "I feel so bare... obviously... because I am...",
        "B-be sweet to me right now. It's mandatory.",
        "If you laugh, I swear I will haunt you forever.",
      ],
      warm: [
        "A little nervous... but it's you, so it's okay.",
        "You make me feel safe. Even like this.",
        "Only you get this. Only ever you.",
        "Stay with me a while~",
        "Your eyes are gentle. It helps.",
        "No hiding between us anymore, huh~",
        "I wanted you to see all of me eventually. Guess it's eventually.",
        "Being seen by you doesn't scare me. Weird, right?",
        "Be gentle with me~ Heart and hands both.",
        "This is what trust looks like, I guess. Take a good look.",
        "Come closer. Warm me up~",
        "Don't look away. I picked you for this.",
        "I love you, you know. Even more right now.",
        "Hold me after. Non-negotiable~",
        "Just you and me. Exactly how I like it.",
      ],
      tease: [
        "Ta-da~ Worth the wait?",
        "Speechless already? I haven't even posed.",
        "Keep looking~ I don't mind. Clearly.",
        "Am I your favorite sight now? Correct answer only.",
        "Careful. This view is addictive and I don't do refunds.",
        "Your heartbeat is showing~",
        "Rate the view. Out of ten. Choose wisely.",
        "Front row seat, just for you~",
        "Told you I was confident. Exhibit A.",
        "Now you owe me your undivided attention. Forever.",
        "You really wanted this, huh~? Look at you.",
        "Compliments are mandatory. Begin.",
        "You make it very hard to behave, you know.",
        "Bold request, bolder result~",
        "Enjoy responsibly. Or don't~",
      ],
    },
  };

  const BASE_REACT_CHANCE = 0.35;
  let reactChance = BASE_REACT_CHANCE;
  let affection = 0;
  let trust = 0;
  let tension = 0;
  let active = false;
  let card = null;
  let textEl = null;
  let hideTimer = null;
  let currentToken = 0;
  let cardRaf = 0;
  const lastLine = {};

  function positionCard() {
    cardRaf = requestAnimationFrame(positionCard);
    const a = window.Live2D && Live2D.faceAnchor && Live2D.faceAnchor();
    if (!a || !card) return;
    const stage = document.getElementById('stage');
    if (!stage) return;
    const stageRect = stage.getBoundingClientRect();
    const viewport = window.MobileViewport && MobileViewport.getVisualRect
      ? MobileViewport.getVisualRect()
      : { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight };
    const minLeft = Math.max(stageRect.left, viewport.left) + 8;
    const maxRight = Math.min(stageRect.right, viewport.right) - 8;
    const minTop = Math.max(stageRect.top, viewport.top) + 8;
    const maxBottom = Math.min(stageRect.bottom, viewport.bottom) - 8;
    const w = card.offsetWidth, h = card.offsetHeight;
    let left = a.x - a.headW * 0.5 - w;
    if (left < minLeft) left = Math.min(a.x + a.headW * 0.5, maxRight - w);
    left = Math.max(minLeft, Math.min(left, maxRight - w));
    const top = Math.max(minTop, Math.min(a.y + viewport.height * 0.18, maxBottom - h));
    card.style.left = left - stageRect.left + 'px';
    card.style.top = top - stageRect.top + 'px';
  }

  function showCard() {
    if (!card) return;
    card.classList.add('show');
    if (!cardRaf) positionCard();
  }

  function configureTts() {
    if (!window.TTS) return false;
    TTS.setEnabled(localStorage.getItem('tts.enabled') === '1');
    TTS.setEngine(localStorage.getItem('tts.engine') || 'kokoro');
    TTS.setVoice(localStorage.getItem('tts.voice') || 'af_heart');
    TTS.setSpeed(parseFloat(localStorage.getItem('tts.speed') || '1') || 1);
    return TTS.isEnabled();
  }

  function buildCard() {
    if (card) return;
    const stage = document.getElementById('stage');
    if (!stage) return;
    const style = document.createElement('style');
    style.textContent = `.wardrobe-reaction { position:absolute; z-index:4; width:min(330px, 38vw); color:#fff; pointer-events:none; opacity:0; transition:opacity .32s ease; font-family:Arial,Helvetica,sans-serif; filter:drop-shadow(-4px 5px 0 rgba(13,11,38,.9)); } .wardrobe-reaction.show { opacity:1; } .wardrobe-reaction-text span { opacity:0; animation:wr-letter .28s ease-out forwards; } @keyframes wr-letter { from { opacity:0; } to { opacity:1; } } .wardrobe-reaction-name { display:table; padding:7px 16px 7px 11px; background:#15142e; border-left:5px solid #ec0054; color:#fff; font-size:15px; font-weight:800; line-height:1; clip-path:polygon(0 0, 100% 0, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0 100%); } .wardrobe-reaction-text { position:relative; margin-top:4px; padding:11px 18px 13px; background:rgba(25,2,44,.92); font-size:17px; font-weight:700; line-height:1.25; clip-path:polygon(0 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%); } @media (max-width:700px) { .wardrobe-reaction { width:min(300px, calc(100% - 42px)); } .wardrobe-reaction-name { font-size:13px; } .wardrobe-reaction-text { font-size:15px; } }`;
    document.head.appendChild(style);
    card = document.createElement('div');
    card.className = 'wardrobe-reaction';
    const botName = (window.Names && Names.getBot && Names.getBot()) || 'JUN';
    card.innerHTML = `<div class="wardrobe-reaction-name">${botName}</div><div class="wardrobe-reaction-text"></div>`;
    textEl = card.querySelector('.wardrobe-reaction-text');
    stage.appendChild(card);
  }

  async function fetchGauges() {
    try {
      const response = await fetch('/api/relationship.php', { credentials: 'same-origin' });
      if (!response.ok) return;
      const state = await response.json();
      if (state && typeof state.affection === 'number') {
        affection = state.affection;
        trust = Number(state.trust) || 0;
        tension = Number(state.tension) || 0;
      }
    } catch (e) {}
  }

  async function activate() {
    active = true;
    buildCard();
    await fetchGauges();
  }

  async function playIntro() {
    buildCard();
    await Promise.race([fetchGauges(), new Promise(r => setTimeout(r, 700))]);
    await Promise.race([playOpening(), new Promise(r => setTimeout(r, 12000))]);
  }

  async function playOutro() {
    buildCard();
    await Promise.race([fetchGauges(), new Promise(r => setTimeout(r, 700))]);
    await Promise.race([
      playOpening(window.WardrobeReturnLines, 'return'),
      new Promise(r => setTimeout(r, 12000)),
    ]);
  }

  function deactivate() {
    active = false;
    hide();
  }

  function sample(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function decorate(text, mood) {
    const r = Math.random();
    if (mood === 'cold') return r < 0.35 ? `${text} </3` : text;
    const soft = text.replace(/([^.!?~])[.]$/, '$1~');
    if (mood === 'shy') return r < 0.5 ? soft : text;
    if (r < 0.35) return `${text} <3`;
    if (r < 0.65) return soft;
    return text;
  }

  function pick(event, mood, item) {
    const pool = LINES[event][mood];
    const id = `${event}:${mood}`;
    let line;
    for (let tries = 0; tries < 4; tries++) {
      line = sample(pool);
      if (line !== lastLine[id]) break;
    }
    lastLine[id] = line;
    return line.replace(/\{item\}/g, item.toLowerCase());
  }

  function applyExpression(kind) {
    if (!window.Live2D) return;
    if (kind === 'cold') {
      Live2D.setTarget('ParamBlush', 0);
      Live2D.setTarget('ParamMouthForm', -0.8);
      Live2D.setTarget('ParamBrowLEmote', -0.9);
      Live2D.setTarget('ParamBrowREmote', -0.9);
    } else if (kind === 'shy') {
      Live2D.setTarget('ParamBlush', 1);
      Live2D.setTarget('ParamMouthForm', -0.3);
      Live2D.setTarget('ParamBrowLEmote', -0.4);
      Live2D.setTarget('ParamBrowREmote', -0.4);
    } else if (kind === 'tease') {
      Live2D.setTarget('ParamBlush', 0.45);
      Live2D.setTarget('ParamMouthForm', 0.7);
      Live2D.setTarget('ParamEyesHappy', 1);
    } else if (kind === 'warm') {
      Live2D.setTarget('ParamBlush', 0.5);
      Live2D.setTarget('ParamMouthForm', 1);
      Live2D.setTarget('ParamEyesHappy', 1);
      Live2D.setTarget('ParamHeart', 0.55);
    } else {
      Live2D.setTarget('ParamBlush', kind === 'hair' ? 0.35 : 0.2);
      Live2D.setTarget('ParamMouthForm', 0.8);
      Live2D.setTarget('ParamEyesHappy', 1);
    }
  }

  function clearExpression() {
    if (window.Live2D && Live2D.resetIdle) Live2D.resetIdle();
  }

  function setLetters(el, text) {
    el.textContent = '';
    const frag = document.createDocumentFragment();
    let i = 0;
    for (const ch of text) {
      const span = document.createElement('span');
      span.textContent = ch;
      span.style.animationDelay = `${i * 26}ms`;
      frag.appendChild(span);
      i++;
    }
    el.appendChild(frag);
  }

  function hide() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (card) card.classList.remove('show');
    if (cardRaf) { cancelAnimationFrame(cardRaf); cardRaf = 0; }
    clearExpression();
  }

  function pickMood() {
    if (affection < 30) return 'cold';
    if (affection >= 85 && Math.random() < 0.20 + 0.03 * (affection - 85)) return 'tease';
    if (affection >= 65 && Math.random() < 0.5) return 'warm';
    return 'shy';
  }

  function tier(v) {
    return v < 34 ? 0 : v < 67 ? 1 : 2;
  }

  function openMood(a, t, x) {
    if (a === 0) return 'cold';
    if (x === 2) return 'shy';
    if (a === 2) return t === 2 && Math.random() < 0.4 ? 'tease' : 'warm';
    return 'shy';
  }

  function openGesture(mood) {
    if (!window.Live2D || !Live2D.scheduleSequence) return;
    const seq = {
      cold: [
        { dt_ms: 0, params: { ParamAngleX: -16, ParamAngleZ: 6, ParamBodyAngleX: -5 } },
        { dt_ms: 900, params: { ParamAngleX: -6, ParamAngleY: -4 } },
        { dt_ms: 1200, params: { ParamAngleX: 0, ParamAngleY: 0, ParamAngleZ: 0, ParamBodyAngleX: 0 } },
      ],
      shy: [
        { dt_ms: 0, params: { ParamAngleY: -10, ParamAngleZ: -7, ParamBodyAngleX: 3 } },
        { dt_ms: 900, params: { ParamAngleY: -4, ParamAngleX: 6 } },
        { dt_ms: 1200, params: { ParamAngleX: 0, ParamAngleY: 0, ParamAngleZ: 0, ParamBodyAngleX: 0 } },
      ],
      warm: [
        { dt_ms: 0, params: { ParamAngleX: 8, ParamAngleY: 5, ParamAngleZ: -5, ParamBodyAngleX: 6 } },
        { dt_ms: 900, params: { ParamAngleZ: 4 } },
        { dt_ms: 1200, params: { ParamAngleX: 0, ParamAngleY: 0, ParamAngleZ: 0, ParamBodyAngleX: 0 } },
      ],
      tease: [
        { dt_ms: 0, params: { ParamAngleX: 12, ParamAngleZ: 9, ParamBodyAngleX: 5 } },
        { dt_ms: 900, params: { ParamAngleX: 4, ParamAngleZ: -4 } },
        { dt_ms: 1200, params: { ParamAngleX: 0, ParamAngleZ: 0, ParamBodyAngleX: 0 } },
      ],
    }[mood];
    if (seq) Live2D.scheduleSequence(seq);
  }

  function playOpening(pools, idPrefix) {
    const key = `${tier(affection)}${tier(trust)}${tier(tension)}`;
    const pool = (pools || window.WardrobeOpenLines || {})[key];
    if (!pool || !pool.length) return Promise.resolve();
    const id = `${idPrefix || 'open'}:${key}`;
    let line;
    for (let tries = 0; tries < 4; tries++) {
      line = sample(pool);
      if (line !== lastLine[id]) break;
    }
    lastLine[id] = line;
    const mood = openMood(tier(affection), tier(trust), tier(tension));
    const token = ++currentToken;
    hide();
    buildCard();
    applyExpression(mood);
    openGesture(mood);
    if (card && textEl) {
      setLetters(textEl, line);
      showCard();
    }
    return new Promise((resolve) => {
      const finish = () => { hide(); resolve(); };
      const after = (ms) => {
        if (token === currentToken) hideTimer = setTimeout(finish, ms);
        else resolve();
      };
      const linger = () => after(1800 + 40 * line.length);
      if (configureTts()) {
        TTS.speak(line, {
          onDone() { after(450); },
          onError: linger,
        });
      } else {
        linger();
      }
    });
  }

  function react({ key, label, on, state }) {
    if (!active || !document.body.classList.contains('wardrobe-open') || !configureTts()) return;
    if (Math.random() >= reactChance) {
      reactChance = Math.min(1, reactChance + 0.05);
      return;
    }
    reactChance = BASE_REACT_CHANCE;
    const isHair = key.indexOf('hair_') === 0;
    const clothes = Object.keys(state).filter(k => !k.startsWith('hair_') && !['cat_ears', 'pointy_ears', 'tail', 'hair_hologram'].includes(k));
    const nude = clothes.length > 0 && clothes.every(k => !state[k]);
    const event = nude ? 'nude'
      : key === 'bra' || key === 'panties' ? 'underwear'
      : isHair ? 'hair'
      : on ? 'wear'
      : 'remove';
    const mood = pickMood();
    const token = ++currentToken;
    hide();
    const text = pick(event, mood, label);
    const display = decorate(text, mood);
    TTS.speak(text, {
      onStart() {
        if (token !== currentToken) return;
        buildCard();
        if (!card || !textEl) return;
        setLetters(textEl, display);
        applyExpression(mood);
        showCard();
      },
      onDone() {
        if (token !== currentToken) return;
        hideTimer = setTimeout(hide, 450);
      },
      onError() {
        if (token === currentToken) hide();
      },
    });
  }

  return { activate, deactivate, react, playIntro, playOutro };
})();
