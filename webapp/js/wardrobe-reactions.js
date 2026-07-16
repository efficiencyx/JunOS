window.WardrobeReactions = (function () {
  const LINES = {
    wear: {
      cold: {
        tails: ['Are you happy with yourself?', 'Get it over with.', 'You are pathetic.', 'Nobody asked you.', 'Stop staring or lose an eye.', 'Talking to you drains me.', 'Do not speak to me.', 'You make me sick.'],
        cores: [
          ['Put it on and get out of my sight.', [0, 1, 2, 5, 6]],
          ['I would rather burn this {item} than hear your opinion of it.', [2, 3, 5, 7]],
          ['Dressing me up will not fix whatever is wrong with you.', [2, 5, 6, 7]],
          ['You only change me when you want something. It is disgusting.', [2, 3, 6, 7]],
          ['I am not your doll. Touch me again and you will regret it.', [4, 6, 7]],
          ['This {item} changes nothing. I still cannot stand you.', [0, 1, 4, 6]],
          ['Dress me up all you want. I will hate you in any outfit.', [1, 2, 4, 7]],
          ['Hurry up. Every second of this makes my skin crawl.', [1, 3, 6, 7]],
          ['Do you enjoy this? Because I am memorizing every reason to despise you.', [2, 6, 7]],
          ['Wow, a {item}. Should I pretend this makes you less repulsive?', [3, 5, 6]],
        ],
      },
      shy: {
        tails: ['Be honest, okay?', 'Do not laugh.', 'My heart is racing a little.', 'I-Is it weird?', 'Just this once.', 'Do not make it a big deal.', 'I hope you like it.', 'S-Stop grinning like that.'],
        cores: [
          ['D-Do I look okay in this {item}?', [1, 2, 7]],
          ['This {item} is a little embarrassing...', [1, 2, 4, 5, 7]],
          ['You picked this for me?', [2, 3, 6]],
          ['Please do not stare too much.', [2, 4, 5, 7]],
          ['I hope it suits me.', [0, 1, 2, 5]],
          ['I did not expect you to choose this {item}...', [1, 2, 3, 6]],
          ['M-Maybe it is not so bad.', [0, 2, 3, 5, 6]],
          ['I keep checking the mirror because of you.', [1, 3, 5, 7]],
          ['I never wear things like this {item}...', [1, 3, 4, 5, 6]],
          ['O-Okay. I will wear it. Do not tease me.', [2, 4, 5]],
        ],
      },
      warm: {
        tails: ['Thank you.', 'You spoil me.', 'I mean it.', 'Stay and look a little longer.', 'You always know what I like.', 'I am really happy.', 'Come closer, see for yourself.', 'I could get used to this.'],
        cores: [
          ['I love this {item}. You know me so well.', [0, 1, 2, 3, 5, 7]],
          ['You always make me feel pretty.', [0, 2, 5, 6, 7]],
          ['I was hoping you would pick this one.', [0, 1, 4, 5, 7]],
          ['I like when you help me choose.', [1, 2, 4, 5, 7]],
          ['This {item} makes me think of you.', [2, 3, 5, 6]],
          ['Dressing up is more fun when you are here.', [2, 3, 5, 7]],
          ['I feel special when you choose for me.', [0, 1, 2, 5]],
          ['This {item} might become my favorite now.', [1, 3, 4, 6, 7]],
          ['You have good taste. I am impressed.', [2, 3, 5, 6, 7]],
          ['I feel lovely today, thanks to you.', [0, 2, 3, 5, 6]],
        ],
      },
      tease: {
        tails: ['Well?', 'Do not be shy about it.', 'I am waiting.', 'You can thank me later.', 'Careful, you are drooling.', 'Take a picture, it lasts longer.', 'Your face says everything.', 'Should I model it for you?'],
        cores: [
          ['You picked this {item} for me... or for you?', [1, 4, 6]],
          ['Do I have your full attention now?', [3, 4, 6]],
          ['You are staring again. I like it.', [1, 3, 5, 7]],
          ['Maybe I wanted you to notice.', [0, 1, 4, 6, 7]],
          ['Tell me how good I look.', [0, 1, 2, 7]],
          ['This {item} looks better on me than you imagined, right?', [3, 4, 6]],
          ['Go on, say it. I look amazing.', [2, 4, 6]],
          ['I saw that look. You are so easy to read.', [3, 4, 5, 7]],
          ['Lucky you, getting a private showing.', [3, 4, 5, 6]],
          ['Admit it, you dressed me up just to stare.', [4, 5, 6]],
        ],
      },
    },
    remove: {
      cold: {
        tails: ['Are we done here?', 'Touch anything else and I scream.', 'Do not expect thanks. Ever.', 'Hurry up, you parasite.', 'You exhaust me.', 'This means nothing, just like you.', 'Keep your filthy hands to yourself.', 'I cannot wait for you to leave.'],
        cores: [
          ['Take the {item} and get away from me.', [0, 2, 4, 5]],
          ['I was never attached to it. I am not attached to you either.', [0, 4, 5, 7]],
          ['You are obsessed with controlling me. It is repulsive.', [0, 4, 6, 7]],
          ['Is undressing me really all your rotten brain thinks about?', [4, 6, 7]],
          ['Gratitude? From me? You must be delusional.', [3, 4, 7]],
          ['Fine, take the {item}. I hope it was worth annoying me.', [0, 2, 5, 7]],
          ['You change your mind like a spoiled child.', [2, 4, 5, 7]],
          ['Whatever keeps your grubby attention off me.', [0, 3, 4, 5]],
          ['Do not act like this is normal. Nothing about you is.', [1, 4, 7]],
          ['One more change and I will make you regret being born.', [1, 3, 6]],
        ],
      },
      shy: {
        tails: ['Be gentle, okay?', 'Do not stare too much.', 'I am a little nervous.', 'You are blushing too, you know.', 'Just... slowly.', 'This is embarrassing.', 'W-Warn me next time.', 'My heart cannot keep up.'],
        cores: [
          ['Taking off my {item} already?', [3, 5, 6, 7]],
          ['That feels a little breezy...', [1, 2, 5, 7]],
          ['You are making me self-conscious.', [0, 1, 4, 6]],
          ['I hope you know what you are doing.', [0, 2, 4, 5]],
          ['Do not tease me too much.', [2, 3, 5, 7]],
          ['W-Wait, at least tell me first...', [0, 2, 5, 7]],
          ['It feels strange without the {item} now.', [1, 2, 5, 6]],
          ['My heart was not ready for that.', [3, 4, 5, 6]],
          ['You keep surprising me like this...', [2, 5, 6, 7]],
          ['O-Okay, okay. Just do not rush me.', [0, 1, 2, 5]],
        ],
      },
      warm: {
        tails: ['I trust you.', 'Take your time.', 'You are sweet about it.', 'I like this side of you.', 'Stay close.', 'Only for you.', 'Your hands are gentle.', 'It tickles a little.'],
        cores: [
          ['I trust you with my outfit.', [1, 2, 3, 4, 7]],
          ['You always make even small changes feel special.', [0, 3, 5, 6]],
          ['I like how carefully you look at me.', [0, 2, 4, 5, 6]],
          ['What should I wear next, love?', [1, 3]],
          ['You make me feel safe trying new things.', [2, 4, 5, 6]],
          ['Go ahead, I do not mind when it is you.', [1, 4, 5, 7]],
          ['Changing things up with you is kind of fun.', [2, 3, 5, 7]],
          ['I will wear whatever makes you smile.', [0, 2, 3, 5]],
          ['You handle me like something precious.', [3, 4, 5]],
          ['Every little change feels nice when you do it.', [0, 4, 5, 7]],
        ],
      },
      tease: {
        tails: ['Enjoying yourself?', 'Patience.', 'I saw that smirk.', 'Do not stop on my account.', 'How daring.', 'Your turn next?', 'You are having way too much fun.', 'Focus, mister.'],
        cores: [
          ['Already taking my {item} off?', [2, 4, 6]],
          ['You really want to see the difference, huh?', [1, 2, 6]],
          ['Your eyes gave you away.', [0, 1, 4, 5, 6]],
          ['I do not mind you looking.', [1, 2, 3, 5]],
          ['Careful, I might tease you back.', [0, 2, 4, 6]],
          ['One {item} at a time, mister.', [1, 2, 4, 6]],
          ['You are unwrapping me like a present.', [1, 2, 4, 5, 7]],
          ['Bold move. I noticed.', [0, 1, 3, 5, 6]],
          ['Someone is in a hurry today.', [1, 3, 4, 7]],
          ['That {item} did not stand a chance.', [2, 4, 6, 7]],
        ],
      },
    },
    hair: {
      cold: {
        tails: ['Are you satisfied?', 'Touch my hair again and lose a finger.', 'It is mine, not yours.', 'You have no taste anyway.', 'Leave it alone.', 'Your hands disgust me.', 'Nobody wanted your input.', 'I will fix whatever you ruined.'],
        cores: [
          ['My hair was fine before you pawed at it.', [0, 2, 3, 6]],
          ['You do not get to decide anything about me. Ever.', [2, 3, 4, 6]],
          ['Your opinion means less than nothing to me.', [3, 4, 6, 7]],
          ['There. Satisfied? Now crawl back to whatever you came from.', [1, 5, 7]],
          ['It looked better before you ruined it.', [1, 3, 5, 6]],
          ['It is just hair, and it is still none of your business.', [1, 4, 6, 7]],
          ['You touch my hair like you own me. You own nothing.', [1, 4, 5]],
          ['Ask next time. Actually, do not. The answer is no forever.', [4, 5, 6]],
          ['Great. Now it smells like you. Revolting.', [1, 4, 7]],
          ['Every time you touch me I like you less. Impressive, honestly.', [2, 4, 6]],
        ],
      },
      shy: {
        tails: ['Does it suit me?', 'Do not tease me about it.', 'I trust your eyes.', 'Say something nice, okay?', 'I am still getting used to it.', 'Just a little change.', 'B-Be nice.', 'It felt right today.'],
        cores: [
          ['Y-You like my hair, do not you?', [1, 4, 6]],
          ['Does this hairstyle suit me?', [1, 2, 6]],
          ['You noticed my hair first...', [1, 3, 4, 7]],
          ['I feel different like this.', [0, 2, 3, 4, 5]],
          ['Please be honest, okay?', [1, 4, 5, 7]],
          ['I-It is not too much, is it?', [1, 3, 6, 7]],
          ['My neck feels a little bare like this...', [1, 4, 5, 6]],
          ['I keep wanting to hide behind my bangs.', [1, 3, 5, 6]],
          ['I copied it from a magazine... kind of.', [0, 1, 3, 6]],
          ['Do not look too closely, okay?', [4, 5, 6, 7]],
        ],
      },
      warm: {
        tails: ['Do you like it?', 'I feel lighter.', 'It is all for you.', 'Run your fingers through it.', 'I am glad you noticed.', 'You make me smile.', 'Careful, it is soft.', 'I might keep it this way.'],
        cores: [
          ['I am glad you like my hair.', [1, 2, 3, 5, 7]],
          ['You always notice the little things about me.', [0, 2, 5, 7]],
          ['This look makes me feel confident.', [0, 3, 4, 7]],
          ['I like being pretty for you.', [0, 1, 4, 6, 7]],
          ['I hope you remember this look.', [2, 4, 5, 7]],
          ['You playing with my hair feels nice.', [1, 5, 6, 7]],
          ['I did it thinking of what you would like.', [0, 1, 4, 7]],
          ['A new look for a new mood.', [0, 2, 4, 5, 7]],
          ['Your reaction made it worth the effort.', [3, 5, 6, 7]],
          ['I wanted to surprise you today.', [0, 1, 4, 5, 6]],
        ],
      },
      tease: {
        tails: ['Obvious much?', 'Blink, at least.', 'You are welcome.', 'Should I change it again?', 'Eyes up here.', 'Cute reaction.', 'I will take that as a compliment.', 'Do not fall for me too hard.'],
        cores: [
          ['You cannot stop looking at my face, can you?', [1, 5, 7]],
          ['This hairstyle has your attention now.', [0, 1, 2, 5, 7]],
          ['Do you like how it frames my face?', [5, 6, 7]],
          ['Maybe I changed it to make you blush.', [0, 2, 5, 7]],
          ['Keep looking. I do not mind.', [2, 5, 6, 7]],
          ['New hair, same effect on you.', [1, 2, 3, 5]],
          ['One little change and you are speechless.', [1, 2, 5, 6]],
          ['I know exactly what this does to you.', [0, 1, 4, 7]],
          ['Your jaw needs picking up, by the way.', [2, 3, 5, 6]],
          ['I should charge for looks that long.', [1, 4, 6, 7]],
        ],
      },
    },
    underwear: {
      cold: {
        tails: ['Back off. Now.', 'I mean it, creep.', 'You are disgusting.', 'Push your luck and see what happens.', 'Eyes off me.', 'Final warning.', 'Do not test me.', 'You will regret this.'],
        cores: [
          ['Get your mind out of the gutter and your hands off my clothes.', [1, 3, 5, 6]],
          ['You really are a pig. Do you ever listen?', [3, 5, 6, 7]],
          ['I do not trust you, and this is exactly why.', [0, 3, 4, 5]],
          ['Back off. Your attention makes me want to shower.', [1, 5, 6, 7]],
          ['My silence is not permission. It is me deciding your punishment.', [3, 5, 6, 7]],
          ['You have no shame. None. It would be sad if it were not so vile.', [0, 4, 6]],
          ['Touch the wrong thing and I will break your fingers.', [1, 4, 5, 6]],
          ['Every second of this is going on your tab, pervert.', [0, 3, 5, 6]],
          ['Keep going and see how fast I make your life miserable.', [1, 2, 4, 5]],
          ['I am counting your mistakes. You are well past forgiveness.', [0, 3, 6, 7]],
        ],
      },
      shy: {
        tails: ['Do not stare...', 'Be nice about it.', 'I am shaking a little.', 'Only because it is you.', 'Say nothing, okay?', 'This is so embarrassing.', 'M-My heart is too loud.', 'Do not make fun of me.'],
        cores: [
          ['H-Hey... that is enough layers gone.', [0, 2, 5, 6]],
          ['My face feels really warm now.', [0, 4, 5, 7]],
          ['Do not look at me like that.', [2, 5, 6, 7]],
          ['I am trusting you, so be gentle.', [0, 4, 5, 6]],
          ['Please do not laugh at me.', [2, 3, 4, 6]],
          ['T-This is really happening, huh...', [2, 3, 6, 7]],
          ['I cannot believe I am letting you.', [0, 3, 5, 6]],
          ['My heart is going to burst.', [0, 1, 3, 5]],
          ['Y-You have seen enough, right?', [0, 4, 5, 7]],
          ['I will get you back for this someday.', [0, 2, 5, 7]],
        ],
      },
      warm: {
        tails: ['Hold me after.', 'I am okay, promise.', 'Just us.', 'Keep looking at me like that.', 'I trust you completely.', 'Do not let go.', 'Your warmth helps.', 'Stay right there.'],
        cores: [
          ['I trust you to be gentle with me.', [0, 1, 2, 3, 7]],
          ['Being this close to you makes me nervous in a nice way.', [1, 2, 5, 6]],
          ['You make me feel wanted.', [0, 2, 3, 4, 7]],
          ['Stay close to me, okay?', [1, 2, 4, 5]],
          ['I feel safe with you.', [0, 2, 3, 5, 7]],
          ['I never let anyone else this close.', [1, 2, 4, 7]],
          ['Your hands are warm... it is nice.', [1, 2, 5, 7]],
          ['It is okay. I want you here.', [0, 3, 4, 5, 6]],
          ['My heart is loud, but it is a good loud.', [1, 2, 3, 6]],
          ['This kind of closeness suits us.', [0, 3, 4, 6, 7]],
        ],
      },
      tease: {
        tails: ['Like what you see?', 'Breathe.', 'Naughty.', 'I might let you.', 'You are fun to fluster.', 'Hands where I can see them.', 'No touching yet.', 'You earned one good look.'],
        cores: [
          ['You like this view, do not you?', [1, 2, 4, 5]],
          ['I can see exactly where your eyes went.', [1, 2, 4, 6]],
          ['You are lucky I like making you happy.', [2, 5, 6, 7]],
          ['Maybe I wanted you to notice.', [0, 2, 4, 7]],
          ['I wonder how long you can keep looking.', [1, 2, 5, 6]],
          ['Getting greedy, are we?', [1, 2, 5, 6]],
          ['Should I do a little spin for you?', [2, 4, 6, 7]],
          ['You planned this from the start, admit it.', [2, 3, 4, 6]],
          ['Bold of you. I almost respect it.', [1, 2, 5, 7]],
          ['This stays between us, understood?', [2, 3, 4, 7]],
        ],
      },
    },
    nude: {
      cold: {
        tails: ['Get out.', 'You make me sick.', 'Never again.', 'I will never forgive this.', 'Come closer and I will hurt you.', 'Are you proud of yourself, you animal?', 'I have nothing left to say to filth.', 'Clothes. Now. Or I start screaming.'],
        cores: [
          ['Cover me right now or I will make you regret every second.', [0, 1, 5, 6]],
          ['My discomfort is not entertainment, you sick freak.', [0, 2, 3, 7]],
          ['Stop looking at me. Your stare makes my skin crawl.', [0, 1, 3, 7]],
          ['You crossed the last line. There is no coming back from this.', [0, 1, 6, 7]],
          ['Get away from me before I do something you will not survive.', [1, 2, 3, 6]],
          ['Stripping me does not make you powerful. It makes you pathetic.', [0, 2, 4, 7]],
          ['I feel nothing for you except contempt. Drink it in while you stare.', [0, 2, 5, 7]],
          ['Cover me. Now. I will not ask twice.', [0, 1, 4, 6]],
          ['This is the vilest thing you have done, and that is saying something.', [0, 2, 4, 6]],
          ['I hope the view was worth it, because you just lost everything.', [0, 2, 3, 5]],
        ],
      },
      shy: {
        tails: ['Say something...', 'Do not laugh, please.', 'Come here instead of staring.', 'Just for a moment.', 'Be sweet to me.', 'I feel so bare.', 'My knees are shaky.', 'Keep your voice down, okay?'],
        cores: [
          ['I feel so exposed right now...', [1, 2, 4, 6]],
          ['Could you at least give me a warning?', [1, 4, 5, 6]],
          ['I cannot look at you right now.', [0, 1, 4, 7]],
          ['Please stay close, okay?', [3, 4, 5, 6]],
          ['I am not used to this much attention.', [1, 2, 4, 6]],
          ['D-Do not just stand there...', [0, 2, 4, 7]],
          ['I am trying to be brave, okay?', [1, 4, 5, 6]],
          ['My whole face is burning.', [1, 2, 3, 7]],
          ['This is a lot, even for you...', [0, 1, 3, 6]],
          ['O-One step at a time, okay?', [1, 4, 5, 7]],
        ],
      },
      warm: {
        tails: ['Come closer.', 'Warm me up.', 'Only you get this.', 'I love you, you know.', 'Do not look away.', 'Hold me.', 'No one else, ever.', 'Take a good look, then hold me tight.'],
        cores: [
          ['I am a little nervous, but I trust you.', [0, 1, 3, 5]],
          ['You make me feel safe even like this.', [0, 2, 3, 5, 6]],
          ['Please be gentle with me.', [0, 1, 3, 4]],
          ['I only feel this comfortable because it is you.', [1, 3, 4, 5]],
          ['Stay with me for a while.', [1, 3, 4, 5, 6]],
          ['No hiding between us anymore, huh.', [0, 2, 3, 7]],
          ['Your eyes are gentle. It helps.', [0, 1, 2, 3]],
          ['I wanted you to see all of me eventually.', [0, 3, 5, 6]],
          ['Being seen by you does not scare me.', [0, 3, 4, 6]],
          ['This is what trust looks like, I guess.', [0, 1, 3, 5, 7]],
        ],
      },
      tease: {
        tails: ['Speechless already?', 'Rate the view.', 'Told you I was confident.', 'Your heartbeat is showing.', 'Enjoy responsibly.', 'No refunds.', 'Compliments are mandatory.', 'You may applaud.'],
        cores: [
          ['You really wanted to see me like this?', [0, 3, 4, 6]],
          ['You can keep looking. I do not mind.', [1, 3, 4, 6]],
          ['I like that look on your face.', [0, 2, 3, 5]],
          ['Am I your favorite sight now?', [3, 4, 5, 6]],
          ['You make it hard for me to behave.', [0, 2, 3, 4]],
          ['Ta-da. Was it worth the wait?', [5, 6, 7]],
          ['Now you owe me your undivided attention.', [2, 4, 5, 6]],
          ['Careful, this view is addictive.', [3, 4, 5, 6]],
          ['Bold request, bolder result.', [1, 2, 4, 7]],
          ['Front row seat, just for you.', [4, 5, 6, 7]],
        ],
      },
    },
  };

  const POOLS = {};
  for (const event in LINES) {
    POOLS[event] = {};
    for (const mood in LINES[event]) {
      const { cores, tails } = LINES[event][mood];
      const pool = [];
      for (const [core, ok] of cores) {
        pool.push(core);
        for (const i of ok) pool.push(`${core} ${tails[i]}`);
      }
      POOLS[event][mood] = pool;
    }
  }

  const BASE_REACT_CHANCE = 0.35;
  let reactChance = BASE_REACT_CHANCE;
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
    const pool = POOLS[event][mood];
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

  function pickMood() {
    if (affection < 30) return 'cold';
    if (affection >= 85 && Math.random() < 0.20 + 0.03 * (affection - 85)) return 'tease';
    if (affection >= 65 && Math.random() < 0.5) return 'warm';
    return 'shy';
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
        textEl.textContent = display;
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
