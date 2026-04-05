FROM denoland/deno:2.1.4

# Install Node.js (needed by claude-code CLI) and npm
RUN apt-get update && apt-get install -y \
    curl ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install claude-code CLI globally (Agent SDK spawns this as subprocess)
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user (claude-code refuses --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash nexus

WORKDIR /app

# Cache dependencies first
COPY deno.json package.json ./
RUN deno install

# Application code
COPY src/ src/

# Shared IP: skills and knowledge baked into image
COPY skills/ skills/
COPY knowledge/ knowledge/

# Operator data (selected at runtime via OPERATOR_SLUG env var)
COPY dev-data/ dev-data/

# Workspace and Claude settings for non-root user
RUN mkdir -p /tmp/nexus-workspace && chown -R nexus:nexus /tmp/nexus-workspace
RUN mkdir -p /home/nexus/.claude && \
    echo '{"hasCompletedOnboarding":true}' > /home/nexus/.claude/settings.json && \
    chown -R nexus:nexus /home/nexus/.claude

# Ensure app is readable by nexus user
RUN chown -R nexus:nexus /app

USER nexus

EXPOSE 3001

# CMD set per process group in fly.toml
