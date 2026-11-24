import { t } from './i18n.js?v=2';
// the gauge bucketing, shared by her face and by the chat copy.
// it sits out here so both read the SAME tier off the same
// numbers. two copies of this arithmetic and the greeting
// cheerfully tells you she's fine while she's sitting there
// terrified.

// warmth goes -1 (cold) to 1 (adoring). fear goes 0 to 1 once
// tension passes 45
export function moodFactors(mood) {
  const warmth = ((mood.affection + mood.trust) / 2 - 50) / 50;
  const fear = Math.max(0, (mood.tension - 45) / 55);
  return { warmth, fear };
}

export function moodTier(mood) {
  const { warmth, fear } = moodFactors(mood);
  if (fear >= 0.45) return 'scared';
  if (fear > 0) return 'nervous';
  if (warmth >= 0.4) return 'happy';
  if (warmth <= -0.4) return 'upset';
  return 'neutral';
}

// one gauge into the 0/1/2 bucket the wardrobe line tables are
// keyed on
export function gaugeTier(v) {
  return v < 34 ? 0 : v < 67 ? 1 : 2;
}

const MOOD_PHRASES = {
  affection: [
    [90, t('jun.mood.affection.90', 'i\'m completely yours')], [80, t('jun.mood.affection.80', 'i love you so much')], [70, t('jun.mood.affection.70', 'i love you')],
    [60, t('jun.mood.affection.60', 'i\'m so happy with you')], [50, t('jun.mood.affection.50', 'i really like you')], [40, t('jun.mood.affection.40', 'i like being with you')],
    [30, t('jun.mood.affection.30', 'you\'re growing on me')], [20, t('jun.mood.affection.20', 'you seem nice')], [10, t('jun.mood.affection.10', 'still getting to know you')],
    [0, t('jun.mood.affection.0', 'who are you again?')],
  ],
  trust: [
    [90, t('jun.mood.trust.90', 'i\'d trust you with anything')], [80, t('jun.mood.trust.80', 'i trust you completely')], [70, t('jun.mood.trust.70', 'i trust you')],
    [60, t('jun.mood.trust.60', 'i\'m starting to rely on you')], [50, t('jun.mood.trust.50', 'i want to trust you')], [40, t('jun.mood.trust.40', 'i\'m still a little guarded')],
    [30, t('jun.mood.trust.30', 'i\'m not sure about you yet')], [20, t('jun.mood.trust.20', 'you\'ll have to earn it')], [10, t('jun.mood.trust.10', 'i barely know you')],
    [0, t('jun.mood.trust.0', 'i don\'t trust you')],
  ],
  tension: [
    [90, t('jun.mood.tension.90', 'i\'m terrified')], [80, t('jun.mood.tension.80', 'i\'m really scared')], [70, t('jun.mood.tension.70', 'i\'m scared')],
    [60, t('jun.mood.tension.60', 'this is too much')], [50, t('jun.mood.tension.50', 'i\'m on edge')], [40, t('jun.mood.tension.40', 'a little tense')],
    [30, t('jun.mood.tension.30', 'slightly uneasy')], [20, t('jun.mood.tension.20', 'mostly calm')], [10, t('jun.mood.tension.10', 'i feel relaxed')],
    [0, t('jun.mood.tension.0', 'totally at ease')],
  ],
};
export function moodPhrase(gauge, value) {
  const band = (MOOD_PHRASES[gauge] || []).find(([min]) => value >= min);
  return band ? band[1] : '';
}

export function daypart(d) {
  const h = (d || new Date()).getHours();
  if (h < 5) return 'night';
  if (h < 11) return 'morning';
  if (h < 18) return 'day';
  if (h < 23) return 'evening';
  return 'night';
}
