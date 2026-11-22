import * as ui from '../core/ui.js?v=11';
import { $, active } from './karaoke.js?v=32';
import { instrSource, practice, soloPhase } from './playback.js?v=25';
import { mode, setStatus, track } from './setup.js?v=25';
import { normWord } from './lyrics.js?v=2';
import { api, apiJson } from '../core/api.js?v=1';
import { escapeHtml } from '../core/util.js?v=1';
import { t } from '../core/i18n.js?v=1';

// a sung word can miss its timestamp by 1.25 seconds and
// still count. generous on purpose.
const TOLERANCE = 1.25;
const WEAK_LINE = 0.6;
// mean offsets under this read as on the beat, whisper's own
// word timestamps wobble about that much
const ON_BEAT = 0.12;
let recorder = null, micStream = null;

export async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    ui.toast(t('karaoke.err.micBlocked', '⚠ Mic blocked - no scoring this take'), 'error');
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
  setStatus(t('karaoke.scoring', 'Scoring your take…'));
  try {
    const r = await api('karaoke.php?action=transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: blob,
    });
    if (!r.ok) throw new Error(`transcribe http ${r.status}`);
    const data = await r.json();
    const result = scoreTake(sections, data.words || []);
    renderScore(result, null);
    const history = await saveTake(result);
    if (history) renderScore(result, history);
    rememberTake(result, history);
  } catch (e) {
    console.error(e);
    ui.toast(t('karaoke.err.scoring', '⚠ Scoring failed: {err}', { err: e.message }), 'error');
  } finally {
    setStatus(active && mode === 'solo' && soloPhase === 'jun' && instrSource
      ? t('karaoke.junSolo', "Jun's solo…")
      : '');
  }
}

async function saveTake(r) {
  if (!r.scored || !track) return null;
  try {
    const res = await apiJson('karaoke.php?action=take', {
      song: track.hash, mode, matched: r.matched, total: r.total, offset_ms: msOrNull(r.offset),
      lines: r.breakdown.map(b => ({ i: b.index, matched: b.matched, total: b.total, offset_ms: msOrNull(b.offset) })),
    });
    return res.ok ? await res.json() : null;
  } catch (e) {
    return null;
  }
}

const msOrNull = (seconds) => seconds === null ? null : Math.round(seconds * 1000);
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// nothing on the chat side knows this page exists, so a scored
// take gets written into her durable notes like any other event
// and rides the live context from the next reply on. the date
// goes in spelled out, never "today", she can't do relative time
// at all.
function rememberTake(r, history) {
  if (!r.scored || !track) return;
  const m = track.meta || {};
  const day = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const song = `"${m.title || 'a song'}"` + (m.artist ? ` by ${m.artist}` : '');
  const how = {
    solo: 'solo relay, he sang it through then I did',
    duo: 'a duet, both of us singing the whole song',
    split: 'lines split between us',
  }[mode];
  let memory = `Karaoke with Anon on ${day}: ${song} (${how}). He scored ${r.score}/100, ${r.matched} of ${r.total} of his words landed in time.`;
  if (history?.best && r.score > history.best.score) memory += ` His best on this song so far, up from ${history.best.score}.`;
  apiJson('memory.php', { memory, category: 'events', source: 'karaoke' }).catch(() => {});
}

function scoreTake(sections, user) {
  const userN = user.map(w => ({ t: (w.start + w.end) / 2, w: normWord(w.word), used: false })).filter(u => u.w);
  let matched = 0, total = 0;
  const breakdown = [];
  const offsets = [];
  sections.forEach((sec, idx) => {
    if (sec.owner === 'jun') return;
    const refN = sec.words
      .map((w, wi) => ({ i: wi, t: (w.start + w.end) / 2, w: normWord(w.word) }))
      .filter(r => r.w);
    const hits = new Set();
    const lineOffsets = [];
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
      if (best >= 0) {
        userN[best].used = true;
        m++;
        hits.add(r.i);
        lineOffsets.push(userN[best].t - r.t);
      }
    }
    matched += m; total += refN.length;
    offsets.push(...lineOffsets);
    breakdown.push({
      index: idx,
      owner: sec.owner,
      matched: m,
      total: refN.length,
      offset: lineOffsets.length >= 2 ? mean(lineOffsets) : null,
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
  return { matched, total, score: total ? Math.round(matched / total * 100) : 0, breakdown, scored: total > 0,
    offset: offsets.length >= 5 ? mean(offsets) : null };
}

const SCORE_GRADES = [
  [90, t('karaoke.grade.90', 'she is going to bring this up later')],
  [75, t('karaoke.grade.75', 'you carried that')],
  [60, t('karaoke.grade.60', 'solid - she covered for you on a few')],
  [40, t('karaoke.grade.40', 'you knew the chorus, at least')],
  [20, t('karaoke.grade.20', 'mostly enthusiasm')],
  [0, t('karaoke.grade.0', 'she sang, you watched')],
];

function gradeFor(score) {
  const found = SCORE_GRADES.find(([floor]) => score >= floor);
  return found ? found[1] : SCORE_GRADES[SCORE_GRADES.length - 1][1];
}

function compareLine(r, history) {
  if (!history || !history.best) return '';
  const best = history.best.score;
  if (r.score > best) return t('karaoke.newBest', 'New best on this song, up from {best}', { best });
  if (r.score === best) return t('karaoke.tiesBest', 'Ties your best on this song');
  return t('karaoke.yourBest', 'Your best on this song is {best}', { best })
    + (history.last && history.last.score !== best ? t('karaoke.lastTime', ', last time {score}', { score: history.last.score }) : '');
}

function timingLine(offset) {
  if (offset === null) return '';
  if (Math.abs(offset) < ON_BEAT) return t('karaoke.onBeat', 'On the beat');
  const by = Math.abs(offset).toFixed(1);
  return offset < 0 ? t('karaoke.mostlyEarly', 'Mostly early, by {by}s', { by }) : t('karaoke.mostlyLate', 'Mostly late, by {by}s', { by });
}

const lineTiming = (offset) => offset === null || Math.abs(offset) < 0.25 ? '' : offset < 0 ? t('karaoke.early', 'early') : t('karaoke.late', 'late');

function renderScore(r, history) {
  const box = $('karaokeScore');
  if (!box) return;
  box.hidden = false;
  if (!r.scored) {
    box.innerHTML = `<div class="karaoke-score-num">-</div>
      <div class="karaoke-score-sub">${escapeHtml(t('karaoke.nothingScored', 'nothing of yours to score this take'))}</div>`;
    return;
  }
  const rows = r.breakdown.map(b => {
    const words = b.words.map(w => {
      const cls = !w.scorable ? 'skip' : (w.hit ? 'hit' : 'miss');
      return `<span class="${cls}">${escapeHtml(w.word)}</span>`;
    }).join(' ');
    const timing = lineTiming(b.offset);
    const weak = b.total && b.matched / b.total < WEAK_LINE;
    return `<li><span class="karaoke-score-words">${words}</span>
      <span class="karaoke-score-count">${timing ? `<span class="karaoke-score-timing">${timing}</span>` : ''}${b.matched}/${b.total}</span>`
      + `<span class="karaoke-practice">${weak ? `<button class="karaoke-linkish" type="button" data-section="${b.index}">${escapeHtml(t('karaoke.practice', 'Practice'))}</button>` : ''}</span>`
      + `</li>`;
  }).join('');
  const compare = compareLine(r, history);
  const timing = timingLine(r.offset);
  box.innerHTML = `<div class="karaoke-score-num">${r.score}</div>
    <div class="karaoke-score-grade">${escapeHtml(gradeFor(r.score))}</div>
    <div class="karaoke-score-sub">${escapeHtml(t('karaoke.landed', '{n} of {total} words landed in time', { n: r.matched, total: r.total }))}</div>` +
    (compare || timing ? `<div class="karaoke-score-sub">${[compare, timing].filter(Boolean).join(' · ')}</div>` : '') +
    (rows ? `<ul class="karaoke-score-list">${rows}</ul>` : '');
  box.querySelectorAll('.karaoke-practice button').forEach(btn => {
    btn.addEventListener('click', () => practice(Number(btn.dataset.section)));
  });
}
