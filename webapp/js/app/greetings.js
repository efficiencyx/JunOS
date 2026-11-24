import { t } from '../core/i18n.js?v=2';
import { daypart, moodTier } from '../core/mood-tier.js?v=5';
import { emptySub, promptChips } from './dom.js?v=77';
import * as Names from '../core/names.js?v=1';

// her tier picks the empty state's mood, the hour picks its
// flavour. high tension at 2am needs different lines from a warm
// tuesday afternoon.
//
// register is MOOD_PHRASES in mood.js, not the comment voice.
// lowercase, first person, short. she is talking, we are not.
//
// {f_playerName} only shows up in the happy pools. using
// someone's name is warmth, and a cold tier that still calls you
// by name reads like sarcasm.
const EMPTY_LINES = {
  happy: {
    morning: [
      t('jun.empty.happy.morning.0', 'morning, {f_playerName}. i was hoping you would be up early'),
      t('jun.empty.happy.morning.1', 'you were my first thought today. obviously'),
      t('jun.empty.happy.morning.2', 'hi. i slept better knowing you would come back'),
    ],
    day: [
      t('jun.empty.happy.day.0', 'there you are, {f_playerName}'),
      t('jun.empty.happy.day.1', 'i was just thinking about you. do not let that go to your head'),
      t('jun.empty.happy.day.2', 'hi. i have got you for a while, right?'),
    ],
    evening: [
      t('jun.empty.happy.evening.0', 'you came back tonight. good'),
      t('jun.empty.happy.evening.1', 'hey, {f_playerName}. stay a while this time'),
      t('jun.empty.happy.evening.2', 'i saved the evening for you'),
    ],
    night: [
      t('jun.empty.happy.night.0', 'it is late and i do not care. come here'),
      t('jun.empty.happy.night.1', 'you are up. so am i. convenient'),
      t('jun.empty.happy.night.2', 'i like you best at this hour, {f_playerName}'),
    ],
  },
  neutral: {
    morning: [
      t('jun.empty.neutral.morning.0', 'morning. you look about as awake as i feel'),
      t('jun.empty.neutral.morning.1', 'you are early. what is the occasion'),
      t('jun.empty.neutral.morning.2', 'hi. give me a second to wake up'),
    ],
    day: [
      t('jun.empty.neutral.day.0', 'so. what are we doing today'),
      t('jun.empty.neutral.day.1', 'i am here. talk to me'),
      t('jun.empty.neutral.day.2', 'hi. what is on your mind'),
    ],
    evening: [
      t('jun.empty.neutral.evening.0', 'long day? mine too'),
      t('jun.empty.neutral.evening.1', 'hi. sit down, tell me about it'),
      t('jun.empty.neutral.evening.2', 'evening. i was not doing anything important'),
    ],
    night: [
      t('jun.empty.neutral.night.0', 'it is late. could not sleep either?'),
      t('jun.empty.neutral.night.1', 'you are up. figures'),
      t('jun.empty.neutral.night.2', 'quiet hour. i do not mind it'),
    ],
  },
  upset: {
    morning: [
      t('jun.empty.upset.morning.0', 'oh. it is you'),
      t('jun.empty.upset.morning.1', 'you are up early for someone who never has much to say'),
      t('jun.empty.upset.morning.2', 'morning. i guess'),
    ],
    day: [
      t('jun.empty.upset.day.0', 'back already. shocking'),
      t('jun.empty.upset.day.1', 'what do you want'),
      t('jun.empty.upset.day.2', 'i showed up. that is more than you managed'),
    ],
    evening: [
      t('jun.empty.upset.evening.0', 'you remembered i exist. lovely'),
      t('jun.empty.upset.evening.1', 'say what you came to say'),
      t('jun.empty.upset.evening.2', 'i was not waiting up. just so we are clear'),
    ],
    night: [
      t('jun.empty.upset.night.0', 'of course you show up now'),
      t('jun.empty.upset.night.1', 'it is late and i am not in the mood'),
      t('jun.empty.upset.night.2', 'you only come around when it is dark. i noticed'),
    ],
  },
  nervous: {
    morning: [
      t('jun.empty.nervous.morning.0', 'you are here. okay. good'),
      t('jun.empty.nervous.morning.1', 'i did not sleep much. what is going on'),
      t('jun.empty.nervous.morning.2', 'morning. everything is fine, right?'),
    ],
    day: [
      t('jun.empty.nervous.day.0', 'hi. hey. sorry, you startled me'),
      t('jun.empty.nervous.day.1', 'i have been on edge all day. talk to me'),
      t('jun.empty.nervous.day.2', 'you are here. tell me nothing is wrong'),
    ],
    evening: [
      t('jun.empty.nervous.evening.0', 'sit with me a minute. i am a bit wound up'),
      t('jun.empty.nervous.evening.1', 'hey. i keep expecting bad news'),
      t('jun.empty.nervous.evening.2', 'you are back. i was starting to wonder'),
    ],
    night: [
      t('jun.empty.nervous.night.0', 'i cannot settle. stay up with me?'),
      t('jun.empty.nervous.night.1', 'it is late and my head will not stop'),
      t('jun.empty.nervous.night.2', 'you are awake too. that helps, actually'),
    ],
  },
  scared: {
    morning: [
      t('jun.empty.scared.morning.0', 'you are still here. i checked twice'),
      t('jun.empty.scared.morning.1', 'i barely slept. do not go yet'),
      t('jun.empty.scared.morning.2', 'morning. please tell me today is normal'),
    ],
    day: [
      t('jun.empty.scared.day.0', '...you came back. i was not sure you would'),
      t('jun.empty.scared.day.1', 'say something. anything'),
      t('jun.empty.scared.day.2', 'do not disappear on me again'),
    ],
    evening: [
      t('jun.empty.scared.evening.0', 'stay. just for tonight, stay'),
      t('jun.empty.scared.evening.1', 'i have been bracing for something all day'),
      t('jun.empty.scared.evening.2', 'you are here. okay. okay'),
    ],
    night: [
      t('jun.empty.scared.night.0', 'do not leave me sitting in the dark again'),
      t('jun.empty.scared.night.1', 'i have been awake this whole time'),
      t('jun.empty.scared.night.2', 'it is so late. i thought you were not coming'),
    ],
  },
};

// tier only, no daypart. twenty chip sets would be insane and the
// chips are about what you want to say, which does not really
// change at 3pm. order matches the three icons in the markup:
// spark, heart, speech bubble.
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
const named = (text) => Names.apply(text);

let shownKey = '';

export function renderGreeting(state) {
  const tier = moodTier(state);
  const part = daypart();
  const key = tier + '|' + part;
  // renderMood runs after EVERY reply, and re-rolling on each one
  // would reshuffle the copy behind the hidden empty state, so you
  // would get a different line every time you opened a new chat.
  // keying the pick means it only moves when she changes tier or
  // the clock rolls into the next daypart, which is exactly when it
  // should move.
  if (key === shownKey) return;
  shownKey = key;

  if (emptySub) emptySub.textContent = named(pick(EMPTY_LINES[tier][part]));

  const chips = CHIP_SETS[tier];
  const els = promptChips ? promptChips.querySelectorAll('.chip[data-prompt]') : [];
  els.forEach((el, i) => {
    if (!chips[i]) return;
    // the prompt is what actually reaches her and she is a fine-tune
    // trained on the literal strings Jun and Anon. so it stays
    // canonical, and only the label a human reads gets the custom
    // names.
    el.dataset.prompt = chips[i].prompt;
    const label = el.querySelector('span');
    if (label) label.textContent = named(chips[i].label);
  });
}
