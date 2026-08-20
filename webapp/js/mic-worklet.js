// The worklet keeps VAD metering and PCM capture going in background tabs.

class MicProcessor extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = (opts && opts.processorOptions) || {};

    // Pre-roll ring. voice.js won't call it "speech" until a ~96ms debounce
    // is done, and by then the start of the word is gone, whisper hears
    // "y Jun" when you said "Hey Jun". so we always keep the last N ms and
    // stick it on the front when recording starts. this is the whole reason
    // capture lives in a worklet and not in a MediaRecorder we start when
    // we need it.
    const preRollLen = Math.ceil(((o.preRollMs || 300) / 1000) * sampleRate);
    this.ring = new Float32Array(preRollLen);
    this.ringPos = 0;
    this.ringFilled = 0;

    // Utterance buffer, made once. asking for megabytes on the audio thread
    // in the middle of a word can give us a GC pause and a dropped frame, so
    // we take the full size up front and reuse it. 30s @ 16kHz float32 is
    // ~1.9MB.
    this.maxLen = Math.ceil(((o.maxMs || 30000) / 1000) * sampleRate);
    this.buf = new Float32Array(this.maxLen);
    this.len = 0;
    this.recording = false;

    // EMA over frame RMS. raw per frame RMS jumps around so much at 8ms that
    // a hard p or a click goes over any threshold worth having. ~40ms of
    // smoothing takes that out and still keeps the Start of real speech
    // sharp.
    this.alpha = o.alpha || 0.2;
    this.ema = 0;
    this.tick = 0;

    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'start') this.start();
      else if (m.type === 'stop') this.stop(!!m.discard);
    };
  }

  start() {
    if (this.recording) return;
    this.len = 0;
    const n = this.ringFilled;
    const startAt = (this.ringPos - n + this.ring.length) % this.ring.length;
    for (let i = 0; i < n; i++) {
      this.buf[this.len++] = this.ring[(startAt + i) % this.ring.length];
    }
    this.recording = true;
  }

  stop(discard) {
    if (!this.recording) return;
    this.recording = false;
    if (discard || !this.len) { this.port.postMessage({ type: 'pcm', pcm: null }); return; }
    const out = this.buf.slice(0, this.len);
    this.port.postMessage({ type: 'pcm', pcm: out }, [out.buffer]);
    this.len = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;

    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    const rms = Math.sqrt(sum / ch.length);
    this.ema = this.alpha * rms + (1 - this.alpha) * this.ema;

    if (this.recording) {
      if (this.len + ch.length <= this.maxLen) {
        this.buf.set(ch, this.len);
        this.len += ch.length;
      } else {
        // Hit the hard cap. a VAD stuck open, noise that never drops under
        // the close threshold, would record for Ever. send what we have.
        this.port.postMessage({ type: 'overflow' });
        this.stop(false);
      }
    }

    for (let i = 0; i < ch.length; i++) {
      this.ring[this.ringPos] = ch[i];
      this.ringPos = (this.ringPos + 1) % this.ring.length;
    }
    if (this.ringFilled < this.ring.length) {
      this.ringFilled = Math.min(this.ring.length, this.ringFilled + ch.length);
    }

    if ((++this.tick & 3) === 0) this.port.postMessage({ type: 'rms', rms: this.ema });
    return true;
  }
}

registerProcessor('mic-processor', MicProcessor);
