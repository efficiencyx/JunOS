import { apiGet } from '../core/api.js?v=1';
import { escapeHtml } from '../core/util.js?v=1';

const GAUGES = ['affection', 'trust', 'tension'];
const ROW_H = 40;
const VIEW_W = 1000;
const EVENT_LABELS = { walkout: 'Walked out', 'outing:shop': 'Shopping', 'outing:karaoke': 'Karaoke', 'outing:date': 'Ate out', 'outing:cards': 'Blackjack' };

const root = document.getElementById('relTimeline');
let points = [];

const fmt = (at) => new Date(at * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const day = (at) => new Date(at * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });
const eventLabel = (e) => EVENT_LABELS[e] || e;

// the gauges hold their value until the next change, so steps,
// not slopes
function stepPath(key, xOf) {
  let d = '';
  points.forEach((p, i) => {
    const x = xOf(p.at).toFixed(1);
    const y = (ROW_H - 4 - p[key] / 100 * (ROW_H - 8)).toFixed(1);
    d += i === 0 ? `M${x},${y}` : `H${x}V${y}`;
  });
  return d + `H${VIEW_W}`;
}

function render() {
  if (!root) return;
  if (points.length < 2) {
    root.innerHTML = '<div class="set-row-desc">Nothing yet. It fills in as her gauges move.</div>';
    return;
  }
  const t0 = points[0].at, t1 = points[points.length - 1].at;
  const span = Math.max(1, t1 - t0);
  const xOf = (at) => (at - t0) / span * VIEW_W;
  const events = points.filter(p => p.event);

  const rows = GAUGES.map(key => `
    <div class="rel-tl-row rel-tl-row--${key}">
      <span class="rel-tl-label">${key[0].toUpperCase() + key.slice(1)}</span>
      <svg class="rel-tl-plot" viewBox="0 0 ${VIEW_W} ${ROW_H}" preserveAspectRatio="none" aria-hidden="true">
        <line class="rel-tl-mid" x1="0" x2="${VIEW_W}" y1="${ROW_H / 2}" y2="${ROW_H / 2}"/>
        <path class="rel-tl-line" d="${stepPath(key, xOf)}"/>
      </svg>
    </div>`).join('');
  const marks = events.map(p => `<span class="rel-tl-event" data-kind="${p.event === 'walkout' ? 'walkout' : 'outing'}" style="left:${(xOf(p.at) / VIEW_W * 100).toFixed(2)}%" title="${escapeHtml(eventLabel(p.event) + ', ' + fmt(p.at))}"></span>`).join('');
  const first = points[0], last = points[points.length - 1];
  const summary = `From ${fmt(t0)} to ${fmt(t1)}: `
    + GAUGES.map(k => `${k} ${first[k]} to ${last[k]}`).join(', ') + '. '
    + (events.length ? events.map(p => `${eventLabel(p.event)} ${fmt(p.at)}`).join('; ') + '.' : 'No outings or walkouts.');

  root.innerHTML = `
    <div class="rel-tl-plots">
      ${rows}
      <div class="rel-tl-events" aria-hidden="true">${marks}</div>
      <div class="rel-tl-cursor" hidden></div>
      <div class="rel-tl-tip" hidden></div>
    </div>
    <div class="rel-tl-axis" aria-hidden="true"><span>${day(t0)}</span><span>${day(t1)}</span></div>
    <p class="sr-only">${escapeHtml(summary)}</p>`;
  wireHover(root.querySelector('.rel-tl-plots'), t0, span);
}

// nearest stored change at or before the cursor, that's what the
// gauges read at that moment
function wireHover(plots, t0, span) {
  const cursor = plots.querySelector('.rel-tl-cursor');
  const tip = plots.querySelector('.rel-tl-tip');
  plots.addEventListener('pointermove', (e) => {
    const svg = plots.querySelector('.rel-tl-plot').getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - svg.left) / svg.width));
    const at = t0 + frac * span;
    let p = points[0];
    for (const q of points) { if (q.at <= at) p = q; else break; }
    const left = svg.left - plots.getBoundingClientRect().left + frac * svg.width;
    cursor.hidden = tip.hidden = false;
    cursor.style.left = left + 'px';
    tip.innerHTML = `<div class="rel-tl-tip-time">${fmt(p.at)}</div>`
      + GAUGES.map(k => `<div><span class="rel-tl-key rel-tl-key--${k}"></span>${k} <b>${p[k]}</b></div>`).join('')
      + (p.event ? `<div class="rel-tl-tip-event">${escapeHtml(eventLabel(p.event))}</div>` : '');
    const right = left > plots.clientWidth / 2;
    tip.style.left = right ? '' : (left + 10) + 'px';
    tip.style.right = right ? (plots.clientWidth - left + 10) + 'px' : '';
  });
  plots.addEventListener('pointerleave', () => { cursor.hidden = tip.hidden = true; });
}

export async function loadTimeline() {
  if (!root) return;
  const rows = await apiGet('relationship.php?action=history');
  points = Array.isArray(rows) ? rows : [];
  render();
}
