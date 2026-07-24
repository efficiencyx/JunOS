# Karaoke sidecar: htdemucs stem separation + whisper word timestamps. Same
# server.py as the voice sidecar, different deps - no kokoro/pocket-tts and no
# espeak-ng, but a GPU torch by default. Separation is the one audio job worth
# real VRAM (a 4-minute song is minutes on CPU, seconds on a GPU), and keeping it
# in its own container means the voice sidecar stays CPU-only next to the LLM.
FROM python:3.11-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libsndfile1 \
      ca-certificates \
      curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The nvidia/amd compose overlays override this with a CUDA / ROCm index; the CPU
# default is what a GPU-less host (or KARAOKE_GPU=off) builds against.
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu

# torch first from TORCH_INDEX so the resolver can't pull a different build in as
# a transitive dep, and in its own layer so editing requirements doesn't re-run a
# multi-GB install. torchaudio comes from the same index to keep its wheel build
# matched to torch's - demucs imports it for audio I/O. UV_HTTP_TIMEOUT is raised
# for the slow ROCm CDN so a large wheel doesn't trip uv's default stall timeout.
RUN UV_HTTP_TIMEOUT=300 uv pip install --system torch torchaudio --index-url ${TORCH_INDEX}

COPY tts/requirements-karaoke.txt /app/requirements.txt
RUN uv pip install --system -r /app/requirements.txt

COPY tts/server.py /app/server.py

# SIDECAR_ROLE=karaoke skips the Kokoro pre-warm (there is no Kokoro here) and is
#   what /health reports back to the webapp.
# SEP_DEVICE: cpu | cuda | auto - device for demucs. "auto" uses the GPU when
#   torch exposes one, else CPU; a per-job CUDA failure falls back to CPU rather
#   than failing the song. Weights (~80MB) download into HF_HOME at runtime.
# STT_MODEL / STT_LANG / STT_DEVICE: whisper transcribes the separated vocal into
#   timed words for the lyric track. Same pairing rules as the voice sidecar - the
#   ".en" builds are English-only, and STT_DEVICE stays cpu because CTranslate2
#   needs cuDNN the torch wheel doesn't reliably ship (and has no ROCm backend).
#   Songs are long, so sizing the model up here costs less than it does on chat.
# TTS_IDLE_UNLOAD_S drops demucs after an idle spell, handing the VRAM back to
#   the LLM between songs.
ENV SIDECAR_ROLE=karaoke \
    TTS_HOST=0.0.0.0 \
    TTS_PORT=8001 \
    SEP_DEVICE=auto \
    STT_MODEL=base \
    STT_LANG= \
    STT_COMPUTE=int8 \
    STT_DEVICE=cpu \
    OMP_NUM_THREADS=4 \
    HF_HOME=/root/.cache/huggingface \
    TTS_IDLE_UNLOAD_S=180

EXPOSE 8001

CMD ["python", "server.py"]
