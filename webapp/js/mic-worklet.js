// The worklet keeps VAD metering and PCM capture active in background tabs.

class MicProcessor extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = (opts && opts.processorOptions) || {};

    // Pre-roll ring. voice.js only declares "speech" after a ~96ms debounce, by
    // which point the word's onset is already gone - whisper transcribes
    // "y Jun" for "Hey Jun". So we always keep the last N ms and prepend it when
    // recording starts. This is the whole reason capture lives in a worklet
    // instead of a MediaRecorder started on demand.
    const preRollLen = Math.ceil(((o.preRollMs || 300) / 1000) * sampleRate);
    this.ring = new Float32Array(preRollLen);
    this.ringPos = 0;
    this.ringFilled = 0;

    // Utterance buffer, allocated once. Allocating megabytes on the audio thread
    // mid-utterance risks a GC pause and a dropped frame, so it's sized for the
    // hard cap up front and reused. 30s @ 16kHz float32 = ~1.9MB.
    this.maxLen = Math.ceil(((o.maxMs || 30000) / 1000) * sampleRate);
    this.buf = new Float32Array(this.maxLen);
    this.len = 0;
    this.recording = false;

    // EMA over frame RMS. Raw per-frame RMS is spiky enough at 8ms that plosives
    // and clicks cross any useful threshold; ~40ms of smoothing kills that
    // without blurring real speech onsets.
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
        // Hit the hard cap - a stuck-open VAD (constant noise never crossing the
        // close threshold) would otherwise record forever. Finalize what we have.
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
