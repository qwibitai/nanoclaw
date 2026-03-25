# container/Dockerfile.ws
# NanoClaw K8s / WebSocket Management Mode
# Runs Claude CLI as child processes behind a WebSocket management API

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install claude-code globally
RUN npm install -g @anthropic-ai/claude-code

# Management server + channel runtime
WORKDIR /ws
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY dist/ ./dist/

# Config directory for .env
RUN mkdir -p /home/node/.nanoclaw && chown node:node /home/node/.nanoclaw

# Expose management API port
EXPOSE 18789

# Non-root user
USER node
WORKDIR /home/node

CMD ["node", "/ws/dist/k8s-entrypoint.js"]
