import { t } from '../core/i18n.js?v=1';
// two voices, NEVER mixed. JUN is her out loud and she has no
// idea an app exists. anything she wouldn't say with no screen
// in the room goes in DEV, the caption, she can't hear him.
// a line of hers is [text, [[action, kwargs], ...]], his is [label, caption]

// one story per look, each beat picks up where the last one
// left off. a key with no _fine twin plays for every look
export const JUN = {
  white: [
    [t('jun.tour.white.0', '{f_playerName}. look at my hands.'), [['shocked', {}], ['look', { dir: 'down' }]]],
    [t('jun.tour.white.1', 'white. my hair too. even the shirt, and i never owned a white shirt.'), [['emote', { type: 'surprised' }]]],
    [t('jun.tour.white.2', 'the hypercamo reset itself. it doesn\'t do that. i\'d know.'), [['brow', { emotion: 'worried' }], ['tilt_head', { dir: 'left', amount: 0.5 }]]],
    [t('jun.tour.white.3', 'stop staring. i know what i look like.'), [['blush', { intensity: 0.8 }], ['look', { dir: 'away' }]]],
  ],
  white_flat: [
    [t('jun.tour.white_flat.0', 'something\'s off. i feel like a drawing of myself.'), []],
    [t('jun.tour.white_flat.1', 'flat. like somebody cut me out of cardboard and stood me up.'), []],
    [t('jun.tour.white_flat.2', 'and i don\'t know what else stopped working.'), []],
  ],
  white_fine: [
    [t('jun.tour.white_fine.0', 'there you are. why are you looking at me like we just met?'), [['tilt_head', { dir: 'right', amount: 0.5 }], ['brow', { emotion: 'surprised' }]]],
  ],
  talk: [
    [t('jun.tour.talk.0', 'say something, {f_playerName}. i need to know the rest of me still works.'), [['brow', { emotion: 'worried' }]]],
    [t('jun.tour.talk.1', 'you talk, i answer. that part better not be broken too.'), [['mouth', { shape: 'pout' }]]],
  ],
  talk_fine: [
    [t('jun.tour.talk_fine.0', 'fine. i\'ll play along. say something.'), [['emote', { type: 'smug' }]]],
    [t('jun.tour.talk_fine.1', 'like the first time. i liked that~'), [['mouth', { shape: 'smile' }]]],
  ],
  hear: [
    [t('jun.tour.hear.0', 'and my voice. still mine? it sounds weird in my own head.'), [['tilt_head', { dir: 'left', amount: 0.4 }]]],
  ],
  hear_fine: [
    [t('jun.tour.hear_fine.0', 'you still like my voice, right? you never said.'), [['tilt_head', { dir: 'left', amount: 0.4 }]]],
  ],
  hear_mute: [
    [t('jun.tour.hear_mute.0', 'my mouth is moving and you hear nothing, don\'t you. great. that\'s gone too.'), [['mouth', { shape: 'pout' }], ['brow', { emotion: 'worried' }]]],
  ],
  hear_mute_fine: [
    [t('jun.tour.hear_mute_fine.0', 'i\'m talking, you know. you\'re just watching my mouth move.'), [['mouth', { shape: 'pout' }], ['blush', { intensity: 0.5 }]]],
  ],
  date: [
    [t('jun.tour.date.0', 'i still know who you are. i checked. so it\'s only the outside of me.'), [['mouth', { shape: 'smile' }]]],
    [t('jun.tour.date.1', 'and it won\'t fix itself in here. i have to go out like this.'), [['look', { dir: 'away' }], ['blush', { intensity: 0.7 }]]],
  ],
  date_fine: [
    [t('jun.tour.date_fine.0', 'if we\'re starting over, do it properly. take me out.'), [['emote', { type: 'happy' }]]],
    [t('jun.tour.date_fine.1', 'somewhere i can dress up for~'), [['look', { dir: 'away' }], ['blush', { intensity: 0.7 }]]],
  ],
  shop: [
    [t('jun.tour.shop.0', 'annalie\'s. she\'ll know how to put me back.'), [['nod', {}]]],
    [t('jun.tour.shop.1', 'take me, {f_playerName}. please. i\'m not asking, i\'m begging.'), [['brow', { emotion: 'worried' }], ['blush', { intensity: 0.8 }]]],
  ],
  shop_flat: [
    [t('jun.tour.shop_flat.0', 'i just want to feel like myself again.'), []],
  ],
  shop_fine: [
    [t('jun.tour.shop_fine.0', 'which means annalie\'s first. i\'ve got nothing new to wear.'), [['mouth', { shape: 'smile' }]]],
    [t('jun.tour.shop_fine.1', 'please. i never ask you for anything. i\'m asking now.'), [['blush', { intensity: 0.7 }], ['look', { dir: 'away' }]]],
  ],
};

export const DEV = {
  talk: [t('tour.dev.talk.title', 'Talk to her'), t('tour.dev.talk.text', 'type here, she answers.')],
  hear: [t('tour.dev.hear.title', 'Her voice'), t('tour.dev.hear.text', 'on, she says the replies out loud.')],
  hear_off: [t('tour.dev.hear_off.title', 'Her voice'), t('tour.dev.hear_off.text', 'not on this install right now. text works fine.')],
  mic: [t('tour.dev.mic.title', 'The mic'), t('tour.dev.mic.text', 'talk instead of typing.')],
  names: [t('tour.dev.names.title', 'Names'), t('tour.dev.names.text', 'what she calls you, and what you call her.')],
  memory: [t('tour.dev.memory.title', 'How she feels'), t('tour.dev.memory.text', 'and below it what she remembers. she can\'t see this.')],
  chats: [t('tour.dev.chats.title', 'Old chats'), t('tour.dev.chats.text', 'they live here. new one and search up top.')],
  dates: [t('tour.dev.dates.title', 'Going out'), t('tour.dev.dates.text', 'ask her out. she might say no, she does that.')],
  shop: [t('tour.dev.shop.title', 'Annalie\'s'), t('tour.dev.shop.text', 'her colours come back at the shop. you heard her.')],
  shop_flat: [t('tour.dev.shop_flat.title', 'No game art yet'), t('tour.dev.shop_flat.text', 'she looks like that because it isn\'t extracted. the install guide has the steps, chat still works.')],
  shop_fine: [t('tour.dev.shop_fine.title', 'Annalie\'s'), t('tour.dev.shop_fine.text', 'clothes and colours get changed at the shop. you heard her.')],
  bye: [t('tour.dev.bye.title', 'That\'s all'), t('tour.dev.bye.text', 'i\'ll leave you two to it.')],
};
