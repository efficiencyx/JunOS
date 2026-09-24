import io

import numpy as np
import soundfile as sf


class AudioDurationExceeded(Exception):
    pass


def to_wav(audio, sample_rate):
    # some engines hand back samples over 1.0 now and then, so pull
    # the peak back down or the WAV clips
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > 1.0:
        audio = audio / peak

    buf = io.BytesIO()
    channels = 1 if audio.ndim == 1 else audio.shape[1]
    # AI Act art. 50(2) wants generated audio machine-readably
    # marked. libsndfile only emits the LIST/INFO chunk if the
    # strings are set before any samples are written, so this can't
    # use the plain sf.write() one-liner.
    with sf.SoundFile(buf, "w", samplerate=sample_rate, channels=channels,
                      format="WAV", subtype="PCM_16") as f:
        f.title = "AI-generated speech"
        f.software = "Jun OS text-to-speech"
        f.comment = "Artificially generated audio. Synthetic speech produced by a text-to-speech model; not a recording of a real person."
        f.write(audio)
    buf.seek(0)
    return buf.read()


def decode_audio(body, target_sr, target_channels, max_duration_s):
    # same PyAV /stt uses. its wheel bundles ffmpeg's libs so any
    # container it can open works and no ffmpeg binary is needed.
    # planar float output lands as (channels, samples), and the
    # resampler up/down-mixes to target_channels, so a mono upload
    # becomes the stereo demucs wants for free.
    import av
    layout = "stereo" if target_channels == 2 else "mono"
    resampler = av.audio.resampler.AudioResampler(format="fltp", layout=layout, rate=target_sr)
    container = av.open(io.BytesIO(body))
    chunks = []
    samples = 0
    max_samples = int(target_sr * max_duration_s)
    try:
        for frame in container.decode(audio=0):
            for rf in _resample(resampler, frame):
                samples += rf.samples
                if samples > max_samples:
                    raise AudioDurationExceeded
                chunks.append(rf.to_ndarray())
    finally:
        container.close()
    for rf in _resample(resampler, None):
        samples += rf.samples
        if samples > max_samples:
            raise AudioDurationExceeded
        chunks.append(rf.to_ndarray())
    if not chunks:
        return np.zeros((target_channels, 0), dtype=np.float32)
    return np.concatenate(chunks, axis=1).astype(np.float32)


def _resample(resampler, frame):
    out = resampler.resample(frame)
    if out is None:
        return []
    return out if isinstance(out, list) else [out]
