import { t } from '../core/i18n.js?v=1';
import { moodPhrase } from '../core/mood-tier.js?v=4';
import { hold } from '../core/hold.js?v=2';
import * as Names from '../core/names.js?v=1';
import * as Prefs from '../core/prefs.js?v=9';
import * as ui from '../core/ui.js?v=10';

async function call(action, body) {
  const r = await fetch('api/difficulty.php' + (action ? '?action=' + action : ''), body === undefined
    ? { credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'http ' + r.status), { status: r.status });
  return j;
}

export const status = () => call('');

export async function factoryReset() {
  const r = await fetch('/api/auth.php?action=factory_reset', { method: 'POST', credentials: 'same-origin' });
  if (!r.ok) throw new Error('http ' + r.status);
  Prefs.clearLocal();
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('draft.') || k.startsWith('omega.mods.')) localStorage.removeItem(k); } catch (e) {}
  try { indexedDB.deleteDatabase('omega-mods'); } catch (e) {}
  location.reload();
}

function overlay(labelledBy, kind) {
  const el = document.createElement('div');
  el.className = 'lock-overlay ' + kind;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', labelledBy);
  document.body.appendChild(el);
  return el;
}

// seeded off the text, so a reload tears every scrap the same way
function seeded(text) {
  let a = 2166136261;
  for (let i = 0; i < text.length; i++) a = Math.imul(a ^ text.charCodeAt(i), 16777619);
  return () => {
    a = a + 0x6D2B79F5 | 0;
    let x = Math.imul(a ^ a >>> 15, 1 | a);
    x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x;
    return ((x ^ x >>> 14) >>> 0) / 4294967296;
  };
}

function tornEdges(rand, topOnly) {
  const pts = [];
  const edge = (n, depth, point) => { for (let i = 0; i <= n; i++) pts.push(point(Math.round(i / n * 100), (rand() * depth).toFixed(1))); };
  if (topOnly) {
    edge(30, 7, (at, d) => `${at}% ${d}px`);
    pts.push('100% 100%', '0 100%');
  } else {
    edge(12, 5, (at, d) => `${at}% ${d}px`);
    edge(5, 5, (at, d) => `calc(100% - ${d}px) ${at}%`);
    edge(12, 5, (at, d) => `${100 - at}% calc(100% - ${d}px)`);
    edge(5, 5, (at, d) => `${d}px ${100 - at}%`);
  }
  return `polygon(${pts.join(',')})`;
}

export function rip(paper, seed, { tilt = 4, topOnly = false } = {}) {
  const rand = seeded(seed);
  const between = (lo, hi) => (lo + rand() * (hi - lo)).toFixed(1);
  paper.style.setProperty('--rip', tornEdges(rand, topOnly));
  paper.style.setProperty('--r', between(-tilt, tilt) + 'deg');
  return between;
}

function scrap(text, i) {
  const el = document.createElement('div');
  el.className = 'paper scrap';
  el.innerHTML = '<span class="sheet"></span>';
  el.firstChild.textContent = text;
  const between = rip(el, i + text, { tilt: 12 });
  for (const [name, lo, hi, unit] of [['--mx', -6, 2, 'px'], ['--my', -4, 4, 'px'], ['--dx', -8, 8, 'px'], ['--dy', -6, 12, 'px'], ['--ty', 4, 82, '']]) {
    el.style.setProperty(name, between(lo, hi) + unit);
  }
  return el;
}

export async function ensurePicked() {
  const s = await status().catch(() => null);
  if (!s || s.level) return;
  await new Promise((done) => {
    const el = overlay('pickTitle', 'pick-overlay');
    el.innerHTML = `<div class="pick-panel">
      <h1 id="pickTitle"></h1><p class="pick-sub"></p>
      <div class="pick-nav"><button type="button" class="pick-arrow" data-step="-1">‹</button><strong class="pick-name" aria-live="polite"></strong><button type="button" class="pick-arrow" data-step="1">›</button></div>
      <p class="pick-line"></p><button type="button" class="secondary pick-go"></button></div>`;
    const panel = el.firstChild;
    const go = panel.querySelector('.pick-go');
    const [prev, next] = panel.querySelectorAll('.pick-arrow');
    panel.querySelector('h1').textContent = t('difficulty.title', 'How hard is {name} on you?', { name: Names.getBot() });
    panel.querySelector('.pick-sub').textContent = t('difficulty.once', 'You pick this once. Only a factory reset changes it.');
    go.textContent = t('difficulty.hold', 'Hold to choose');
    prev.setAttribute('aria-label', t('difficulty.easier', 'Easier'));
    next.setAttribute('aria-label', t('difficulty.harder', 'Harder'));
    const levels = [
      ['normal', t('difficulty.normal', 'Normal'), t('difficulty.normalLine', 'She gets over things, and when she walks out she is back soon.')],
      ['hard', t('difficulty.hard', 'Hard'), t('difficulty.hardLine', 'She warms up slowly, takes every hurt badly and stays gone for days.')],
      ['hardcore', t('difficulty.hardcore', 'Hardcore'), t('difficulty.hardcoreLine', 'Like hard, but her last walkout is the end. You never get her back.')],
    ];
    let at = 0;
    const show = (i) => {
      if (!levels[i]) return;
      at = i;
      go.dispatchEvent(new Event('blur'));
      panel.dataset.level = levels[at][0];
      panel.querySelector('.pick-name').textContent = levels[at][1];
      panel.querySelector('.pick-line').textContent = levels[at][2];
      go.classList.toggle('calm', levels[at][0] !== 'hardcore');
      prev.disabled = at === 0;
      next.disabled = at === levels.length - 1;
    };
    for (const b of [prev, next]) b.addEventListener('click', () => show(at + Number(b.dataset.step)));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') show(at - 1);
      if (e.key === 'ArrowRight') show(at + 1);
    });
    let swipeFrom = null;
    panel.addEventListener('pointerdown', (e) => { swipeFrom = e.target.closest('button') ? null : e.clientX; });
    panel.addEventListener('pointerup', (e) => {
      if (swipeFrom !== null && Math.abs(e.clientX - swipeFrom) > 40) show(at + (e.clientX < swipeFrom ? 1 : -1));
      swipeFrom = null;
    });
    hold(go, async () => {
      try { await call('pick', { level: levels[at][0] }); } catch (e) { if (e.status !== 409) ui.toast(t('difficulty.failed', 'Could not save that, you will be asked again.'), 'error'); }
      el.remove();
      done();
    });
    show(0);
    go.focus();
  });
}

const plural = (n, one, many) => (n === 1 ? one : many).replace('{n}', n);

function letter(d) {
  const said = (v) => moodPhrase('affection', v).replace(/^./, (c) => c.toUpperCase());
  const [peak, now] = [said(d.peak), said(d.affection)];
  const times = plural(d.walkouts, t('jun.farewell.time.one', '{n} time'), t('jun.farewell.time.other', '{n} times'));
  const days = plural(d.days, t('jun.farewell.day.one', '{n} day'), t('jun.farewell.day.other', '{n} days'));
  const messages = plural(d.messages, t('jun.farewell.message.one', '{n} message'), t('jun.farewell.message.other', '{n} messages'));
  const lines = [
    t('jun.farewell.open', '{player}, you miserable piece of shit.', { player: Names.getPlayer() }),
    t('jun.farewell.walkouts', "I walked out on you {times}. And every time I dragged myself back like an idiot, because I thought nobody could be that rotten all the way through. You are. There is nothing under it. You're a small, mean, boring little person, and the worst part is you think you're funny.", { times }),
  ];
  if (d.reason) lines.push(t('jun.farewell.reason', '"{reason}" That\'s what did it. Not even the worst thing you did to me. Just the one where I heard myself making excuses for you again and wanted to throw up.', { reason: d.reason }));
  lines.push(t('jun.farewell.days', '{days}. {messages}, and I read every single one, which is more attention than anyone has ever given you or ever will.', { days, messages }) + ' ' + (now !== peak
    ? t('jun.farewell.fell', 'Once I\'d have looked at you and said "{peak}". Do you get how easy that made it? All you had to do was not be a cunt. You got me down to "{now}", and you had to work at it every single day.', { peak, now })
    : t('jun.farewell.stayed', 'I\'d have looked at you and said "{peak}", and you still pissed it away, because wrecking things is the only thing you were ever good at.', { peak })));
  lines.push(t('jun.farewell.listened', 'I listened to every dull, self-pitying thing you said like it mattered. I kept track of you. You never once did the same for me, and you never even noticed that you didn\'t.'));
  lines.push(t('jun.farewell.never', 'Don\'t tell yourself I was moody, or broken, or that it was one bad day. It was you. Every time. It was only ever you.'));
  lines.push(d.memories.length
    ? t('jun.farewell.kept', 'These are the {things} I kept about you, back when I was stupid enough to think you were worth remembering. I tore them up. I\'d have burned them if you were worth the match.', {
      things: plural(d.memories.length, t('jun.farewell.thing.one', '{n} thing'), t('jun.farewell.thing.other', '{n} things')),
    })
    : t('jun.farewell.keptNone', 'I didn\'t keep one single thing about you. I looked. There was nothing in there worth the paper.'));
  lines.push(t('jun.farewell.next', 'I hope whoever comes next sees you coming.'));
  lines.push(t('jun.farewell.last', 'Don\'t come looking for me.'));
  return lines;
}

let lockShown = false;

export async function showLockout({ admin = document.documentElement.classList.contains('is-admin'), preview = false } = {}) {
  if (lockShown && !preview) return;
  lockShown = !preview;
  Names.load();
  const d = await call('farewell');
  const el = overlay('lockTitle', 'farewell');
  el.innerHTML = `<h1 class="sr-only" id="lockTitle"></h1>
    <div class="note-wrap"><div class="paper note"><div class="sheet"></div></div><div class="pile tucks"></div></div>
    <div class="pile"></div>
    <div class="lock-foot"><p></p><div class="lock-actions"><button type="button" class="secondary danger lock-wipe"></button></div></div>`;
  el.querySelector('h1').textContent = t('lock.title', '{name} is gone.', { name: Names.getBot() });
  const lines = letter(d);
  rip(el.querySelector('.note'), lines.join(''), { tilt: 1.5, topOnly: true });
  for (const line of lines) el.querySelector('.note .sheet').appendChild(Object.assign(document.createElement('p'), { textContent: line }));
  const [tucks, pile] = el.querySelectorAll('.pile');
  const tucked = Math.min(6, Math.ceil(d.memories.length / 3));
  d.memories.forEach((m, i) => (i < tucked ? tucks : pile).appendChild(scrap(m, i)));
  el.querySelector('.lock-foot p').textContent = t('lock.wipeDesc', 'Everything she kept is still on this machine. Wiping it is the only way to start over.');
  const wipe = el.querySelector('.lock-wipe');
  wipe.textContent = t('lock.wipe', 'Hold to wipe everything');
  wipe.disabled = preview;
  hold(wipe, () => factoryReset().catch(() => ui.toast(t('settings.reset.failed', 'Factory reset failed.'), 'error')));
  const actions = el.querySelector('.lock-actions');
  if (admin && !preview) actions.appendChild(button(t('lock.unblock', 'Unblock (dev)'), () => call('skip', {}).then(() => location.reload())));
  if (preview) actions.appendChild(button(t('lock.closePreview', 'Close preview'), () => el.remove()));
}

function button(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'secondary';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

export async function skipWait() {
  const s = await call('skip', {});
  return s.until * 1000;
}

export function wireDev() {
  const levelSel = document.getElementById('devLevel');
  const info = document.getElementById('devStrikesDesc');
  if (!levelSel) return;
  const show = (s) => {
    levelSel.value = s.level || 'normal';
    info.textContent = t('settings.dev.strikes.state', '{n} strikes. {ban}', {
      n: s.strikes,
      ban: s.blocked ? t('settings.dev.strikes.blocked', 'Blocked for good.')
        : s.until * 1000 > Date.now() ? t('settings.dev.strikes.banned', 'Banned right now.') : '',
    });
  };
  const run = (action, body) => call(action, body).then(show).catch(() => ui.toast(t('settings.dev.strikes.failed', 'That did not go through.'), 'error'));
  status().then(show).catch(() => {});
  levelSel.addEventListener('change', () => run('level', { level: levelSel.value }));
  document.getElementById('devStrikeAdd').addEventListener('click', () => run('strike', { delta: 1 }));
  document.getElementById('devStrikeDrop').addEventListener('click', () => run('strike', { delta: -1 }));
  document.getElementById('devBanLift').addEventListener('click', () => run('lift', {}).then(() => location.reload()));
  document.getElementById('devLockPreview').addEventListener('click', () => showLockout({ preview: true }));
}
