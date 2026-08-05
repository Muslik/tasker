FROM mcr.microsoft.com/playwright:v1.58.1-jammy

ARG MISE_VERSION=v2026.8.2
ARG CODEX_VERSION=0.146.1
ARG CLAUDE_CODE_VERSION=2.1.222

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      git \
      jq \
      openssh-client \
      python3 \
      python3-venv \
      ripgrep \
    && rm -rf /var/lib/apt/lists/*

ENV MISE_INSTALL_PATH=/usr/local/bin/mise
RUN curl --fail --silent --show-error https://mise.run \
    | MISE_VERSION=${MISE_VERSION} sh

RUN npm install --global \
      "@openai/codex@${CODEX_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force

ENV HOME=/tasker-home
ENV MISE_DATA_DIR=/mise-data
ENV MISE_CONFIG_DIR=/tasker-home/.config/mise
ENV MISE_CACHE_DIR=/mise-cache
ENV PATH=/mise-data/shims:/usr/local/bin:/usr/bin:/bin

WORKDIR /workspace
CMD ["bash"]
