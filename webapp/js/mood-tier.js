// the gauge bucketing, shared by her face and by the chat copy. it sits out
// here so both read the SAME tier off the same numbers. two copies of this
// arithmetic and the greeting cheerfully tells you she's fine while she's
// sitting there terrified.

// warmth: -1 (cold) .. 1 (adoring); fear: 0 .. 1 once tension passes 45
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

export function daypart(d) {
  const h = (d || new Date()).getHours();
  if (h < 5) return 'night';
  if (h < 11) return 'morning';
  if (h < 18) return 'day';
  if (h < 23) return 'evening';
  return 'night';
}
