# TTS sidecar (Kokoro-82M + pocket-tts). CPU build by default - both models are
# small enough to hit comfortable real-time on CPU. GPU is opt-in: the nvidia /
# amd compose overlays set TORCH_INDEX to a CUDA / ROCm wheel index and reserve a
# GPU for this service, and TTS_DEVICE (below) selects the runtime device.
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
# CUDA wheels; the nvidia/amd overlays override this to a GPU wheel index.
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu

COPY tts/requirements.txt /app/requirements.txt
# Install torch first (from TORCH_INDEX) so the resolver doesn't later pull a
# different build in as a transitive dependency.
RUN pip install --no-cache-dir torch --index-url ${TORCH_INDEX} \
 && pip install --no-cache-dir -r /app/requirements.txt

COPY tts/server.py /app/server.py

# TTS_DEVICE: cpu | cuda | auto. "auto" uses the GPU when the installed torch
# exposes one (so it's a no-op on the default CPU build).
ENV TTS_HOST=0.0.0.0 \
    TTS_PORT=8001 \
    TTS_DEVICE=auto \
    HF_HOME=/root/.cache/huggingface

EXPOSE 8001

CMD ["python", "server.py"]
