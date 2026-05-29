# Base image is swappable so the same Dockerfile builds for CPU/NVIDIA
# (ollama/ollama:latest) or AMD ROCm (ollama/ollama:rocm). start.sh / the
# compose overlays set this; it defaults to the CUDA+CPU image.
ARG OLLAMA_BASE=ollama/ollama:latest
FROM ${OLLAMA_BASE}

# curl for the readiness probe in the entrypoint.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

COPY docker/ollama-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
