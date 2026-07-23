# Audio sidecar (Kokoro-82M + pocket-tts for TTS, faster-whisper for STT). CPU
# build by default - the models are small enough to hit comfortable real-time on
# CPU. GPU is opt-in: TORCH_INDEX selects a CUDA / ROCm wheel build, and
# TTS_DEVICE (below) selects the runtime device. Kokoro on GPU is the single
# biggest latency win available for voice mode (RTF ~0.3-0.6 -> ~0.03-0.05).
FROM python:3.11-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      espeak-ng \
      libsndfile1 \
      ca-certificates \
      curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Torch wheel source. CPU-only by default so pocket-tts/kokoro don't drag in
# GPU wheels; the launcher selects a GPU index only when GPU TTS is requested.
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu

COPY tts/requirements.txt /app/requirements.txt
# Install torch first (from TORCH_INDEX) so the resolver doesn't later pull a
# different build in as a transitive dependency. torchaudio comes from the same
# index so its wheel build stays matched to torch's across the cpu/cu124/rocm
# overlays (PitchShift for the karaoke guide vocal lives in torchaudio).
RUN pip install torch torchaudio --index-url ${TORCH_INDEX} \
 && pip install -r /app/requirements.txt

COPY tts/server.py /app/server.py

# TTS_DEVICE: cpu | cuda | auto. "auto" uses the GPU when the installed torch
# exposes one (so it's a no-op on the default CPU build).
# SEP_DEVICE: cpu | cuda | auto - device for demucs karaoke stem separation.
#   "auto" uses the GPU when torch exposes one, else CPU; a per-job CUDA failure
#   falls back to CPU. Demucs weights (~80MB) download into HF_HOME at runtime.
# STT_MODEL / STT_LANG: must agree. base.en is the latency/accuracy sweet spot
#   for conversational English (distil-small.en ~150ms faster, small.en better).
#   The ".en" models are English-ONLY - for another language you need BOTH a
#   multilingual model and a matching language, e.g. STT_MODEL=base STT_LANG=it.
#   STT_LANG="" auto-detects (extra decode pass, shaky under ~2s of audio).
#   Note Kokoro only speaks American English; the pockettts engine is the one
#   with it/es/de/pt/fr voices, so a non-English loop needs engine=pockettts too.
# STT_DEVICE: cpu | cuda. Separate from TTS_DEVICE and defaults to cpu on
#   purpose - whisper runs on CTranslate2, not torch, and CUDA CTranslate2 needs
#   cuDNN that the torch CUDA wheel doesn't reliably ship (and has no ROCm
#   backend at all). CPU whisper isn't the bottleneck; Kokoro is.
# OMP_NUM_THREADS bounds torch's intra-op pool and is also read by server.py as
#   whisper's cpu_threads. Unpinned, both libraries grab every core and fight
#   when STT and TTS overlap. Raise it on a big box, drop to 2 on a 4-core one.
ENV TTS_HOST=0.0.0.0 \
    TTS_PORT=8001 \
    TTS_DEVICE=auto \
    SEP_DEVICE=auto \
    STT_MODEL=base.en \
    STT_LANG=en \
    STT_COMPUTE=int8 \
    STT_DEVICE=cpu \
    OMP_NUM_THREADS=4 \
    HF_HOME=/root/.cache/huggingface \
    TTS_IDLE_UNLOAD_S=180

EXPOSE 8001

CMD ["python", "server.py"]
