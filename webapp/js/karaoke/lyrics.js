import { api } from '../core/api.js?v=1';

export const normWord = (w) => (w || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function parseLrc(text) {
  const tagRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const lines = [];
  let offset = 0;
  for (const raw of text.split(/\r?\n/)) {
    const off = raw.match(/\[offset:\s*(-?\d+)\s*\]/i);
    if (off) { offset = parseInt(off[1], 10) / 1000; continue; }
    tagRe.lastIndex = 0;
    const times = [];
    let m;
    while ((m = tagRe.exec(raw))) {
      const frac = m[3] ? Number('0.' + m[3]) : 0;
      times.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac);
    }
    if (!times.length) continue;
    const body = raw.replace(tagRe, '').trim();
    if (!body) continue;
    for (const t of times) lines.push({ time: t + offset, text: body });
  }
  return lines.sort((a, b) => a.time - b.time);
}

function id3Decoder(enc) {
  if (enc === 1) return new TextDecoder('utf-16');
  if (enc === 2) return new TextDecoder('utf-16be');
  if (enc === 3) return new TextDecoder('utf-8');
  return new TextDecoder('latin1');
}

function id3FindTerm(bytes, p, wide) {
  if (wide) {
    while (p + 1 < bytes.length && !(bytes[p] === 0 && bytes[p + 1] === 0)) p += 2;
    return p;
  }
  while (p < bytes.length && bytes[p] !== 0) p++;
  return p;
}

function id3SkipTerm(bytes, p, wide) {
  return id3FindTerm(bytes, p, wide) + (wide ? 2 : 1);
}

function parseSylt(buf, off, size) {
  const bytes = new Uint8Array(buf, off, size);
  const dv = new DataView(buf, off, size);
  const enc = bytes[0];
  const dec = id3Decoder(enc);
  const wide = enc === 1 || enc === 2;
  // SYLT is ID3's synced lyrics frame. encoding, language,
  // timestamp format and content type take six bytes, then comes
  // a null-terminated content descriptor.
  let p = 1 + 3 + 1 + 1;
  p = id3SkipTerm(bytes, p, wide);
  const frags = [];
  while (p + (wide ? 2 : 1) + 4 <= size) {
    const s = p;
    p = id3FindTerm(bytes, p, wide);
    const text = dec.decode(bytes.subarray(s, p));
    p += wide ? 2 : 1;
    if (p + 4 > size) break;
    frags.push({ time: dv.getUint32(p) / 1000, text });
    p += 4;
  }
  const lines = [];
  let cur = null;
  for (const f of frags) {
    const startsNew = cur === null || /^[\r\n]/.test(f.text);
    const clean = f.text.replace(/[\r\n]+/g, ' ').trim();
    if (startsNew) {
      if (cur && cur.text) lines.push(cur);
      cur = { time: f.time, text: clean };
    } else {
      cur.text += (cur.text ? ' ' : '') + clean;
    }
  }
  if (cur && cur.text) lines.push(cur);
  return lines.length ? { type: 'synced', lines: lines.sort((a, b) => a.time - b.time) } : null;
}

function parseUslt(buf, off, size) {
  const bytes = new Uint8Array(buf, off, size);
  const enc = bytes[0];
  const dec = id3Decoder(enc);
  const wide = enc === 1 || enc === 2;
  let p = 1 + 3;
  p = id3SkipTerm(bytes, p, wide);
  const text = dec.decode(bytes.subarray(p));
  return text.trim() ? { type: 'plain', text } : null;
}

export function parseId3Lyrics(buf) {
  try {
    const dv = new DataView(buf);
    if (dv.byteLength < 10) return null;
    if (dv.getUint8(0) !== 0x49 || dv.getUint8(1) !== 0x44 || dv.getUint8(2) !== 0x33) return null;
    const ver = dv.getUint8(3);
    const syncsafe = (a, b, c, d) => (a << 21) | (b << 14) | (c << 7) | d;
    const tagSize = syncsafe(dv.getUint8(6), dv.getUint8(7), dv.getUint8(8), dv.getUint8(9));
    const end = Math.min(10 + tagSize, dv.byteLength);
    const frameSize = ver >= 4
      ? (p) => syncsafe(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3))
      : (p) => ((dv.getUint8(p) << 24) | (dv.getUint8(p + 1) << 16) | (dv.getUint8(p + 2) << 8) | dv.getUint8(p + 3)) >>> 0;
    let pos = 10;
    while (pos + 10 <= end) {
      const id = String.fromCharCode(dv.getUint8(pos), dv.getUint8(pos + 1), dv.getUint8(pos + 2), dv.getUint8(pos + 3));
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const size = frameSize(pos + 4) >>> 0;
      const body = pos + 10;
      if (size <= 0 || body + size > dv.byteLength) break;
      if (id === 'SYLT') { const r = parseSylt(buf, body, size); if (r) return r; }
      else if (id === 'USLT') { const r = parseUslt(buf, body, size); if (r) return r; }
      pos = body + size;
    }
    return null;
  } catch (e) {
    return null;
  }
}

function id3TextFrame(buf, off, size) {
  const bytes = new Uint8Array(buf, off, size);
  const dec = id3Decoder(bytes[0]);
  return dec.decode(bytes.subarray(1)).replace(/\0+$/, '').trim();
}

function parseId3Tags(buf) {
  const meta = { title: '', artist: '', album: '' };
  try {
    const dv = new DataView(buf);
    if (dv.byteLength < 10) return meta;
    if (dv.getUint8(0) !== 0x49 || dv.getUint8(1) !== 0x44 || dv.getUint8(2) !== 0x33) return meta;
    const ver = dv.getUint8(3);
    const syncsafe = (a, b, c, d) => (a << 21) | (b << 14) | (c << 7) | d;
    const tagSize = syncsafe(dv.getUint8(6), dv.getUint8(7), dv.getUint8(8), dv.getUint8(9));
    const end = Math.min(10 + tagSize, dv.byteLength);
    const frameSize = ver >= 4
      ? (p) => syncsafe(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3))
      : (p) => ((dv.getUint8(p) << 24) | (dv.getUint8(p + 1) << 16) | (dv.getUint8(p + 2) << 8) | dv.getUint8(p + 3)) >>> 0;
    const want = { TIT2: 'title', TPE1: 'artist', TALB: 'album' };
    let pos = 10;
    while (pos + 10 <= end) {
      const id = String.fromCharCode(dv.getUint8(pos), dv.getUint8(pos + 1), dv.getUint8(pos + 2), dv.getUint8(pos + 3));
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const size = frameSize(pos + 4) >>> 0;
      const body = pos + 10;
      if (size <= 0 || body + size > dv.byteLength) break;
      const key = want[id];
      if (key && !meta[key]) meta[key] = id3TextFrame(buf, body, size);
      pos = body + size;
    }
  } catch (e) { /* leave meta blank on any malformed tag */ }
  return meta;
}

function metaFromFilename(name) {
  const base = (name || '').replace(/\.[^.]+$/, '');
  const parts = base.split(/\s+-\s+/);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim(), album: '' };
  return { artist: '', title: base.trim(), album: '' };
}

export function trackMeta(buf, name) {
  const tags = parseId3Tags(buf);
  const fromName = metaFromFilename(name);
  return {
    title: tags.title || fromName.title,
    artist: tags.artist || fromName.artist,
    album: tags.album || fromName.album,
  };
}

export async function fetchLrclib(meta, duration) {
  if (!meta || !meta.title) return null;
  const params = new URLSearchParams({ action: 'lyrics', title: meta.title });
  if (meta.artist) params.set('artist', meta.artist);
  if (meta.album) params.set('album', meta.album);
  if (duration) params.set('duration', String(Math.round(duration)));
  try {
    const r = await api('karaoke.php?' + params.toString());
    if (!r.ok) return null;
    const data = await r.json();
    if (!data || !data.found) return null;
    if (data.synced) return { kind: 'lrc', text: data.synced };
    if (data.plain) return { kind: 'txt', text: data.plain };
    return null;
  } catch (e) {
    return null;
  }
}

function interpolateTimings(words, duration) {
  const n = words.length;
  if (!n) return;
  const anchors = [];
  for (let i = 0; i < n; i++) if (words[i].start != null) anchors.push(i);
  if (!anchors.length) {
    const d = (duration || n) / n;
    for (let i = 0; i < n; i++) { words[i].start = i * d; words[i].end = (i + 1) * d; }
  } else {
    const first = anchors[0];
    for (let i = 0; i < first; i++) {
      words[i].start = words[first].start * (i + 1) / (first + 1);
      words[i].end = words[first].start * (i + 2) / (first + 1);
    }
    for (let a = 0; a < anchors.length - 1; a++) {
      const lo = anchors[a], hi = anchors[a + 1];
      if (hi - lo <= 1) continue;
      const t0 = words[lo].end, step = (words[hi].start - t0) / (hi - lo);
      for (let k = lo + 1; k < hi; k++) { words[k].start = t0 + step * (k - lo - 1); words[k].end = t0 + step * (k - lo); }
    }
    const last = anchors[anchors.length - 1];
    const tEnd = duration || words[last].end + (n - last) * 0.4;
    for (let i = last + 1; i < n; i++) {
      words[i].start = words[last].end + (tEnd - words[last].end) * (i - last - 1) / (n - last);
      words[i].end = words[last].end + (tEnd - words[last].end) * (i - last) / (n - last);
    }
  }
  const lim = duration || Infinity;
  for (const w of words) {
    w.start = Math.max(0, Math.min(w.start, lim));
    w.end = Math.max(w.start, Math.min(w.end, lim));
  }
}

function alignWords(realWords, whisperWords, duration) {
  const a = realWords.map(w => normWord(typeof w === 'string' ? w : w.word));
  const b = whisperWords.map(w => normWord(w.word));
  const n = a.length, m = b.length;
  const GAP = -1, HIT = 2, MISS = -1;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 1; i <= n; i++) dp[i][0] = i * GAP;
  for (let j = 1; j <= m; j++) dp[0][j] = j * GAP;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const s = a[i - 1] && a[i - 1] === b[j - 1] ? HIT : MISS;
    dp[i][j] = Math.max(dp[i - 1][j - 1] + s, dp[i - 1][j] + GAP, dp[i][j - 1] + GAP);
  }
  const matchOf = new Array(n).fill(-1);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    const s = a[i - 1] && a[i - 1] === b[j - 1] ? HIT : MISS;
    if (dp[i][j] === dp[i - 1][j - 1] + s) { if (s === HIT) matchOf[i - 1] = j - 1; i--; j--; }
    else if (dp[i][j] === dp[i - 1][j] + GAP) i--;
    else j--;
  }
  const out = realWords.map(w => ({ word: typeof w === 'string' ? w : w.word, start: null, end: null }));
  for (let k = 0; k < n; k++) if (matchOf[k] >= 0) {
    out[k].start = whisperWords[matchOf[k]].start;
    out[k].end = whisperWords[matchOf[k]].end;
  }
  interpolateTimings(out, duration);
  return out;
}

function buildLinesFromWords(words) {
  const sections = [];
  let cur = [];
  for (const w of words) {
    if (cur.length && (w.start - cur[cur.length - 1].end > 1.0 || cur.length >= 10)) {
      sections.push(sectionFromWords(cur));
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) sections.push(sectionFromWords(cur));
  return sections;
}

function sectionFromWords(words) {
  return { owner: 'both', start: words[0].start, end: words[words.length - 1].end, words: words.slice() };
}

function sectionsFromLines(lines, duration) {
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i].time;
    const end = i + 1 < lines.length ? lines[i + 1].time : (duration || start + 4);
    const toks = lines[i].text.split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    const step = Math.max(0.001, end - start) / toks.length;
    const words = toks.map((t, k) => ({ word: t, start: start + step * k, end: start + step * (k + 1) }));
    sections.push({ owner: 'both', start, end, words });
  }
  return sections;
}

function plainTextLines(text) {
  return text.split(/\r?\n/).map(l => l.split(/\s+/).filter(Boolean)).filter(a => a.length);
}

function sectionsFromPlainText(text, whisperWords, duration) {
  const lineArrs = plainTextLines(text);
  if (!lineArrs.length) return [];
  const flat = [];
  for (const la of lineArrs) for (const w of la) flat.push(w);
  const aligned = alignWords(flat, whisperWords, duration);
  if (lineArrs.length <= 1) return buildLinesFromWords(aligned);
  const sections = [];
  let idx = 0;
  for (const la of lineArrs) {
    const ws = aligned.slice(idx, idx + la.length);
    idx += la.length;
    if (ws.length) sections.push({ owner: 'both', start: ws[0].start, end: ws[ws.length - 1].end, words: ws });
  }
  return sections;
}

export function buildSections(whisperWords, duration, { pendingLyrics, pendingLrclib, pendingId3 }) {
  if (pendingLyrics && pendingLyrics.kind === 'lrc') {
    const lines = parseLrc(pendingLyrics.text);
    if (lines.length) return { sections: sectionsFromLines(lines, duration), src: 'file (.lrc)' };
  }
  if (pendingLyrics && pendingLyrics.kind === 'txt') {
    const secs = sectionsFromPlainText(pendingLyrics.text, whisperWords, duration);
    if (secs.length) return { sections: secs, src: 'file (.txt)' };
  }
  if (pendingLrclib && pendingLrclib.kind === 'lrc') {
    const lines = parseLrc(pendingLrclib.text);
    if (lines.length) return { sections: sectionsFromLines(lines, duration), src: 'LRCLIB (synced)' };
  }
  if (pendingLrclib && pendingLrclib.kind === 'txt') {
    const secs = sectionsFromPlainText(pendingLrclib.text, whisperWords, duration);
    if (secs.length) return { sections: secs, src: 'LRCLIB' };
  }
  if (pendingId3) {
    if (pendingId3.type === 'synced' && pendingId3.lines.length)
      return { sections: sectionsFromLines(pendingId3.lines, duration), src: 'embedded' };
    if (pendingId3.type === 'plain') {
      const secs = sectionsFromPlainText(pendingId3.text, whisperWords, duration);
      if (secs.length) return { sections: secs, src: 'embedded' };
    }
  }
  return { sections: buildLinesFromWords(whisperWords), src: 'auto-transcribed' };
}

export function assignOwners(sections, m, picks) {
  sections.forEach((s, i) => {
    if (m === 'duo') s.owner = 'both';
    else if (m === 'split' && picks && picks[i]) s.owner = picks[i];
    else s.owner = 'you';
  });
  return sections;
}
