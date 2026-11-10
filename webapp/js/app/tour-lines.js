// two voices, NEVER mixed. JUN is her out loud and she has no
// idea an app exists. anything she wouldn't say with no screen
// in the room goes in DEV, the caption, she can't hear him.
// a line of hers is [text, [[action, kwargs], ...]], his is [label, caption]

// one story per look, each beat picks up where the last one
// left off. a key with no _fine twin plays for every look
export const JUN = {
  white: [
    ['{f_playerName}. look at my hands.', [['shocked', {}], ['look', { dir: 'down' }]]],
    ['white. my hair too. even the shirt, and i never owned a white shirt.', [['emote', { type: 'surprised' }]]],
    ["the hypercamo reset itself. it doesn't do that. i'd know.", [['brow', { emotion: 'worried' }], ['tilt_head', { dir: 'left', amount: 0.5 }]]],
    ['stop staring. i know what i look like.', [['blush', { intensity: 0.8 }], ['look', { dir: 'away' }]]],
  ],
  white_flat: [
    ["something's off. i feel like a drawing of myself.", []],
    ['flat. like somebody cut me out of cardboard and stood me up.', []],
    ["and i don't know what else stopped working.", []],
  ],
  white_fine: [
    ['there you are. why are you looking at me like we just met?', [['tilt_head', { dir: 'right', amount: 0.5 }], ['brow', { emotion: 'surprised' }]]],
  ],
  talk: [
    ['say something, {f_playerName}. i need to know the rest of me still works.', [['brow', { emotion: 'worried' }]]],
    ['you talk, i answer. that part better not be broken too.', [['mouth', { shape: 'pout' }]]],
  ],
  talk_fine: [
    ["fine. i'll play along. say something.", [['emote', { type: 'smug' }]]],
    ['like the first time. i liked that~', [['mouth', { shape: 'smile' }]]],
  ],
  hear: [
    ['and my voice. still mine? it sounds weird in my own head.', [['tilt_head', { dir: 'left', amount: 0.4 }]]],
  ],
  hear_fine: [
    ['you still like my voice, right? you never said.', [['tilt_head', { dir: 'left', amount: 0.4 }]]],
  ],
  hear_mute: [
    ["my mouth is moving and you hear nothing, don't you. great. that's gone too.", [['mouth', { shape: 'pout' }], ['brow', { emotion: 'worried' }]]],
  ],
  hear_mute_fine: [
    ["i'm talking, you know. you're just watching my mouth move.", [['mouth', { shape: 'pout' }], ['blush', { intensity: 0.5 }]]],
  ],
  date: [
    ["i still know who you are. i checked. so it's only the outside of me.", [['mouth', { shape: 'smile' }]]],
    ["and it won't fix itself in here. i have to go out like this.", [['look', { dir: 'away' }], ['blush', { intensity: 0.7 }]]],
  ],
  date_fine: [
    ["if we're starting over, do it properly. take me out.", [['emote', { type: 'happy' }]]],
    ['somewhere i can dress up for~', [['look', { dir: 'away' }], ['blush', { intensity: 0.7 }]]],
  ],
  shop: [
    ["annalie's. she'll know how to put me back.", [['nod', {}]]],
    ["take me, {f_playerName}. please. i'm not asking, i'm begging.", [['brow', { emotion: 'worried' }], ['blush', { intensity: 0.8 }]]],
  ],
  shop_flat: [
    ['i just want to feel like myself again.', []],
  ],
  shop_fine: [
    ["which means annalie's first. i've got nothing new to wear.", [['mouth', { shape: 'smile' }]]],
    ["please. i never ask you for anything. i'm asking now.", [['blush', { intensity: 0.7 }], ['look', { dir: 'away' }]]],
  ],
};

export const DEV = {
  talk: ['Talk to her', 'type here, she answers.'],
  hear: ['Her voice', 'on, she says the replies out loud.'],
  hear_off: ['Her voice', 'not on this install right now. text works fine.'],
  mic: ['The mic', 'talk instead of typing.'],
  names: ['Names', 'what she calls you, and what you call her.'],
  memory: ['How she feels', "and below it what she remembers. she can't see this."],
  chats: ['Old chats', 'they live here. new one and search up top.'],
  dates: ['Going out', 'ask her out. she might say no, she does that.'],
  shop: ["Annalie's", 'her colours come back at the shop. you heard her.'],
  shop_flat: ['No game art yet', "she looks like that because it isn't extracted. the install guide has the steps, chat still works."],
  shop_fine: ["Annalie's", 'clothes and colours get changed at the shop. you heard her.'],
  bye: ["That's all", "i'll leave you two to it."],
};
