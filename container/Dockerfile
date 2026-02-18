# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM

FROM oven/bun:slim

# Install Node.js (agents expect node/npm/npx to be available alongside bun)
# and essential system tools including Go
RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs \
    npm \
    curl \
    git \
    wget \
    openssh-client \
    jq \
    ripgrep \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install yq (YAML processor, like jq for YAML)
RUN ARCH="$(dpkg --print-architecture)" \
    && wget -q "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_${ARCH}" -O /usr/bin/yq \
    && chmod +x /usr/bin/yq

# Install Go (latest stable version) - cross-platform support
ARG GO_VERSION=1.25.0
RUN ARCH="$(dpkg --print-architecture)" \
    && wget -q "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" \
    && tar -C /usr/local -xzf "go${GO_VERSION}.linux-${ARCH}.tar.gz" \
    && rm "go${GO_VERSION}.linux-${ARCH}.tar.gz"

# Set Go environment variables
ENV PATH="/usr/local/go/bin:${PATH}"
ENV GOPATH="/home/bun/go"
ENV PATH="${GOPATH}/bin:${PATH}"
ENV CGO_ENABLED=1

# Install just command runner (required for ditto backend development)
ARG JUST_VERSION=1.46.0
RUN ARCH="$(dpkg --print-architecture)" \
    && JUST_ARCH=$([ "$ARCH" = "amd64" ] && echo "x86_64" || echo "aarch64") \
    && wget -q "https://github.com/casey/just/releases/download/${JUST_VERSION}/just-${JUST_VERSION}-${JUST_ARCH}-unknown-linux-musl.tar.gz" \
    && tar -xzf "just-${JUST_VERSION}-${JUST_ARCH}-unknown-linux-musl.tar.gz" \
    && mv just /usr/local/bin/just \
    && chmod +x /usr/local/bin/just \
    && rm "just-${JUST_VERSION}-${JUST_ARCH}-unknown-linux-musl.tar.gz"

# Install GitHub CLI for PR creation and git authentication
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install Graphite CLI for stacked PRs workflow (pinned to stable version)
ARG GRAPHITE_VERSION=1.7.16
RUN npm install -g @withgraphite/graphite-cli@${GRAPHITE_VERSION}

# Install claude-code globally
# Note: agent-browser is available as an on-demand skill (installed on first use)
RUN bun install -g @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY container/agent-runner/package.json container/agent-runner/bun.lock* ./

# Install dependencies
RUN bun install

# Copy source code
COPY container/agent-runner/ ./

# Copy shared utilities and MCP servers
COPY container/mcp-servers/ /app/mcp-servers/
COPY src/shared/ /app/shared/

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/server /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Copy entrypoint script
# Sources env, configures git, pre-installs cross-platform deps for host mounts,
# buffers stdin, then runs agent-runner
COPY container/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Set ownership to bun user (non-root) for writable directories
RUN chown -R bun:bun /workspace && chmod 777 /home/bun

# Pre-warm tsgo (native TypeScript checker) so `npx tsgo` / `bunx tsgo` works.
# Host-mounted projects may have platform-specific binaries; npm global install
# puts the correct linux binary in /usr/local/bin where all users can access it.
RUN ARCH="$(dpkg --print-architecture)" \
    && TSGO_ARCH=$([ "$ARCH" = "amd64" ] && echo "x64" || echo "$ARCH") \
    && npm install -g @typescript/native-preview "@typescript/native-preview-linux-${TSGO_ARCH}"

# Switch to non-root user (required for --dangerously-skip-permissions)
USER bun

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
