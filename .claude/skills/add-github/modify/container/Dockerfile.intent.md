# Intent: container/Dockerfile modifications

## What changed
Added GitHub CLI (`gh`) installation from GitHub's official apt repository, placed after the existing system dependencies block.

## Key sections

### gh CLI installation
- Added after the `rm -rf /var/lib/apt/lists/*` line that closes the system dependencies block:
  ```dockerfile
  RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
      && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
      && apt-get update && apt-get install -y gh \
      && rm -rf /var/lib/apt/lists/*
  ```
- Uses the official GitHub apt repo with signed keyring
- Cleans apt lists to minimize image size

## Invariants
- All existing system dependencies (chromium, fonts, curl, git) are unchanged
- The Chromium env vars below are unchanged
- All subsequent steps (npm install, COPY, build, entrypoint) are unchanged

## Must-keep
- The existing `apt-get install` block for system dependencies
- The `AGENT_BROWSER_EXECUTABLE_PATH` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` env vars
- The npm global install of `agent-browser` and `@anthropic-ai/claude-code`
- The entire build, COPY, and entrypoint sequence
