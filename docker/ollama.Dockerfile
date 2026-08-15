# You can swap the base image, so this one Dockerfile builds for CPU and NVIDIA
# with the pinned Ollama release, or its matching ROCm build. start.sh
# and the compose overlays set it, the default is the CUDA and CPU image.
ARG OLLAMA_BASE=ollama/ollama:0.30.8
FROM ${OLLAMA_BASE}

# curl, for the readiness probe in the entrypoint.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

COPY docker/ollama-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
