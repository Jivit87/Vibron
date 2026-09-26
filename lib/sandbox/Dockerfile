/**
 * Dockerfile for the Viberon sandbox image.
 *
 * A slim image with Node.js 20, Python 3, and essential build tools.
 * Used by `lib/sandbox` when executing commands in Docker isolation.
 *
 * Build:
 *   docker build -t viberon/sandbox:latest -f lib/sandbox/Dockerfile .
 */
FROM node:20-slim

# Install Python 3, pip, git, and essential build tools.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    git \
    build-essential \
    curl \
    jq \
    ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Create a symlink so `python` resolves to `python3`.
RUN ln -sf /usr/bin/python3 /usr/bin/python

# Install common global tools.
RUN npm install -g pnpm yarn typescript tsx vitest jest

# Set up a non-root user for safer execution.
RUN groupadd -r viberon && useradd -r -g viberon -m viberon

# Working directory will be the bind-mounted workspace.
WORKDIR /workspace

# Default entrypoint is sleep (the container stays alive for docker exec).
ENTRYPOINT ["sleep"]
CMD ["infinity"]
