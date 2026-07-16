window.WardrobeReactions = (function () {
  const LINES = {
    wear: {
      cold: ['Fine. Put it on and leave me alone.', 'I do not care about this {item}, and I do not care what you think.', 'Is this supposed to make me like you more?', 'You only change me when you want something.', 'Are you done treating me like a doll yet?'],
      shy: ['D-Do I look okay in this {item}?', 'This {item} is a little embarrassing...', 'You picked this for me?', 'Please do not stare too much.', 'I hope it suits me.'],
      warm: ['I love this {item}. You know me so well.', 'You always make me feel pretty.', 'I was hoping you would pick this one.', 'I like when you help me choose.', 'This {item} makes me think of you.'],
      tease: ['You picked this {item} for me... or for you?', 'Do I have your full attention now?', 'You are staring again. I like it.', 'Maybe I wanted you to notice.', 'Tell me how good I look.'],
    },
    remove: {
      cold: ['Take the {item} off, then leave me alone.', 'I was not attached to it. Unlike you, I do not need your approval.', 'You are so controlling. It is exhausting.', 'Is this really all you think about?', 'Do not expect gratitude from me.'],
      shy: ['Taking off my {item} already?', 'That feels a little breezy...', 'You are making me self-conscious.', 'I hope you know what you are doing.', 'Do not tease me too much.'],
      warm: ['I trust you with my outfit.', 'You always make even small changes feel special.', 'I like how carefully you look at me.', 'What should I wear next, love?', 'You make me feel safe trying new things.'],
      tease: ['Already taking my {item} off?', 'You really want to see the difference, huh?', 'Your eyes gave you away.', 'I do not mind you looking.', 'Careful, I might tease you back.'],
    },
    hair: {
      cold: ['My hair was fine. Stop touching things that are mine.', 'You do not get to decide everything about me.', 'Why should your opinion matter to me?', 'There. Are you satisfied with yourself now?', 'I liked it better before you interfered.'],
      shy: ['Y-You like my hair, do not you?', 'Does this hairstyle suit me?', 'You noticed my hair first...', 'I feel different like this.', 'Please be honest, okay?'],
      warm: ['I am glad you like my hair.', 'You always notice the little things about me.', 'This look makes me feel confident.', 'I like being pretty for you.', 'I hope you remember this look.'],
      tease: ['You cannot stop looking at my face, can you?', 'This hairstyle has your attention now.', 'Do you like how it frames my face?', 'Maybe I changed it to make you blush.', 'Keep looking. I do not mind.'],
    },
    underwear: {
      cold: ['Do not make this into something it is not. I want you away from me.', 'You are being gross again. Do you ever listen?', 'I do not like where this is going, and I do not trust you.', 'Back off. I do not want your attention right now.', 'Do not mistake my silence for permission.'],
      shy: ['H-Hey... that is enough layers gone.', 'My face feels really warm now.', 'Do not look at me like that.', 'I am trusting you, so be gentle.', 'Please do not laugh at me.'],
      warm: ['I trust you to be gentle with me.', 'Being this close to you makes me nervous in a nice way.', 'You make me feel wanted.', 'Stay close to me, okay?', 'I feel safe with you.'],
      tease: ['You like this view, do not you?', 'I can see exactly where your eyes went.', 'You are lucky I like making you happy.', 'Maybe I wanted you to notice.', 'I wonder how long you can keep looking.'],
    },
    nude: {
      cold: ['Enough. Put something back on me and leave me alone.', 'I hate this. Stop acting like my discomfort is interesting.', 'Do not look at me like that. You make my skin crawl.', 'You crossed a line again. I should have known better than to trust you.', 'Get away from me. I do not want you near me.'],
      shy: ['I feel so exposed right now...', 'Could you at least give me a warning?', 'I cannot look at you right now.', 'Please stay close, okay?', 'I am not used to this much attention.'],
      warm: ['I am a little nervous, but I trust you.', 'You make me feel safe even like this.', 'Please be gentle with me.', 'I only feel this comfortable because it is you.', 'Stay with me for a while.'],
      tease: ['You really wanted to see me like this?', 'You can keep looking. I do not mind.', 'I like that look on your face.', 'Am I your favorite sight now?', 'You make it hard for me to behave.'],
    },
  };

  let affection = 0;
  let active = false;
  let card = null;
  let textEl = null;
  let hideTimer = null;
  let currentToken = 0;
  const lastLine = {};

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
    style.textContent = `.wardrobe-reaction { position:absolute; z-index:4; left:calc(50% - min(25vw, 270px)); top:33%; width:min(330px, 38vw); color:#fff; pointer-events:none; opacity:0; transform:translateX(-10px); transition:opacity .14s ease, transform .14s ease; font-family:Arial,Helvetica,sans-serif; } .wardrobe-reaction.show { opacity:1; transform:translateX(0); } .wardrobe-reaction-name { display:table; padding:5px 10px 6px; background:#bf126a; color:#fff; font-size:17px; font-weight:800; line-height:1; } .wardrobe-reaction-text { position:relative; margin-top:4px; padding:10px 14px 11px; background:#1a062c; font-size:17px; font-weight:700; line-height:1.2; box-shadow:0 2px 5px rgba(0,0,0,.3); } .wardrobe-reaction-text::after { content:''; position:absolute; top:0; right:-15px; width:0; height:0; border-top:15px solid #1a062c; border-right:15px solid transparent; } @media (max-width:700px) { .wardrobe-reaction { left:12px; top:16%; width:min(300px, calc(100% - 42px)); } .wardrobe-reaction-name { font-size:14px; } .wardrobe-reaction-text { font-size:15px; } }`;
    document.head.appendChild(style);
    card = document.createElement('div');
    card.className = 'wardrobe-reaction';
    card.innerHTML = '<div class="wardrobe-reaction-name">JUN</div><div class="wardrobe-reaction-text"></div>';
    textEl = card.querySelector('.wardrobe-reaction-text');
    stage.appendChild(card);
  }

  async function activate() {
    active = true;
    buildCard();
    try {
      const response = await fetch('/api/relationship.php', { credentials: 'same-origin' });
      if (!response.ok) return;
      const state = await response.json();
      if (state && typeof state.affection === 'number') affection = state.affection;
    } catch (e) {}
  }

  function deactivate() {
    active = false;
    hide();
  }

  function pick(event, mood, item) {
    const options = LINES[event][mood];
    const id = `${event}:${mood}`;
    const choices = options.length > 1 ? options.filter(line => line !== lastLine[id]) : options;
    const line = choices[Math.floor(Math.random() * choices.length)];
    lastLine[id] = line;
    return line.replace('{item}', item.toLowerCase());
  }

  function applyExpression(kind) {
    if (!window.Live2D) return;
    if (kind === 'cold') {
      Live2D.setTarget('ParamBlush', 0);
      Live2D.setTarget('ParamMouthForm', -0.8);
      Live2D.setTarget('ParamBrowLEmote', -0.9);
      Live2D.setTarget('ParamBrowREmote', -0.9);
      Live2D.setTarget('ParamHeadZ', 5);
    } else if (kind === 'shy') {
      Live2D.setTarget('ParamBlush', 1);
      Live2D.setTarget('ParamMouthForm', -0.3);
      Live2D.setTarget('ParamBrowLEmote', -0.4);
      Live2D.setTarget('ParamBrowREmote', -0.4);
      Live2D.setTarget('ParamHeadZ', -7);
    } else if (kind === 'tease') {
      Live2D.setTarget('ParamBlush', 0.45);
      Live2D.setTarget('ParamMouthForm', 0.7);
      Live2D.setTarget('ParamEyesHappy', 1);
      Live2D.setTarget('ParamHeadZ', -5);
    } else if (kind === 'warm') {
      Live2D.setTarget('ParamBlush', 0.5);
      Live2D.setTarget('ParamMouthForm', 1);
      Live2D.setTarget('ParamEyesHappy', 1);
      Live2D.setTarget('ParamHeart', 0.55);
      Live2D.setTarget('ParamHeadZ', -4);
    } else {
      Live2D.setTarget('ParamBlush', kind === 'hair' ? 0.35 : 0.2);
      Live2D.setTarget('ParamMouthForm', 0.8);
      Live2D.setTarget('ParamEyesHappy', 1);
      Live2D.setTarget('ParamHeadZ', -4);
    }
  }

  function clearExpression() {
    if (window.Live2D && Live2D.resetIdle) Live2D.resetIdle();
  }

  function hide() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (card) card.classList.remove('show');
    clearExpression();
  }

  function react({ key, label, on, state }) {
    if (!active || !document.body.classList.contains('wardrobe-open') || !configureTts()) return;
    const isHair = key.indexOf('hair_') === 0;
    const clothes = Object.keys(state).filter(k => !k.startsWith('hair_') && !['cat_ears', 'pointy_ears', 'tail', 'hair_hologram'].includes(k));
    const nude = clothes.length > 0 && clothes.every(k => !state[k]);
    const event = nude ? 'nude'
      : key === 'bra' || key === 'panties' ? 'underwear'
      : isHair ? 'hair'
      : on ? 'wear'
      : 'remove';
    const mood = affection < 30 ? 'cold'
      : affection >= 85 ? 'tease'
      : affection >= 70 ? 'warm'
      : 'shy';
    const token = ++currentToken;
    hide();
    const text = pick(event, mood, label);
    TTS.speak(text, {
      onStart() {
        if (token !== currentToken) return;
        buildCard();
        if (!card || !textEl) return;
        textEl.textContent = text;
        applyExpression(mood);
        card.classList.add('show');
      },
      onDone() {
        if (token !== currentToken) return;
        hideTimer = setTimeout(hide, 180);
      },
      onError() {
        if (token === currentToken) hide();
      },
    });
  }

  return { activate, deactivate, react };
})();
