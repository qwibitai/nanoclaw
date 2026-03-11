# Container Build Mirror Acceleration

**Date:** 2026-03-11
**Status:** Approved
**Branch:** `feat/container-build-mirrors`

## Problem

Building the NanoClaw agent container in China is slow because:
1. `apt-get install` pulls from `deb.debian.org` (international)
2. `npm install` pulls from `registry.npmjs.org` (international)

## Goal

Allow apt and npm mirror sources to be configured via `.env` variables, with China-optimized mirrors set as the default values in `.env.example`.

## Design

### Approach: Build ARGs injected from `.env`

- `.env` (and `.env.example`) define mirror variables
- `container/build.sh` reads `.env` and passes values as `--build-arg`
- `Dockerfile` accepts ARGs and applies mirrors conditionally before each install step
- Empty value = upstream default (safe for international use, no code changes required)

---

## Variables

| Variable | Default in `.env.example` | Description |
|---|---|---|
| `APT_MIRROR` | `mirrors.ustc.edu.cn` | Debian apt mirror hostname. Replaces `deb.debian.org` and `security.debian.org` in `/etc/apt/sources.list.d/debian.sources`. |
| `NPM_REGISTRY` | `https://registry.npmmirror.com` | npm registry URL. Set via `npm config set registry` before all npm install steps. |

Both variables are optional. Leaving either unset or empty falls back to upstream defaults.

**Mirror rationale:**
- **USTC** (`mirrors.ustc.edu.cn`): University of Science and Technology of China. Stable, fast, well-maintained. Hosts Debian, Ubuntu, and other distros.
- **npmmirror** (`registry.npmmirror.com`): Official Taobao/Alibaba npm mirror for China. Syncs from npm every 10 minutes.

---

## File Changes

### `.env.example`

```env
# Container build mirrors (China-optimized defaults, leave empty for international)
APT_MIRROR=mirrors.ustc.edu.cn
NPM_REGISTRY=https://registry.npmmirror.com
```

### `container/Dockerfile`

Add ARG declarations after `FROM`, then apply mirrors inline before each install step:

```dockerfile
FROM node:22-slim

# Build-time mirror configuration (leave empty for international defaults)
ARG APT_MIRROR=
ARG NPM_REGISTRY=

# Configure apt mirror and install system dependencies
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" \
        /etc/apt/sources.list.d/debian.sources; \
    fi && \
    apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    ... \
    && rm -rf /var/lib/apt/lists/*

# Configure npm registry
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code
# (remaining steps unchanged)
```

Notes:
- `node:22-slim` is Debian Bookworm, which uses DEB822 format at `/etc/apt/sources.list.d/debian.sources`
- The `npm config set registry` RUN writes to `/root/.npmrc`, which persists across all subsequent npm install layers
- ARG values are build-time only — not embedded in the final image environment

### `container/build.sh`

Load `.env` from the project root and pass non-empty mirror vars as `--build-arg`:

```bash
# Load .env from project root
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
if [ -f "$ROOT_DIR/.env" ]; then
  set -a && source "$ROOT_DIR/.env" && set +a
fi

# Collect build args for mirror configuration
BUILD_ARGS=""
[ -n "${APT_MIRROR:-}" ]    && BUILD_ARGS="$BUILD_ARGS --build-arg APT_MIRROR=$APT_MIRROR"
[ -n "${NPM_REGISTRY:-}" ]  && BUILD_ARGS="$BUILD_ARGS --build-arg NPM_REGISTRY=$NPM_REGISTRY"

${CONTAINER_RUNTIME} build $BUILD_ARGS -t "${IMAGE_NAME}:${TAG}" .
```

---

## Behavior Summary

| Scenario | APT_MIRROR | NPM_REGISTRY | Result |
|---|---|---|---|
| China (default) | `mirrors.ustc.edu.cn` | `https://registry.npmmirror.com` | Fast build |
| International | (empty) | (empty) | Upstream defaults |
| Custom | any hostname | any URL | Respected |

---

## Out of Scope

- Runtime mirror configuration (these are build-time only)
- Auto-detection of network location
- pip/other package managers (not used in this container)
