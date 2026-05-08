# syntax=docker/dockerfile:1.7
# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation.
#
# Runtime split:
#   - agent-runner (our TypeScript code): Bun, mounted RO at /app/src by host
#   - globally-installed Node CLIs (claude-code, agent-browser, vercel, gitnexus): pnpm + Node
#
# Source is never baked in — /app/src is provided by a shared read-only
# bind mount at runtime (see src/container-runner.ts). Source-only changes
# never require an image rebuild.
#
# Illysium additions on top of upstream/v2:
#   - GitHub CLI (gh) — used by git-worktree MCP tools for `gh pr create`
#   - PostgreSQL + Redis clients, Python + dbt + snowflake-cli — data-team tooling
#   - gitnexus CLI (global) — code intelligence used by agents

# ---- mcp-toolbox alias stage -------------------------------------------------
# Google publishes the toolbox as a multi-arch distroless image but does NOT
# publish a linux/arm64 prebuilt at storage.googleapis.com. The alias FROM
# lets us pull the binary via COPY --from below while keeping the version
# pinned via build-arg.
ARG MCP_TOOLBOX_VERSION=1.1.0
FROM us-central1-docker.pkg.dev/database-toolbox/toolbox/toolbox:${MCP_TOOLBOX_VERSION} AS mcp-toolbox-src

# ---- rtk builder stage -------------------------------------------------------
# RTK (https://github.com/rtk-ai/rtk) is a Rust binary used as a Bash
# PreToolUse hook to compress command output (60-90% token savings). Upstream
# only ships an aarch64-gnu binary built against glibc 2.39 (Ubuntu 24.04),
# which doesn't run on bookworm's glibc 2.36. We compile from a pinned tag
# in this builder stage and copy the resulting binary into the final image —
# Rust toolchain stays in the builder layer, never reaches runtime.
FROM rust:1-bookworm AS rtk-builder
ARG RTK_VERSION=0.39.0
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    cargo install --git https://github.com/rtk-ai/rtk --tag "v${RTK_VERSION}" --locked --root /out rtk

FROM node:22-slim

# ---- Build-time arguments ----------------------------------------------------
# CJK fonts add ~200MB. Opt in only if you render Chinese/Japanese/Korean text.
ARG INSTALL_CJK_FONTS=false

# Pin CLI versions for reproducibility. Bump deliberately — unpinned installs
# mean every rebuild silently picks up the latest and can break in lockstep
# across all users.
ARG CLAUDE_CODE_VERSION=2.1.119
ARG AGENT_BROWSER_VERSION=latest
ARG VERCEL_VERSION=52.2.1
ARG GITNEXUS_VERSION=latest
ARG BUN_VERSION=1.3.13
ARG MMDC_VERSION=11.12.0
ARG GWS_VERSION=0.22.5
ARG CODEX_VERSION=0.124.0
ARG DBT_MCP_VERSION=1.15.0

# ---- System dependencies -----------------------------------------------------
# tini: correct PID 1 / signal forwarding so outbound.db writes finalize on
# SIGTERM instead of being orphaned by the shell entrypoint.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
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
        ca-certificates \
        curl \
        git \
        jq \
        less \
        tini \
        unzip \
        xz-utils \
        postgresql-client \
        redis-tools \
        python3 \
        python3-pip \
        python3-venv \
    && if [ "$INSTALL_CJK_FONTS" = "true" ]; then \
        apt-get install -y --no-install-recommends fonts-noto-cjk; \
       fi

# GitHub CLI (official apt repo). Kept in a separate layer so the dep cache
# above still hits when only gh bumps.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Data tools via isolated venvs (PEP 668 — Debian disallows system-wide pip).
# snow and dbt have conflicting transitive deps (notably on click + urllib3),
# so they live in separate venvs with symlinks on PATH. Layout mirrors v1:
#   /opt/snow-venv/bin/snow → /usr/local/bin/snow
#   /opt/dbt-venv/bin/dbt → /usr/local/bin/dbt
RUN python3 -m venv /opt/snow-venv \
    && /opt/snow-venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel \
    && /opt/snow-venv/bin/pip install --no-cache-dir snowflake-cli==3.16.0 \
    && ln -sf /opt/snow-venv/bin/snow /usr/local/bin/snow

RUN python3 -m venv /opt/dbt-venv \
    && /opt/dbt-venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel \
    && /opt/dbt-venv/bin/pip install --no-cache-dir dbt-core==1.11.8 dbt-snowflake==1.11.4 \
    && ln -sf /opt/dbt-venv/bin/dbt /usr/local/bin/dbt

# sooperset/mcp-atlassian — stdio MCP server for Jira + Confluence (72 tools).
# Isolated venv to avoid clashing with snow/dbt transitive deps.
ARG MCP_ATLASSIAN_VERSION=0.21.1
RUN python3 -m venv /opt/atlassian-venv \
    && /opt/atlassian-venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel \
    && /opt/atlassian-venv/bin/pip install --no-cache-dir "mcp-atlassian==${MCP_ATLASSIAN_VERSION}" \
    && ln -sf /opt/atlassian-venv/bin/mcp-atlassian /usr/local/bin/mcp-atlassian

# dbt-labs/dbt-mcp — stdio MCP server for dbt Cloud (Discovery + Semantic Layer
# + Admin API + dbt CLI/LSP). Requires Python >=3.12; node:22-slim (bookworm)
# only ships 3.11, so we use uv to install a managed Python 3.12 and isolate
# dbt-mcp's deps. uv lives in its own venv to match the snow/dbt/atlassian
# isolation pattern.
RUN python3 -m venv /opt/uv-venv \
    && /opt/uv-venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel \
    && /opt/uv-venv/bin/pip install --no-cache-dir uv \
    && ln -sf /opt/uv-venv/bin/uv /usr/local/bin/uv \
    && ln -sf /opt/uv-venv/bin/uvx /usr/local/bin/uvx \
    && UV_TOOL_DIR=/opt/uv-tools \
       UV_TOOL_BIN_DIR=/usr/local/bin \
       UV_PYTHON_INSTALL_DIR=/opt/uv-python \
       uv tool install --python 3.12 "dbt-mcp==${DBT_MCP_VERSION}" \
    && chmod -R a+rX /opt/uv-tools /opt/uv-python

# AWS CLI v2 (isolated from pip to avoid version churn)
RUN ARCH=$(uname -m) \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${ARCH}.zip" -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/awscli.zip /tmp/aws

# Google Cloud SDK (gcloud, gsutil) — needs gpg to verify apt repo signature
RUN apt-get update && apt-get install -y --no-install-recommends gnupg \
    && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
      | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
      > /etc/apt/sources.list.d/google-cloud-sdk.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-cloud-cli \
    && rm -rf /var/lib/apt/lists/*

# Render / Railway / Supabase CLIs (released as prebuilt binaries)
ARG RENDER_VERSION=2.15.1
ARG RAILWAY_VERSION=4.42.0
ARG SUPABASE_VERSION=2.90.0
RUN DPKG_ARCH=$(dpkg --print-architecture) && UARCH=$(uname -m) \
    && curl -fsSL "https://github.com/render-oss/cli/releases/download/v${RENDER_VERSION}/cli_${RENDER_VERSION}_linux_${DPKG_ARCH}.zip" \
       -o /tmp/render.zip \
    && unzip -q /tmp/render.zip -d /tmp/render \
    && mv /tmp/render/cli_v${RENDER_VERSION} /usr/local/bin/render \
    && chmod +x /usr/local/bin/render \
    && curl -fsSL "https://github.com/railwayapp/cli/releases/download/v${RAILWAY_VERSION}/railway-v${RAILWAY_VERSION}-${UARCH}-unknown-linux-musl.tar.gz" \
       | tar xz -C /usr/local/bin railway \
    && chmod +x /usr/local/bin/railway \
    && curl -fsSL "https://github.com/supabase/cli/releases/download/v${SUPABASE_VERSION}/supabase_${SUPABASE_VERSION}_linux_${DPKG_ARCH}.deb" \
       -o /tmp/supabase.deb \
    && dpkg -i /tmp/supabase.deb \
    && rm -rf /tmp/render.zip /tmp/render /tmp/supabase.deb

# Google MCP Toolbox for Databases — provides --prebuilt looker stdio MCP.
# Binary copied from the alias stage declared at the top of this Dockerfile.
COPY --from=mcp-toolbox-src /toolbox /usr/local/bin/toolbox

# Pinned mnemon binary — auto-tracked by /update-container audit.
# Per-arch SHA256 from https://github.com/mnemon-dev/mnemon/releases/download/v0.1.2/checksums.txt
ARG MNEMON_VERSION=0.1.2
ARG MNEMON_SHA256_arm64=e9acb178843605a813520dacce10f8f3b3608df65841c238f0b3b768b74cd025
ARG MNEMON_SHA256_amd64=a18aa4304e4d904cb80e46a099efbd95bf0b1486381757be89cd234844603347

RUN ARCH=$(dpkg --print-architecture) \
    && SHA=$(if [ "$ARCH" = "arm64" ]; then echo "$MNEMON_SHA256_arm64"; else echo "$MNEMON_SHA256_amd64"; fi) \
    && curl -fsSL "https://github.com/mnemon-dev/mnemon/releases/download/v${MNEMON_VERSION}/mnemon_${MNEMON_VERSION}_linux_${ARCH}.tar.gz" -o /tmp/mnemon.tar.gz \
    && echo "$SHA  /tmp/mnemon.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/mnemon.tar.gz -C /tmp mnemon \
    && mv /tmp/mnemon /usr/local/bin/mnemon-real \
    && chmod +x /usr/local/bin/mnemon-real \
    && rm -rf /tmp/mnemon*

# Wrapper script (created in Task A2). Symlinked to canonical PATH location.
COPY mnemon-wrapper.sh /usr/local/bin/mnemon-wrapper.sh
RUN chmod +x /usr/local/bin/mnemon-wrapper.sh \
    && ln -s /usr/local/bin/mnemon-wrapper.sh /usr/local/bin/mnemon \
    && /usr/local/bin/mnemon --version

# Hex CLI — closed-source Rust binary released as multi-arch tarballs at
# https://github.com/hex-inc/hex-cli/releases. Auth is OAuth-only (no static
# token env var); the real `hex` binary reads XDG_CONFIG_HOME, and the
# wrapper at /usr/local/bin/hex points it at the mount staging path. SHA256s
# pinned per-arch — bump the version + recompute both via:
#   curl -sL https://github.com/hex-inc/hex-cli/releases/download/v$V/hex-aarch64-unknown-linux-gnu.tar.xz | sha256sum
#   curl -sL https://github.com/hex-inc/hex-cli/releases/download/v$V/hex-x86_64-unknown-linux-gnu.tar.xz  | sha256sum
ARG HEX_CLI_VERSION=1.2.2
ARG HEX_CLI_SHA256_arm64=d560af1ac9f8b2cc8f1729d02fe900be3db7a412482fd960d9097f03719de14a
ARG HEX_CLI_SHA256_amd64=5ab71cecc3da7ee5a5e290f9bf96ed87c49792ac70ecac56335238c95d66186b

RUN ARCH=$(dpkg --print-architecture) \
    && case "$ARCH" in \
         arm64) RARCH=aarch64; SHA="$HEX_CLI_SHA256_arm64" ;; \
         amd64) RARCH=x86_64;  SHA="$HEX_CLI_SHA256_amd64" ;; \
         *) echo "Unsupported arch for hex CLI: $ARCH" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/hex-inc/hex-cli/releases/download/v${HEX_CLI_VERSION}/hex-${RARCH}-unknown-linux-gnu.tar.xz" \
       -o /tmp/hex.tar.xz \
    && echo "$SHA  /tmp/hex.tar.xz" | sha256sum -c - \
    && tar -xf /tmp/hex.tar.xz -C /tmp \
    && install -m 0755 "/tmp/hex-${RARCH}-unknown-linux-gnu/hex" /usr/local/bin/hex-real \
    && rm -rf /tmp/hex*

COPY hex-wrapper.sh /usr/local/bin/hex-wrapper.sh
RUN chmod +x /usr/local/bin/hex-wrapper.sh \
    && ln -s /usr/local/bin/hex-wrapper.sh /usr/local/bin/hex \
    && /usr/local/bin/hex-real --version

# rtk binary — built from the pinned tag in the rtk-builder stage at the top
# of this Dockerfile. We don't use the upstream prebuilt aarch64 release
# because it requires glibc 2.39 (we're on 2.36).
COPY --from=rtk-builder /out/bin/rtk /usr/local/bin/rtk
RUN /usr/local/bin/rtk --version

# Chromium path for agent-browser / Playwright / mmdc consumers
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
# Belt-and-braces: prevent Playwright's postinstall from downloading its own
# ~300MB Chromium. We've already installed the system one above.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# mmdc reuses the system Chromium instead of downloading its own.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=1

# ---- Bun runtime -------------------------------------------------------------
# Install via the official script (handles multi-arch detection), then move
# the binary to /usr/local/bin so the non-root `node` user can execute it.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && \
    install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /root/.bun

# ---- agent-runner deps -------------------------------------------------------
# Deps are cached independently of CLI versions. Source is NOT baked in —
# it's provided by the shared RO mount at runtime.
WORKDIR /app

COPY agent-runner/package.json agent-runner/bun.lock ./

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---- pnpm + global Node CLIs -------------------------------------------------
# Most stable first, most frequently bumped last. Bumping claude-code
# (the most common change) only invalidates one layer.
#
# only-built-dependencies gates pnpm's supply-chain policy:
#   - agent-browser has a postinstall build step.
#   - @anthropic-ai/claude-code's postinstall downloads the native Claude
#     binary (linux-arm64 variant on our image). Without the allowlist
#     the SDK fails at spawn time with "native binary not found".
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Pin pnpm to a known-good 10.x via corepack. Without a pin, corepack resolves
# whatever's "latest" (currently pnpm 11), which introduced two breaking changes
# we hit on rebuild: (1) global bin moved to $PNPM_HOME/bin (PATH miss), and
# (2) `blockExoticSubdeps=true` by default rejects git-resolved subdeps like
# `tree-sitter-dart` inside `gitnexus`. Pinning preserves the behavior the
# global-install block below was written against.
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate

RUN --mount=type=cache,target=/root/.cache/pnpm \
    echo "only-built-dependencies[]=agent-browser" > /root/.npmrc && \
    echo "only-built-dependencies[]=@anthropic-ai/claude-code" >> /root/.npmrc && \
    echo "only-built-dependencies[]=@googleworkspace/cli" >> /root/.npmrc && \
    pnpm install -g "vercel@${VERCEL_VERSION}"

RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "agent-browser@${AGENT_BROWSER_VERSION}"

RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# Illysium additions: code-intelligence + diagram + Google Workspace CLIs.
# Codex CLI (@openai/codex) is invoked by /team-qa Validator E for
# cross-model adversarial review; authenticated via the host's ~/.codex
# mount (see src/container-runner.ts:581).
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g \
        "gitnexus@${GITNEXUS_VERSION}" \
        "@mermaid-js/mermaid-cli@${MMDC_VERSION}" \
        "@googleworkspace/cli@${GWS_VERSION}" \
        "@openai/codex@${CODEX_VERSION}"

# Puppeteer config used by mmdc — points at the system Chromium and passes
# --no-sandbox, without which mmdc launches and silently exits 0 producing no
# output on Debian containers that lack unprivileged user namespaces.
COPY puppeteer-config.json /app/puppeteer-config.json

# ---- Entrypoint --------------------------------------------------------------
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# ---- Workspace + permissions -------------------------------------------------
# Remap the `node` user+group to UID/GID 1001 before any chowns so the
# container's runtime UID matches the host's non-root user. Host-side
# processes (setup scripts, group-init, systemd unit user) run as UID 1001,
# and host-owned bind mounts — notably `.claude-shared/` at /home/node/.claude
# — arrive in the container at UID 1001. Without this remap, the container's
# `node` (UID 1000) can *read* those dirs under 755 perms but can't *write*,
# which silently freezes Claude Code auto-memory and autodream pruning. The
# base image's UID 1000 is arbitrary; no baked dir hard-codes it.
ARG HOST_UID=1001
ARG HOST_GID=1001
RUN groupmod -g ${HOST_GID} node && usermod -u ${HOST_UID} -g ${HOST_GID} node && \
    mkdir -p /workspace/group /workspace/global /workspace/extra && \
    chown -R ${HOST_UID}:${HOST_GID} /workspace /home/node && \
    chmod 755 /home/node

USER node
WORKDIR /workspace/group

# tini is PID 1, reaps zombies, forwards signals cleanly. entrypoint.sh does
# `exec bun ...` so bun runs as tini's direct child.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]

# Stamp the source repo's HEAD commit as an image label so the rebuild
# watcher (src/container-rebuild-watcher.ts) can tell whether the image
# reflects the latest origin/main. Must be a LABEL instruction driven by
# ARG — not a `docker build --label` flag — because `--label` is silently
# dropped on fully-cached rebuilds, but a LABEL layer tied to a changing
# ARG invalidates and re-stamps. Upstream layers stay cached (ARG not
# referenced earlier), so the rebuild is near-instant.
ARG NANOCLAW_COMMIT=unknown
LABEL nanoclaw.commit=$NANOCLAW_COMMIT
