# TTS sidecar (Kokoro-82M + pocket-tts). CPU build by default — both models are
# small enough to hit comfortable real-time on CPU. For CUDA, swap the torch
# install below for a wheel from the pytorch CUDA index.
FROM python:3.11-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      espeak-ng \
      libsndfile1 \
      ca-certificates \
      curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY tts/requirements.txt /app/requirements.txt
# Install the CPU torch wheel first so pocket-tts/kokoro don't drag in CUDA wheels.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir -r /app/requirements.txt

COPY tts/server.py /app/server.py

ENV TTS_HOST=0.0.0.0 \
    TTS_PORT=8001 \
    HF_HOME=/root/.cache/huggingface

EXPOSE 8001

CMD ["python", "server.py"]
