window.Karaoke = (function () {
  const API = '/api/karaoke.php';
  const DB_NAME = 'omega-karaoke', DB_STORE = 'tracks';
  const START_LEAD = 0.1;        // schedule both stems this far ahead so they start sample-aligned
  const TOLERANCE = 1.25;        // s a sung word may drift from its reference timestamp and still count
  const GAIN_RAMP = 0.05;        // s ramp on guide-vocal gain changes so section handoffs don't click

  let active = false;
  let hooks = {};
  let healthCache = null;

  let audioCtx = null, analyser = null, analyserBuf = null, masterGain = null;
  let instrSource = null, guideSource = null, guideGain = null;
  let startTime = 0, rafId = 0;
  let track = null;              // { hash, duration, instrBuf, guideBuf, sections, lyricsSrc }
  let wordEls = [], lineEls = [];
  let activeLine = -1, activeWordLine = -1, activeWordIdx = -1;
  let lastOwnerKey = '';

  let recorder = null, micStream = null;

  let mode = 'solo';
  let soloPhase = 'you';
  let volume = 1.0;
  let junVolume = 0.8;
  let pendingLyrics = null;      // { text, kind:'lrc'|'txt', name } applied at next loadFile
  let pendingId3 = null;
  let pendingLrclib = null;      // { text, kind:'lrc'|'txt' } fetched from LRCLIB per load
  let splitPicks = null;
  let setupStep = 0;

  const $ = (id) => document.getElementById(id);
  const overlay = () => $('karaokeOverlay');
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const escapeHtml = (s) => s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function isActive() { return active; }

  async function health() {
    if (healthCache) return healthCache;
    try {
      const r = await fetch(`${API}?action=health`, { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`http ${r.status}`);
      healthCache = await r.json();
    } catch (e) {
      healthCache = { sep: false };
    }
    return healthCache;
  }

  function idb() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(DB_STORE, { keyPath: 'hash' });
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }
  async function idbGet(hash) {
    const db = await idb();
    return new Promise((res, rej) => {
      const rq = db.transaction(DB_STORE).objectStore(DB_STORE).get(hash);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => rej(rq.error);
    });
  }
  async function idbPut(rec) {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(rec);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  }

  async function sha256Hex(buf) {
    const d = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function ensureCtx() {
    if (audioCtx) return audioCtx;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.4;
    analyserBuf = new Float32Array(analyser.fftSize);
    masterGain = audioCtx.createGain();
    masterGain.gain.value = volume;
    masterGain.connect(audioCtx.destination);
    return audioCtx;
  }

  function setStatus(msg) {
    const el = $('karaokeStatus');
    if (el) el.textContent = msg || '';
    const setupStatus = $('karaokeSetupStatus');
    if (setupStatus) setupStatus.textContent = msg || 'Preparing the stage…';
  }
  function setBusy(b) {
    const p = $('karaokeProgress');
    if (p) p.hidden = !b;
    const load = $('karaokeLoadBtn');
    if (load) load.disabled = b;
    const setup = $('karaokeSetup');
    if (setup) setup.setAttribute('aria-busy', b ? 'true' : 'false');
    document.querySelectorAll('[data-karaoke-back]').forEach(button => { button.disabled = b; });
  }
  function setLyricsSrc(src) {
    const el = $('karaokeLyricsSrc');
    if (el) el.textContent = src ? `Lyrics: ${src}` : '';
  }

  function updateSetupSummary() {
    const el = $('karaokeSetupSummary');
    if (!el) return;
    const modes = {
      solo: 'Solo',
      duo: 'Sing together',
      split: 'Pick our lines',
    };
    el.textContent = `${modes[mode]} · ${pendingLyrics ? pendingLyrics.name : 'automatic lyrics'}`;
  }

  function setSetupStep(next) {
    setupStep = Math.max(0, Math.min(2, next));
    document.querySelectorAll('[data-karaoke-step]').forEach(step => {
      step.hidden = Number(step.dataset.karaokeStep) !== setupStep;
    });
    document.querySelectorAll('[data-karaoke-step-dot]').forEach(dot => {
      const index = Number(dot.dataset.karaokeStepDot);
      dot.classList.toggle('active', index === setupStep);
      dot.classList.toggle('done', index < setupStep);
    });
    if (setupStep === 2) updateSetupSummary();
  }

  function setLyricsChoice(choice) {
    const auto = $('karaokeLyricsAuto');
    const file = $('karaokeLyricsBtn');
    if (auto) auto.classList.toggle('selected', choice === 'auto');
    if (file) file.classList.toggle('selected', choice === 'file');
    if (choice === 'auto') {
      pendingLyrics = null;
      setLyricsSrc('automatic detection');
    }
    updateSetupSummary();
  }

  function platformFlavor() {
    const authTerm = $('authTerm');
    let os = authTerm && authTerm.dataset.os;
    if (!os) {
      const platform = (navigator.userAgentData && navigator.userAgentData.platform)
        || navigator.platform || navigator.userAgent || '';
      const value = platform.toLowerCase();
      os = /mac|iphone|ipad|ipod/.test(value) ? 'mac' : /win/.test(value) ? 'windows' : 'linux';
    }
    const titles = {
      mac: ['jun - karaoke - 80×24', 'jun - karaoke/lines - 80×24'],
      windows: ['Windows PowerShell - karaoke', 'Windows PowerShell - karaoke\\lines'],
      linux: ['jun@junbuntu: ~/karaoke', 'jun@junbuntu: ~/karaoke/lines'],
    };
    const names = { mac: 'macOS', windows: 'Windows', linux: 'Linux' };
    document.querySelectorAll('.karaoke-menu').forEach((menu, index) => {
      menu.dataset.os = os;
      const title = menu.querySelector('.karaoke-term-title');
      const name = menu.querySelector('.karaoke-os-name');
      if (title) title.textContent = titles[os][Math.min(index, 1)];
      if (name) name.textContent = names[os];
    });
  }

  // decodeAudioData detaches the ArrayBuffer it is handed, so decode a copy and
  // keep the original bytes for IndexedDB - AudioBuffer itself is not storable.
  async function decodeCopy(raw) {
    return audioCtx.decodeAudioData(raw.slice(0));
  }

  async function fetchStem(which, token) {
    const r = await fetch(`${API}?action=stem&which=${which}&token=${encodeURIComponent(token)}`, {
      credentials: 'same-origin',
    });
    if (!r.ok) throw new Error(`stem ${which} http ${r.status}`);
    return r.arrayBuffer();
  }

  const normWord = (w) => (w || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

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
    let p = 1 + 3 + 1 + 1;                 // encoding, language, timestamp format, content type
    p = id3SkipTerm(bytes, p, wide);       // content descriptor
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

  function parseId3Lyrics(buf) {
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

  function trackMeta(buf, name) {
    const tags = parseId3Tags(buf);
    const fromName = metaFromFilename(name);
    return {
      title: tags.title || fromName.title,
      artist: tags.artist || fromName.artist,
      album: tags.album || fromName.album,
    };
  }

  async function fetchLrclib(meta, duration) {
    if (!meta || !meta.title) return null;
    const params = new URLSearchParams({ action: 'lyrics', title: meta.title });
    if (meta.artist) params.set('artist', meta.artist);
    if (meta.album) params.set('album', meta.album);
    if (duration) params.set('duration', String(Math.round(duration)));
    try {
      const r = await fetch(`${API}?${params.toString()}`, { credentials: 'same-origin' });
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

  function buildSections(whisperWords, duration) {
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

  function assignOwners(sections, m, picks) {
    sections.forEach((s, i) => {
      if (m === 'duo') s.owner = 'both';
      else if (m === 'split' && picks && picks[i]) s.owner = picks[i];
      else s.owner = 'you';
    });
    return sections;
  }

  async function loadFile(file) {
    ensureCtx();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    setBusy(true);
    try {
      const raw = await file.arrayBuffer();
      const hash = await sha256Hex(raw);
      pendingId3 = parseId3Lyrics(raw);
      pendingLrclib = null;
      const meta = trackMeta(raw, file.name);

      let rec = await idbGet(hash);
      if (!rec) {
        const h = await health();
        setStatus(h.device === 'cpu'
          ? 'Separating stems on CPU - this can take a few minutes…'
          : 'Separating stems…');
        const sepRes = await fetch(`${API}?action=separate`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: raw,
        });
        if (!sepRes.ok) throw new Error(`separate http ${sepRes.status}`);
        const meta = await sepRes.json();
        setStatus('Fetching stems…');
        const [instrumental, guide] = await Promise.all([
          fetchStem('instrumental', meta.token),
          fetchStem('guide', meta.token),
        ]);
        rec = { hash, instrumental, guide, lyrics: meta.lyrics || [], duration: meta.duration || 0 };
        await idbPut(rec);
      } else {
        setStatus('Loaded from cache…');
      }

      const [instrBuf, guideBuf] = await Promise.all([decodeCopy(rec.instrumental), decodeCopy(rec.guide)]);
      const duration = rec.duration || Math.max(instrBuf.duration, guideBuf.duration);

      if (!pendingLyrics) {
        setStatus('Looking up lyrics…');
        pendingLrclib = await fetchLrclib(meta, duration);
      }

      const built = buildSections(rec.lyrics || [], duration);
      track = { hash, duration, instrBuf, guideBuf, sections: built.sections, lyricsSrc: built.src };
      setLyricsSrc(built.src);
      setStatus('');

      if (mode === 'split') {
        showAssign();
      } else {
        assignOwners(track.sections, mode);
        renderLyrics();
        showStage(true);
        start();
      }
    } catch (e) {
      console.error(e);
      setStatus('');
      ui.toast('⚠ Karaoke failed: ' + e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function showAssign() {
    const panel = $('karaokeAssign'), list = $('karaokeAssignList');
    if (!panel || !list) return;
    splitPicks = track.sections.map((s, i) => (i % 2 === 0 ? 'you' : 'jun'));
    list.innerHTML = track.sections.map((sec, i) => {
      const preview = escapeHtml(sec.words.map(w => w.word).join(' ').slice(0, 64));
      return `<div class="karaoke-assign-row">
        <span class="karaoke-assign-preview">${preview}</span>
        <span class="karaoke-assign-toggle">
          <button type="button" data-i="${i}" data-owner="you" class="${splitPicks[i] === 'you' ? 'selected' : ''}">You</button>
          <button type="button" data-i="${i}" data-owner="jun" class="${splitPicks[i] === 'jun' ? 'selected' : ''}">Jun</button>
        </span></div>`;
    }).join('');
    list.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      const i = +b.dataset.i;
      splitPicks[i] = b.dataset.owner;
      b.parentElement.querySelectorAll('button').forEach(x => x.classList.toggle('selected', x.dataset.owner === b.dataset.owner));
    }));
    const setup = $('karaokeSetup');
    if (setup) setup.hidden = true;
    panel.hidden = false;
    const ov = overlay();
    if (ov) ov.dataset.view = 'assign';
  }

  function renderLyrics() {
    const box = $('karaokeLyrics');
    if (!box) return;
    box.innerHTML = '';
    wordEls = [];
    lineEls = [];
    activeLine = activeWordLine = activeWordIdx = -1;
    track.sections.forEach((sec) => {
      const line = document.createElement('div');
      line.className = 'karaoke-line';
      line.dataset.owner = sec.owner;
      const els = [];
      sec.words.forEach((w, k) => {
        const s = document.createElement('span');
        s.className = 'karaoke-word';
        s.textContent = w.word;
        line.appendChild(s);
        if (k < sec.words.length - 1) line.appendChild(document.createTextNode(' '));
        els.push(s);
      });
      box.appendChild(line);
      lineEls.push(line);
      wordEls.push(els);
    });
    renderTicks();
  }

  function renderTicks() {
    const bar = $('karaokeProgressBar');
    if (!bar || !track.duration) return;
    bar.querySelectorAll('.karaoke-tick').forEach(t => t.remove());
    for (const sec of track.sections) {
      if (sec.start <= 0) continue;
      const tick = document.createElement('span');
      tick.className = 'karaoke-tick';
      tick.style.left = (sec.start / track.duration * 100) + '%';
      bar.appendChild(tick);
    }
  }

  function showStage(on) {
    const setup = $('karaokeSetup'), assign = $('karaokeAssign'), stage = $('karaokeStage');
    if (setup) setup.hidden = on;
    if (assign) assign.hidden = on;
    if (stage) stage.hidden = !on;
    const ov = overlay();
    if (ov && on) ov.dataset.view = 'stage';
    const score = $('karaokeScore');
    if (score) score.hidden = true;
  }

  function resetPanels() {
    const setup = $('karaokeSetup'), assign = $('karaokeAssign'), stage = $('karaokeStage'), score = $('karaokeScore');
    if (setup) setup.hidden = false;
    if (assign) assign.hidden = true;
    if (stage) stage.hidden = true;
    if (score) score.hidden = true;
    const ov = overlay();
    if (ov) ov.dataset.view = 'setup';
    track = null;
    pendingLyrics = null;
    pendingId3 = null;
    pendingLrclib = null;
    setStatus('');
    setBusy(false);
    setLyricsChoice('auto');
    setSetupStep(0);
  }

  async function startRecording() {
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

  function stopRecording() {
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
      const r = await fetch(`${API}?action=transcribe`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'audio/webm' },
        body: blob,
      });
      if (!r.ok) throw new Error(`transcribe http ${r.status}`);
      const data = await r.json();
      renderScore(scoreTake(sections, data.words || []));
    } catch (e) {
      console.error(e);
      ui.toast('⚠ Scoring failed: ' + e.message, 'error');
    } finally {
      setStatus(active && mode === 'solo' && soloPhase === 'jun' && instrSource
        ? "Jun's solo…"
        : '');
    }
  }

  function scoreTake(sections, user) {
    const userN = user.map(w => ({ t: (w.start + w.end) / 2, w: normWord(w.word), used: false })).filter(u => u.w);
    let matched = 0, total = 0;
    const breakdown = [];
    sections.forEach((sec, idx) => {
      if (sec.owner === 'jun') return;
      const refN = sec.words.map(w => ({ t: (w.start + w.end) / 2, w: normWord(w.word) })).filter(r => r.w);
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
        if (best >= 0) { userN[best].used = true; m++; }
      }
      matched += m; total += refN.length;
      if (sec.owner === 'you') breakdown.push({ index: idx, owner: sec.owner, matched: m, total: refN.length });
    });
    return { matched, total, score: total ? Math.round(matched / total * 100) : 0, breakdown, scored: total > 0 };
  }

  function renderScore(r) {
    const box = $('karaokeScore');
    if (!box) return;
    box.hidden = false;
    if (!r.scored) {
      box.innerHTML = `<div class="karaoke-score-num">-</div>
        <div class="karaoke-score-sub">no scored lines this take</div>`;
      return;
    }
    const rows = r.breakdown.map(b => `<li>Line ${b.index + 1} <span>${b.matched}/${b.total}</span></li>`).join('');
    box.innerHTML = `<div class="karaoke-score-num">${r.score}</div>
      <div class="karaoke-score-sub">${r.matched} / ${r.total} words</div>` +
      (rows ? `<ul class="karaoke-score-list">${rows}</ul>` : '');
  }

  function computeRms() {
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(analyserBuf);
    let sum = 0;
    for (let i = 0; i < analyserBuf.length; i++) sum += analyserBuf[i] * analyserBuf[i];
    return Math.sqrt(sum / analyserBuf.length);
  }

  function sectionAt(elapsed) {
    const secs = track.sections;
    let idx = -1;
    for (let i = 0; i < secs.length; i++) {
      if (elapsed >= secs[i].start) idx = i;
      else break;
    }
    return idx;
  }

  function updateTurn(si, owner) {
    const el = $('karaokeTurn');
    if (!el) return;
    const next = si + 1 < track.sections.length ? track.sections[si + 1].owner : null;
    const key = owner + '>' + (next || '');
    if (key === lastOwnerKey) return;
    lastOwnerKey = key;
    const label = owner === 'you' ? 'Your turn' : owner === 'jun' ? "Jun's turn" : 'Together';
    const nextLabel = next && next !== owner
      ? next === 'you' ? 'you' : next === 'jun' ? 'Jun' : 'together'
      : null;
    el.dataset.owner = owner;
    el.innerHTML = `<span class="karaoke-turn-main">${label}</span>` +
      (nextLabel ? `<span class="karaoke-turn-next">next: ${nextLabel}</span>` : '');
  }

  function setActiveLine(si) {
    if (si === activeLine) return;
    if (lineEls[activeLine]) lineEls[activeLine].classList.remove('active');
    if (lineEls[si]) { lineEls[si].classList.add('active'); lineEls[si].scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    activeLine = si;
  }
  function setActiveWord(si, wi) {
    if (si === activeWordLine && wi === activeWordIdx) return;
    if (wordEls[activeWordLine] && wordEls[activeWordLine][activeWordIdx])
      wordEls[activeWordLine][activeWordIdx].classList.remove('active');
    if (si >= 0 && wi >= 0 && wordEls[si] && wordEls[si][wi])
      wordEls[si][wi].classList.add('active');
    activeWordLine = si; activeWordIdx = wi;
  }

  function loop() {
    rafId = 0;
    if (!active || !audioCtx || !track) return;
    const elapsed = audioCtx.currentTime - startTime;
    const secs = track.sections;
    const si = sectionAt(elapsed);
    const owner = si >= 0 ? secs[si].owner : (secs[0] ? secs[0].owner : 'both');

    if (window.Live2D && Live2D.setMouthOverride) {
      if (owner === 'you') Live2D.setMouthOverride(0);
      else Live2D.setMouthOverride(Math.pow(Math.min(1, computeRms() * 3.5), 0.7));
    }

    updateTurn(si, owner);
    setActiveLine(si);

    let cw = -1;
    if (si >= 0) {
      const ws = secs[si].words;
      for (let i = 0; i < ws.length; i++) {
        if (elapsed >= ws[i].start && elapsed <= ws[i].end) { cw = i; break; }
        if (elapsed < ws[i].start) break;
        cw = i;
      }
    }
    setActiveWord(si, cw);

    const fill = $('karaokeProgressFill');
    if (fill) fill.style.width = (track.duration ? Math.min(1, elapsed / track.duration) * 100 : 0) + '%';

    rafId = requestAnimationFrame(loop);
  }

  const targetFor = (owner) => (owner === 'you' ? 0 : junVolume);

  function scheduleGuideAutomation() {
    const g = guideGain.gain;
    g.cancelScheduledValues(0);
    const secs = track.sections;
    let prev = secs.length ? targetFor(secs[0].owner) : junVolume;
    g.setValueAtTime(prev, startTime);
    for (const sec of secs) {
      const t = Math.max(startTime, startTime + sec.start);
      const tg = targetFor(sec.owner);
      g.setValueAtTime(prev, t);
      g.linearRampToValueAtTime(tg, t + GAIN_RAMP);
      prev = tg;
    }
  }

  function start(nextSoloPhase = 'you') {
    if (!track) return;
    stopPlayback();
    lastOwnerKey = '';

    if (mode === 'solo') {
      soloPhase = nextSoloPhase;
      track.sections.forEach(section => { section.owner = soloPhase; });
      renderLyrics();
    }

    instrSource = audioCtx.createBufferSource();
    instrSource.buffer = track.instrBuf;
    instrSource.connect(masterGain);

    guideGain = audioCtx.createGain();
    guideSource = audioCtx.createBufferSource();
    guideSource.buffer = track.guideBuf;
    guideSource.connect(guideGain);
    guideGain.connect(masterGain);
    guideGain.connect(analyser);     // tap after the gain so lipsync only reacts to audible vocal

    startTime = audioCtx.currentTime + START_LEAD;
    scheduleGuideAutomation();
    instrSource.start(startTime);
    guideSource.start(startTime);
    instrSource.onended = () => {
      if (!active) return;
      if (mode === 'solo' && soloPhase === 'you') {
        start('jun');
        return;
      }
      stopPlayback();
      setStatus(mode === 'solo' ? 'Solo relay complete' : 'Take complete');
    };

    if (mode !== 'solo' || soloPhase === 'you') startRecording();
    if (!rafId) rafId = requestAnimationFrame(loop);
    setStatus(mode === 'solo'
      ? soloPhase === 'you' ? 'Your solo… Jun goes next' : "Jun's solo…"
      : 'Singing… tap Stop when done');
  }

  function stopPlayback() {
    for (const s of [instrSource, guideSource]) {
      if (!s) continue;
      try { s.onended = null; s.stop(); } catch (e) {}
      try { s.disconnect(); } catch (e) {}
    }
    if (guideGain) { try { guideGain.disconnect(); } catch (e) {} }
    instrSource = guideSource = guideGain = null;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (window.Live2D && Live2D.setMouthOverride) Live2D.setMouthOverride(0);
    setActiveWord(-1, -1);
    setActiveLine(-1);
    lastOwnerKey = '';
    stopRecording();
  }

  function setJunVolume(v) {
    junVolume = clamp(v);
    if (!guideGain || !audioCtx || !track) return;
    const now = audioCtx.currentTime;
    const idx = sectionAt(now - startTime);
    const curOwner = idx >= 0 ? track.sections[idx].owner : 'both';
    const g = guideGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(targetFor(curOwner), now + GAIN_RAMP);
    let prev = targetFor(curOwner);
    for (let i = idx + 1; i < track.sections.length; i++) {
      const t = startTime + track.sections[i].start;
      if (t <= now) continue;
      const tg = targetFor(track.sections[i].owner);
      g.setValueAtTime(prev, t);
      g.linearRampToValueAtTime(tg, t + GAIN_RAMP);
      prev = tg;
    }
  }

  function setVolume(v) {
    volume = clamp(Number.isFinite(v) ? v : 1);
    if (!masterGain || !audioCtx) return;
    const now = audioCtx.currentTime;
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setTargetAtTime(volume, now, 0.02);
  }

  function setMode(m) {
    if (!['solo', 'duo', 'split'].includes(m)) return;
    mode = m;
    const sel = $('karaokeModeSel');
    if (sel) sel.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('selected', b.dataset.mode === m));
    const desc = $('karaokeModeDesc');
    if (desc) desc.textContent =
      m === 'duo' ? 'Sing the whole song together.' :
      m === 'split' ? 'Assign each line to you or Jun after the song loads.' :
      'You sing the full song first, then Jun takes a solo turn.';
    updateSetupSummary();
  }

  async function enter() {
    if (active) return true;
    const h = await health();
    if (!h.sep) {
      ui.toast('⚠ Karaoke unavailable: stem separation is not running', 'error');
      return false;
    }
    active = true;
    const ov = overlay();
    if (ov) { ov.hidden = false; void ov.offsetHeight; }
    document.body.classList.add('karaoke-mode');
    resetPanels();
    const hint = $('karaokeDeviceHint');
    if (hint) hint.textContent = h.device === 'cpu' ? 'CPU - separation is slow' : 'GPU ⚡';
    if (window.Live2D) Live2D.setCameraPreset('face');
    if (hooks.onEnter) hooks.onEnter();
    return true;
  }

  function exit() {
    if (!active) return;
    active = false;
    stopPlayback();
    document.body.classList.remove('karaoke-mode');
    const ov = overlay();
    if (ov) setTimeout(() => { if (!active) ov.hidden = true; }, 300);
    if (window.Live2D) Live2D.setCameraPreset('default');
    if (hooks.onExit) hooks.onExit();
  }

  function toggle() { active ? exit() : enter(); }

  function init(h) {
    hooks = { ...hooks, ...(h || {}) };
    platformFlavor();
    const btn = $('karaokeOpenBtn');
    if (btn) btn.addEventListener('click', toggle);
    const close = $('karaokeOverlayClose');
    if (close) close.addEventListener('click', exit);

    const sel = $('karaokeModeSel');
    if (sel) sel.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
    setMode(mode);

    document.querySelectorAll('[data-karaoke-next]').forEach(button => {
      button.addEventListener('click', () => setSetupStep(setupStep + 1));
    });
    document.querySelectorAll('[data-karaoke-back]').forEach(button => {
      button.addEventListener('click', () => setSetupStep(setupStep - 1));
    });

    const lyricsAuto = $('karaokeLyricsAuto');
    if (lyricsAuto) lyricsAuto.addEventListener('click', () => setLyricsChoice('auto'));

    const load = $('karaokeLoadBtn');
    const input = $('karaokeFileInput');
    if (load && input) {
      load.addEventListener('click', () => input.click());
      input.addEventListener('change', () => {
        const f = input.files[0];
        input.value = '';
        if (f) loadFile(f);
      });
    }

    const lyBtn = $('karaokeLyricsBtn');
    const lyInput = $('karaokeLyricsInput');
    if (lyBtn && lyInput) {
      lyBtn.addEventListener('click', () => lyInput.click());
      lyInput.addEventListener('change', async () => {
        const f = lyInput.files[0];
        lyInput.value = '';
        if (!f) return;
        const kind = /\.lrc$/i.test(f.name) ? 'lrc' : 'txt';
        pendingLyrics = { text: await f.text(), kind, name: f.name };
        setLyricsChoice('file');
        setLyricsSrc(`${f.name} (queued)`);
      });
    }

    const assignStart = $('karaokeAssignStart');
    if (assignStart) assignStart.addEventListener('click', () => {
      if (!track) return;
      assignOwners(track.sections, 'split', splitPicks);
      renderLyrics();
      showStage(true);
      start();
    });

    const stop = $('karaokeStopBtn');
    if (stop) stop.addEventListener('click', stopPlayback);
    const restart = $('karaokeRestartBtn');
    if (restart) restart.addEventListener('click', () => { showStage(true); start(); });
    const gv = $('karaokeGuideVol');
    if (gv) gv.addEventListener('input', () => setJunVolume(parseFloat(gv.value)));
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && active) exit(); });
  }

  return { init, isActive, enter, exit, toggle, health, setVolume };
})();
