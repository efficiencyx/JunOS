# The karaoke sidecar. htdemucs splits a song into vocals and backing, whisper
# then times every word. same server.py as the voice sidecar with different deps,
# no kokoro or pocket-tts, no espeak-ng, but a GPU torch by default. splitting a
# song is the one audio job worth real VRAM, a 4 minute track takes minutes on a
# CPU and seconds on a GPU. it gets its own container so the voice sidecar can
# stay CPU only next to the LLM.
FROM python:3.11-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libsndfile1 \
      ca-certificates \
      curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The nvidia and amd overlays swap this for a CUDA or ROCm index. the CPU default
# is what a machine with no GPU, or KARAOKE_GPU=off, builds against.
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu

# torch first from TORCH_INDEX, or something else pulls a different build in
# behind it, and in its own layer so editing requirements doesn't redo a multi-GB
# install. torchaudio comes from the same place so its build matches torch's,
# demucs uses it to read audio. UV_HTTP_TIMEOUT goes up for the slow ROCm CDN, or
# a big wheel trips uv's stall timeout.
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
#   timed words for the lyric track. Pairing rules and the reason STT_DEVICE stays
#   cpu are documented once in docker/tts.Dockerfile. Songs are long, so sizing the
#   model up here costs less than it does on chat.
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
