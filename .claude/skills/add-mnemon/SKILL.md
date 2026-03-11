---
name: add-mnemon
description: Add persistent graph-based memory via mnemon. Agents recall past context before responding and remember insights after.
---

# Add Mnemon — Persistent Memory

Modify `container/Dockerfile` to install mnemon and run `mnemon setup` at container start.

## Dockerfile changes

**1. Install binary** — add after the Chromium ENV block, before `npm install -g`:

```dockerfile
ARG MNEMON_VERSION=0.1.1
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/mnemon-dev/mnemon/releases/download/v${MNEMON_VERSION}/mnemon_${MNEMON_VERSION}_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin mnemon && \
    chmod +x /usr/local/bin/mnemon

ENV MNEMON_DATA_DIR=/home/node/.claude/mnemon
```

**2. Add setup to entrypoint** — insert `mnemon setup --target claude-code --yes --global 2>&1 >&2\n` after `set -e\n` in the existing printf line.

## Rebuild

```bash
./container/build.sh && docker run --rm --entrypoint mnemon nanoclaw-agent:latest --version
```

`mnemon setup` runs at each container start (idempotent), automatically configuring Claude Code hooks and skills. `MNEMON_DATA_DIR` stores data inside the existing per-group `.claude/` mount — no extra volume mounts needed.
