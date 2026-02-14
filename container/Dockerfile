# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM

FROM oven/bun:slim

# Install Node.js (agents expect node/npm/npx to be available alongside bun)
# and essential system tools
RUN apt-get update && apt-get install -y \
    nodejs \
    npm \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI for PR creation and git authentication
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

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

# Set ownership to node user (non-root) for writable directories
RUN chown -R bun:bun /workspace

# Pre-warm tsgo (native TypeScript checker) so `npx tsgo` / `bunx tsgo` works.
# Host-mounted projects have darwin-arm64 binaries; npm global install puts the
# linux-arm64 binary in /usr/local/bin where all users can access it.
RUN npm install -g @typescript/native-preview @typescript/native-preview-linux-arm64

# Switch to non-root user (required for --dangerously-skip-permissions)
USER bun

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
