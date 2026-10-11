// the rank emblems. one 64x64 family, each tier adds a layer the
// one below it doesn't have: bronze is a plain medallion, silver
// turns it into a shield, gold puts wings and a crown on that,
// diamond drops the shield and the cut gem IS the emblem, on
// platinum wings with the bronze/silver chevron back underneath.
// tier 0 is the empty socket.
//
// gradient ids get a per-call suffix. two inline svgs with the
// same id and url(#id) resolves to whichever came first in the
// document, and if THAT one sits in a display:none subtree the
// gradient just doesn't paint. in chrome AND firefox. cool.

export const TIER_NAMES = ['Bronze', 'Silver', 'Gold', 'Diamond'];

let seq = 0;

const lin = (id, stops, x2 = 0, y2 = 1) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient>`;

const sparkle = (x, y, r, fill) =>
  `<path d="M${x} ${y - r}L${x + r * 0.28} ${y - r * 0.28}L${x + r} ${y}L${x + r * 0.28} ${y + r * 0.28}L${x} ${y + r}L${x - r * 0.28} ${y + r * 0.28}L${x - r} ${y}L${x - r * 0.28} ${y - r * 0.28}Z" fill="${fill}"/>`;

function socket(u, locked) {
  return `<circle cx="32" cy="32" r="21" fill="currentColor" fill-opacity=".05" stroke="currentColor" stroke-opacity=".32" stroke-width="1.4" stroke-dasharray="3.2 2.6"/>
<circle cx="32" cy="32" r="15" fill="currentColor" fill-opacity=".06"/>
${locked
    ? '<circle cx="32" cy="29" r="4.2" fill="currentColor" fill-opacity=".42"/><path d="M29.6 31.5L28.4 40.5H35.6L34.4 31.5Z" fill="currentColor" fill-opacity=".42"/>'
    : '<path d="M24 34.5L32 28L40 34.5V38.5L32 32L24 38.5Z" fill="currentColor" fill-opacity=".22"/>'}`;
}

function bronze(u) {
  return `<defs>
${lin(`rim${u}`, [[0, '#f6c896'], [0.45, '#c47a3f'], [1, '#6e3a17']])}
${lin(`face${u}`, [[0, '#7f4520'], [0.55, '#ad6833'], [1, '#d99a63']])}
${lin(`mark${u}`, [[0, '#ffe6c8'], [1, '#e2a066']])}
</defs>
<circle cx="32" cy="32" r="21.5" fill="url(#rim${u})" stroke="#4f2810" stroke-opacity=".55" stroke-width=".8"/>
<circle cx="32" cy="32" r="16.5" fill="url(#face${u})"/>
<circle cx="32" cy="32" r="16.5" fill="none" stroke="#ffd9b0" stroke-opacity=".38" stroke-width=".8"/>
<path d="M23 35.5L32 28L41 35.5V40L32 32.5L23 40Z" fill="#5a2c10" fill-opacity=".45" transform="translate(0 1)"/>
<path d="M23 35.5L32 28L41 35.5V40L32 32.5L23 40Z" fill="url(#mark${u})"/>
<path d="M16.5 27A16 16 0 0 1 39.5 13.5" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="1.6" stroke-linecap="round"/>`;
}

function silver(u) {
  return `<defs>
${lin(`rim${u}`, [[0, '#ffffff'], [0.35, '#cad3dc'], [0.7, '#8894a3'], [1, '#4c5866']], 1, 1)}
${lin(`face${u}`, [[0, '#56626f'], [0.6, '#8c98a6'], [1, '#b9c3cd']])}
${lin(`mark${u}`, [[0, '#ffffff'], [1, '#c3ccd6']])}
</defs>
<path d="M32 5L53 12.5V30C53 43.5 44 53 32 59C20 53 11 43.5 11 30V12.5Z" fill="url(#rim${u})" stroke="#323b45" stroke-opacity=".6" stroke-width=".8"/>
<path d="M32 10.5L48 16.3V30C48 40.8 41 48.5 32 53.2C23 48.5 16 40.8 16 30V16.3Z" fill="url(#face${u})"/>
<path d="M32 10.5V53.2C23 48.5 16 40.8 16 30V16.3Z" fill="#fff" fill-opacity=".12"/>
<path d="M32 10.5L48 16.3V30C48 40.8 41 48.5 32 53.2C23 48.5 16 40.8 16 30V16.3Z" fill="none" stroke="#f4f7fa" stroke-opacity=".45" stroke-width=".7"/>
<g fill="#2c343d" fill-opacity=".4" transform="translate(0 1)">
<path d="M22 26L32 19L42 26V31L32 24L22 31Z"/><path d="M22 36L32 29L42 36V41L32 34L22 41Z"/>
</g>
<g fill="url(#mark${u})">
<path d="M22 26L32 19L42 26V31L32 24L22 31Z"/><path d="M22 36L32 29L42 36V41L32 34L22 41Z"/>
</g>
<g fill="#f2f5f8" stroke="#3a434d" stroke-opacity=".5" stroke-width=".4">
<circle cx="13.6" cy="14.4" r="1.15"/><circle cx="50.4" cy="14.4" r="1.15"/><circle cx="32" cy="56.2" r="1.15"/>
</g>
<path d="M14 15.5L31 9.2" stroke="#fff" stroke-opacity=".7" stroke-width="1.1" stroke-linecap="round"/>`;
}

function gold(u) {
  const wings = `<path d="M15 18C8 17 3.5 21 2.5 27C7 25 11 25 15 26Z"/>
<path d="M15 26C8 26 4 31 4 37C8 34 11.5 33.5 15.5 34Z"/>
<path d="M16 34C10 35 7 40 8 45.5C11.5 42 14 41 17.5 41Z"/>`;
  const star = 'M32 23L34.47 29.6L41.51 29.91L36 34.3L37.88 41.09L32 37.2L26.12 41.09L28 34.3L22.49 29.91L29.53 29.6Z';
  return `<defs>
${lin(`gold${u}`, [[0, '#fff4b8'], [0.3, '#ffd44f'], [0.65, '#dc9c0c'], [1, '#875300']])}
${lin(`face${u}`, [[0, '#6a3f00'], [0.55, '#a8730a'], [1, '#e0aa28']])}
${lin(`wing${u}`, [[0, '#ffe680'], [1, '#b87808']], 1, 0)}
${lin(`star${u}`, [[0, '#fffdf0'], [1, '#ffd24a']])}
<radialGradient id="ruby${u}" cx=".35" cy=".35" r=".75"><stop offset="0" stop-color="#ffc2c8"/><stop offset=".45" stop-color="#e3233f"/><stop offset="1" stop-color="#5e0010"/></radialGradient>
<radialGradient id="glow${u}"><stop offset="0" stop-color="#fff2a8" stop-opacity=".75"/><stop offset="1" stop-color="#fff2a8" stop-opacity="0"/></radialGradient>
</defs>
<g fill="url(#wing${u})" stroke="#7a4c00" stroke-opacity=".55" stroke-width=".6">
<g>${wings}</g><g transform="translate(64 0) scale(-1 1)">${wings}</g>
</g>
<path d="M32 9L50 15V31.5C50 44 42 52.5 32 58C22 52.5 14 44 14 31.5V15Z" fill="url(#gold${u})" stroke="#6b4100" stroke-opacity=".6" stroke-width=".8"/>
<path d="M32 13.8L45.5 18.4V31.5C45.5 41.6 39.4 48.4 32 52.6C24.6 48.4 18.5 41.6 18.5 31.5V18.4Z" fill="url(#face${u})"/>
<path d="M32 13.8V52.6C24.6 48.4 18.5 41.6 18.5 31.5V18.4Z" fill="#fff" fill-opacity=".1"/>
<path d="M32 13.8L45.5 18.4V31.5C45.5 41.6 39.4 48.4 32 52.6C24.6 48.4 18.5 41.6 18.5 31.5V18.4Z" fill="none" stroke="#ffe9a0" stroke-opacity=".5" stroke-width=".7"/>
<circle cx="32" cy="33" r="13" fill="url(#glow${u})"/>
<path d="${star}" fill="#4a2c00" fill-opacity=".45" transform="translate(0 1)"/>
<path d="${star}" fill="url(#star${u})" stroke="#9a6500" stroke-width=".5"/>
<path d="M32 23L32 37.2L26.12 41.09L28 34.3L22.49 29.91L29.53 29.6Z" fill="#fff" fill-opacity=".28"/>
<path d="M21.5 13.4L23.5 5.5L27.8 9.6L32 2.5L36.2 9.6L40.5 5.5L42.5 13.4Z" fill="url(#gold${u})" stroke="#6b4100" stroke-opacity=".6" stroke-width=".6" stroke-linejoin="round"/>
<rect x="21" y="11.6" width="22" height="3.4" rx="1.2" fill="url(#gold${u})" stroke="#6b4100" stroke-opacity=".6" stroke-width=".6"/>
<g fill="#fff6d0"><circle cx="23.5" cy="5.5" r="1.3"/><circle cx="32" cy="2.6" r="1.4"/><circle cx="40.5" cy="5.5" r="1.3"/></g>
<circle cx="32" cy="13.3" r="1.9" fill="url(#ruby${u})" stroke="#5e0010" stroke-opacity=".5" stroke-width=".4"/>
<path d="M18 19.6L27.5 16.2" stroke="#fff" stroke-opacity=".55" stroke-width="1" stroke-linecap="round"/>
${sparkle(53.5, 9.5, 4, '#fff8d6')}`;
}

function diamond(u) {
  const wing = `<g fill="url(#plat${u})" stroke="#1c2540" stroke-opacity=".6" stroke-width=".5" stroke-linejoin="round">
<path d="M23 23L1.5 9.5L5.5 18.5L22 29.5Z"/><path d="M22 28.5L2.5 22.5L7 29L22 33.5Z"/><path d="M22.5 33L5.5 34L11 39.5L23.5 37.5Z"/>
</g>
<path d="M21 25L4 12.5M20.5 30.5L5 23.5M21.5 35L8.5 35.5" stroke="#fff" stroke-opacity=".7" stroke-width=".45"/>`;
  const facets = [
    ['M17 25.7L23 14.5L27.2 25.7Z', '#c9f3ff'],
    ['M23 14.5L32 14.5L27.2 25.7Z', '#effdff'],
    ['M32 14.5L41 14.5L36.8 25.7Z', '#b2eaff'],
    ['M27.2 25.7L32 14.5L36.8 25.7Z', '#ffffff'],
    ['M41 14.5L47 25.7L36.8 25.7Z', '#86d6fb'],
    ['M17 25.7L27.2 25.7L32 49.5Z', '#7ccdf7'],
    ['M27.2 25.7L36.8 25.7L32 49.5Z', '#3f9fe8'],
    ['M36.8 25.7L47 25.7L32 49.5Z', '#2463c4'],
  ];
  return `<defs>
${lin(`plat${u}`, [[0, '#ffffff'], [0.35, '#e1e8f2'], [0.7, '#9ba8bd'], [1, '#56627a']], 1, 1)}
<radialGradient id="glow${u}"><stop offset="0" stop-color="#9fe6ff" stop-opacity=".55"/><stop offset="1" stop-color="#9fe6ff" stop-opacity="0"/></radialGradient>
</defs>
<g>${wing}</g><g transform="translate(64 0) scale(-1 1)">${wing}</g>
<circle cx="32" cy="31" r="19" fill="url(#glow${u})"/>
${facets.map(([d, c]) => `<path d="${d}" fill="${c}"/>`).join('')}
<path d="M23 14.5H41L47 25.7L32 49.5L17 25.7Z" fill="none" stroke="#eafbff" stroke-width=".6" stroke-linejoin="round"/>
<path d="M17 25.7H47" stroke="#eafbff" stroke-opacity=".7" stroke-width=".4"/>
<path d="M23 50.5L32 59.5L41 50.5H37.4L32 55.6L26.6 50.5Z" fill="url(#plat${u})" stroke="#1c2540" stroke-opacity=".6" stroke-width=".5" stroke-linejoin="round"/>
<path d="M25.5 12.5L27 5.5L29.8 8.6L32 3L34.2 8.6L37 5.5L38.5 12.5Z" fill="url(#plat${u})" stroke="#1c2540" stroke-opacity=".6" stroke-width=".5" stroke-linejoin="round"/>
${sparkle(39.5, 17.5, 3.4, '#ffffff')}`;
}

const ART = [socket, bronze, silver, gold, diamond];

// tier 0-4. label makes it role=img with a <title>, without one
// it's decoration and screen readers skip it
export function emblem(tier, { size = 48, label = '', locked = false, className = '' } = {}) {
  const t = Math.max(0, Math.min(4, tier | 0));
  const u = '-e' + (++seq);
  const a11y = label
    ? `role="img" aria-labelledby="t${u}"><title id="t${u}">${label}</title>`
    : 'aria-hidden="true" focusable="false">';
  return `<svg class="emblem emblem-${t}${className ? ' ' + className : ''}" width="${size}" height="${size}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" ${a11y}${ART[t](u, locked)}</svg>`;
}
