# Kokoro TTS sidecar. CPU build by default — Kokoro-82M is small enough to
# hit comfortable real-time on CPU. For CUDA, install a torch wheel from the
# pytorch CUDA index before `pip install -r requirements.txt`.
FROM python:3.11-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      espeak-ng \
      libsndfile1 \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY tts/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY tts/server.py /app/server.py

ENV TTS_HOST=0.0.0.0 \
    TTS_PORT=8001 \
    HF_HOME=/root/.cache/huggingface

EXPOSE 8001

CMD ["python", "server.py"]
