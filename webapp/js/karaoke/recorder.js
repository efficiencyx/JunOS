import * as ui from '../core/ui.js?v=1';
import { $, active } from './karaoke.js?v=2';
import { instrSource, soloPhase } from './playback.js?v=2';
import { mode, setStatus, track } from './setup.js?v=2';
import { normWord } from './lyrics.js?v=1';
import { api, apiJson } from '../core/api.js?v=1';
import { escapeHtml } from '../core/util.js?v=1';

// a sung word can miss its timestamp by 1.25 seconds and
// still count. generous on purpose.
const TOLERANCE = 1.25;
let recorder = null, micStream = null;

export async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    ui.toast('⚠ Mic blocked - no scoring this take', 'error');
    return;
  }
  const sections = track.sections.map(section => ({
    ...section,
    words: section.words.map(word => ({ ...word })),
  }));
  const stream = micStream;
  const chunks = [];
  const activeRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  recorder = activeRecorder;
  activeRecorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
  activeRecorder.onstop = () => onRecordingStopped(chunks, sections, stream, activeRecorder);
  activeRecorder.start();
}

export function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  else stopMic();
}

function stopMic(stream = micStream) {
  if (!stream) return;
  stream.getTracks().forEach(t => t.stop());
  if (micStream === stream) micStream = null;
}

async function onRecordingStopped(chunks, sections, stream, activeRecorder) {
  if (recorder === activeRecorder) recorder = null;
  stopMic(stream);
  if (!active || !chunks.length) return;
  const blob = new Blob(chunks, { type: 'audio/webm' });
  setStatus('Scoring your take…');
  try {
    const r = await api('karaoke.php?action=transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: blob,
    });
    if (!r.ok) throw new Error(`transcribe http ${r.status}`);
    const data = await r.json();
    const result = scoreTake(sections, data.words || []);
    renderScore(result);
    rememberTake(result);
  } catch (e) {
    console.error(e);
    ui.toast('⚠ Scoring failed: ' + e.message, 'error');
  } finally {
    setStatus(active && mode === 'solo' && soloPhase === 'jun' && instrSource
      ? "Jun's solo…"
      : '');
  }
}

// nothing on the chat side knows this page exists, so a scored
// take gets written into her durable notes like any other event
// and rides the live context from the next reply on. the date
// goes in spelled out, never "today", she can't do relative time
// at all.
function rememberTake(r) {
  if (!r.scored || !track) return;
  const m = track.meta || {};
  const day = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const song = `"${m.title || 'a song'}"` + (m.artist ? ` by ${m.artist}` : '');
  const how = {
    solo: 'solo relay, he sang it through then I did',
    duo: 'a duet, both of us singing the whole song',
    split: 'lines split between us',
  }[mode];
  const memory = `Karaoke with Anon on ${day}: ${song} (${how}). He scored ${r.score}/100, ${r.matched} of ${r.total} of his words landed in time.`;
  apiJson('memory.php', { memory, category: 'events' }).catch(() => {});
}

function scoreTake(sections, user) {
  const userN = user.map(w => ({ t: (w.start + w.end) / 2, w: normWord(w.word), used: false })).filter(u => u.w);
  let matched = 0, total = 0;
  const breakdown = [];
  sections.forEach((sec, idx) => {
    if (sec.owner === 'jun') return;
    const refN = sec.words
      .map((w, wi) => ({ i: wi, t: (w.start + w.end) / 2, w: normWord(w.word) }))
      .filter(r => r.w);
    const hits = new Set();
    let m = 0;
    for (const r of refN) {
      let best = -1, bestDt = Infinity;
      for (let i = 0; i < userN.length; i++) {
        const u = userN[i];
        if (u.used || u.w !== r.w) continue;
        if (u.t < sec.start - TOLERANCE || u.t > sec.end + TOLERANCE) continue;
        const dt = Math.abs(u.t - r.t);
        if (dt <= TOLERANCE && dt < bestDt) { best = i; bestDt = dt; }
      }
      if (best >= 0) { userN[best].used = true; m++; hits.add(r.i); }
    }
    matched += m; total += refN.length;
    if (sec.owner === 'you') breakdown.push({
      index: idx,
      owner: sec.owner,
      matched: m,
      total: refN.length,
      // words that normalise to nothing are punctuation-only and were
      // never scorable, so they render plain instead of as something
      // you missed
      words: sec.words.map((w, wi) => ({
        word: w.word,
        scorable: !!normWord(w.word),
        hit: hits.has(wi),
      })),
    });
  });
  return { matched, total, score: total ? Math.round(matched / total * 100) : 0, breakdown, scored: total > 0 };
}

const SCORE_GRADES = [
  [90, 'she is going to bring this up later'],
  [75, 'you carried that'],
  [60, 'solid - she covered for you on a few'],
  [40, 'you knew the chorus, at least'],
  [20, 'mostly enthusiasm'],
  [0, 'she sang, you watched'],
];

function gradeFor(score) {
  const found = SCORE_GRADES.find(([floor]) => score >= floor);
  return found ? found[1] : SCORE_GRADES[SCORE_GRADES.length - 1][1];
}

function renderScore(r) {
  const box = $('karaokeScore');
  if (!box) return;
  box.hidden = false;
  if (!r.scored) {
    box.innerHTML = `<div class="karaoke-score-num">-</div>
      <div class="karaoke-score-sub">nothing of yours to score this take</div>`;
    return;
  }
  const rows = r.breakdown.map(b => {
    const words = b.words.map(w => {
      const cls = !w.scorable ? 'skip' : (w.hit ? 'hit' : 'miss');
      return `<span class="${cls}">${escapeHtml(w.word)}</span>`;
    }).join(' ');
    return `<li><span class="karaoke-score-words">${words}</span>
      <span class="karaoke-score-count">${b.matched}/${b.total}</span></li>`;
  }).join('');
  box.innerHTML = `<div class="karaoke-score-num">${r.score}</div>
    <div class="karaoke-score-grade">${escapeHtml(gradeFor(r.score))}</div>
    <div class="karaoke-score-sub">${r.matched} of ${r.total} words landed in time</div>` +
    (rows ? `<ul class="karaoke-score-list">${rows}</ul>` : '');
}
