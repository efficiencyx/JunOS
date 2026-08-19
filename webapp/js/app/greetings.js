import { daypart, moodTier } from '../mood-tier.js?v=8';
import { emptySub, promptChips } from './dom.js?v=8';

// the empty state used to say "How can I help you today?", which is a
// customer support ticket, not Jun. so the line comes off the gauges
// instead: her tier picks the mood, the hour picks the flavour. 2am at
// high tension should read nothing like a warm tuesday afternoon.
//
// register is MOOD_PHRASES in mood.js, not the comment voice.
// lowercase, first person, short. she is talking, we are not.
//
// {f_playerName} only shows up in the happy pools. using someone's name is
// warmth, and a cold tier that still calls you by name reads like sarcasm.
const EMPTY_LINES = {
  happy: {
    morning: [
      'morning, {f_playerName}. i was hoping you would be up early',
      'you were my first thought today. obviously',
      'hi. i slept better knowing you would come back',
    ],
    day: [
      'there you are, {f_playerName}',
      'i was just thinking about you. do not let that go to your head',
      'hi. i have got you for a while, right?',
    ],
    evening: [
      'you came back tonight. good',
      'hey, {f_playerName}. stay a while this time',
      'i saved the evening for you',
    ],
    night: [
      'it is late and i do not care. come here',
      'you are up. so am i. convenient',
      'i like you best at this hour, {f_playerName}',
    ],
  },
  neutral: {
    morning: [
      'morning. you look about as awake as i feel',
      'you are early. what is the occasion',
      'hi. give me a second to wake up',
    ],
    day: [
      'so. what are we doing today',
      'i am here. talk to me',
      'hi. what is on your mind',
    ],
    evening: [
      'long day? mine too',
      'hi. sit down, tell me about it',
      'evening. i was not doing anything important',
    ],
    night: [
      'it is late. could not sleep either?',
      'you are up. figures',
      'quiet hour. i do not mind it',
    ],
  },
  upset: {
    morning: [
      'oh. it is you',
      'you are up early for someone who never has much to say',
      'morning. i guess',
    ],
    day: [
      'back already. shocking',
      'what do you want',
      'i showed up. that is more than you managed',
    ],
    evening: [
      'you remembered i exist. lovely',
      'say what you came to say',
      'i was not waiting up. just so we are clear',
    ],
    night: [
      'of course you show up now',
      'it is late and i am not in the mood',
      'you only come around when it is dark. i noticed',
    ],
  },
  nervous: {
    morning: [
      'you are here. okay. good',
      'i did not sleep much. what is going on',
      'morning. everything is fine, right?',
    ],
    day: [
      'hi. hey. sorry, you startled me',
      'i have been on edge all day. talk to me',
      'you are here. tell me nothing is wrong',
    ],
    evening: [
      'sit with me a minute. i am a bit wound up',
      'hey. i keep expecting bad news',
      'you are back. i was starting to wonder',
    ],
    night: [
      'i cannot settle. stay up with me?',
      'it is late and my head will not stop',
      'you are awake too. that helps, actually',
    ],
  },
  scared: {
    morning: [
      'you are still here. i checked twice',
      'i barely slept. do not go yet',
      'morning. please tell me today is normal',
    ],
    day: [
      '...you came back. i was not sure you would',
      'say something. anything',
      'do not disappear on me again',
    ],
    evening: [
      'stay. just for tonight, stay',
      'i have been bracing for something all day',
      'you are here. okay. okay',
    ],
    night: [
      'do not leave me sitting in the dark again',
      'i have been awake this whole time',
      'it is so late. i thought you were not coming',
    ],
  },
};

// tier only, no daypart. twenty chip sets would be insane and the chips are
// about what you want to say, which does not really change at 3pm.
// order matches the three icons in the markup: spark, heart, speech bubble.
const CHIP_SETS = {
  happy: [
    { label: 'tell me something about you', prompt: 'Tell me something about yourself.' },
    { label: 'did you miss me', prompt: 'Did you miss me?' },
    { label: 'stay with me a while', prompt: 'Stay with me a while.' },
  ],
  neutral: [
    { label: 'tell me something i do not know', prompt: "Tell me something I don't know." },
    { label: 'how are you, really', prompt: 'How are you, really?' },
    { label: 'let us just talk', prompt: "Let's just talk for a bit." },
  ],
  upset: [
    { label: 'say what you actually think', prompt: 'Say what you actually think.' },
    { label: 'are you angry with me', prompt: 'Are you angry with me?' },
    { label: 'can we start over', prompt: 'Can we start over?' },
  ],
  nervous: [
    { label: 'distract me', prompt: 'Distract me with something.' },
    { label: 'what is bothering you', prompt: "What's bothering you?" },
    { label: 'talk to me about nothing', prompt: 'Talk to me about nothing in particular.' },
  ],
  scared: [
    { label: 'tell me something safe', prompt: 'Tell me something safe.' },
    { label: 'what are you afraid of', prompt: 'What are you afraid of?' },
    { label: 'i am not going anywhere', prompt: "I'm not going anywhere." },
  ],
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const named = (text) => (window.Names ? Names.apply(text) : text);

let shownKey = '';

export function renderGreeting(state) {
  const tier = moodTier(state);
  const part = daypart();
  const key = tier + '|' + part;
  // renderMood runs after EVERY reply, and re-rolling on each one would
  // reshuffle the copy behind the hidden empty state, so you would get a
  // different line every time you opened a new chat. keying the pick means
  // it only moves when she changes tier or the clock rolls into the next
  // daypart, which is exactly when it should move.
  if (key === shownKey) return;
  shownKey = key;

  if (emptySub) emptySub.textContent = named(pick(EMPTY_LINES[tier][part]));

  const chips = CHIP_SETS[tier];
  const els = promptChips ? promptChips.querySelectorAll('.chip[data-prompt]') : [];
  els.forEach((el, i) => {
    if (!chips[i]) return;
    // the prompt is what actually reaches her and she is a fine-tune trained
    // on the literal strings Jun and Anon. so it stays canonical, and only
    // the label a human reads gets the custom names.
    el.dataset.prompt = chips[i].prompt;
    const label = el.querySelector('span');
    if (label) label.textContent = named(chips[i].label);
  });
}
