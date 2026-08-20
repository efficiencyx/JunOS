# You can swap the base image, so this one Dockerfile builds for CPU and NVIDIA
# with the pinned Ollama release, or its matching ROCm build. start.sh
# and the compose overlays set it, the default is the CUDA and CPU image.
#
# 0.32.x is a FLOOR, don't pin lower. the MTP drafter gguf
# (OLLAMA_MTP in .env) carries architecture gemma4-assistant, and
# ollama's bundled llama.cpp only learned that arch in 0.32. on 0.30.8
# llama-server dies with "unknown model architecture" while loading the
# DRAFT layer, which kills jun-mtp, which is the model php actually
# runs. every chat 500s and the container still reports healthy.
ARG OLLAMA_BASE=ollama/ollama:0.32.6
FROM ${OLLAMA_BASE}

# curl, for the readiness probe in the entrypoint.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

COPY docker/ollama-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
