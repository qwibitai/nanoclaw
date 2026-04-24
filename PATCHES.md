# PATCHES — jsboige/nanoclaw fork

Minimal `src/` and `container/` patches applied on top of upstream v2. Every entry includes its commit hash, reason, and exit condition. Target: ≤ 10 active patches at any time. Monthly review removes those whose exit condition is satisfied.

Baseline: upstream `main` at `a4346f5` (v2.0.10 + fixes) — migration 2026-04-24.

## Anti-divergence discipline

Before adding a new patch, verify none of these alternatives suffice:

1. Config value / env var / `.env` entry
2. Skill in `.claude/skills/<name>/` or `container/skills/<name>/`
3. Fragment in `groups/<folder>/CLAUDE.local.md` (per-group) or append to `container/CLAUDE.md` (global)
4. MCP server entry in `groups/<folder>/container.json:mcpServers`
5. Branch-installed channel/provider (via `/add-<name>` skill)

If none works, document the patch here with justification.

---

## Active patches

### 1. Host env passthrough to container

- **Commits:** `bb244ac` (initial: GH_TOKEN_*, MCP_*, ASR_*), `658fa09` (extension: ANTHROPIC_*, LOCAL_MEDIUM_*, LOCAL_MINI_*)
- **File:** `src/container-runner.ts` (function `buildContainerArgs`, after `TZ` arg)
- **Summary:** Allowlist of env var prefixes copied from host `process.env` to container spawn args as `-e KEY=VALUE`. Prefixes: `ANTHROPIC_`, `GH_TOKEN_`, `MCP_`, `ASR_`, `LOCAL_MEDIUM_`, `LOCAL_MINI_`.
- **Why:** v2 has no per-group env passthrough mechanism. `container.json:McpServerConfig.env` only applies to MCP subprocesses, not the agent runtime. Several features need host env inside the container:
  - `ANTHROPIC_*` — z.ai credentials read directly by the Claude SDK (bypasses optional OneCLI gateway — see patch #2 notes below)
  - `GH_TOKEN_*` — `multi-identity-github` skill switches `gh auth` per repo owner
  - `MCP_PROXY_BEARER`, `MCP_TOOL_TIMEOUT_MS` — roo-state-manager HTTP MCP via `mcp-remote` stdio wrapper
  - `ASR_*` — voice-transcription integration (host-side Whisper endpoint)
  - `LOCAL_MEDIUM_*`, `LOCAL_MINI_*` — internal vLLM endpoints
- **Exit condition:** Upstream adds a `container.json:env` field (per-group env passthrough) or a `src/container-runner.ts` hook for supplementary env.
- **Lines:** ~14

### 2. `${VAR}` expansion in container.json mcpServers

- **Commit:** `bb244ac`
- **File:** `container/agent-runner/src/config.ts` (new `expandEnv()` helper + call in `loadConfig()`)
- **Summary:** Recursive `${VAR}` string substitution on `raw.mcpServers` when loading container config. Reads `process.env[VAR]` at runtime.
- **Why:** `groups/main/container.json` declares the roo-state-manager MCP with a bearer token. Keeping `MCP_PROXY_BEARER=<secret>` in `.env` (host, gitignored) and referencing it as `${MCP_PROXY_BEARER}` in the committed container.json is the only way to keep the config in git without leaking credentials.
- **Exit condition:** Upstream accepts PR adding env expansion natively to container config loading, or switches mcpServers credential handling to a vault-based flow.
- **Lines:** ~15

### 3. Non-negotiable rules in container/CLAUDE.md

- **Commit:** `bb244ac`
- **File:** `container/CLAUDE.md`
- **Summary:** Append 8 non-negotiable cluster rules + PR review requirements after the existing v2 content.
- **Why:** These rules must apply to ALL agents in this install. v2 removes `groups/global/` (the v1 location). Alternatives considered: (a) per-group `CLAUDE.local.md` duplication — fragile, easy to forget for new groups; (b) a skill — skills are toggleable per-group, these rules must not be. `container/CLAUDE.md` is the only always-loaded, always-all-agents surface.
- **Exit condition:** Upstream adds a `container/CLAUDE.local.md` (per-install, not tracked) or similar mechanism for install-global rules.
- **Lines:** ~30 (content, not code)

### 4. gh CLI + multi-identity help file in Dockerfile

- **File:** `container/Dockerfile`
- **Summary:** (a) Install `gh` (GitHub CLI) from the official Debian repo during the apt install step, after the Playwright/Chromium deps. (b) Create `/home/node/.gh-identities` with a header listing the 4 `GH_TOKEN_*` env vars the `multi-identity-github` skill expects.
- **Why:** Upstream's `container/Dockerfile` doesn't ship `gh` — the container is for agent-SDK work, not GitHub ops. Our cluster-manager role is GitHub-heavy (PR reviews, issue triage, multi-repo monitoring across 4 identities). The `multi-identity-github` skill references `/home/node/.gh-identities` as a discovery file for available tokens; baking it in the image avoids needing an entrypoint side-effect.
- **Exit condition:** Either (a) upstream adds a `container.json:packages.apt` honored at image-build time (not runtime), or (b) we split the cluster-manager role into a sibling image via docker-compose (Exp 2 plan) — then gh goes on that image only.
- **Lines:** ~12 (apt install block + gh-identities heredoc).

### 5. Copy CLAUDE.md fragments instead of symlinking on Windows

- **File:** `src/claude-md-compose.ts` (`syncSymlink` → `syncFragment`, plus `hostSource` on the desired-fragment map)
- **Summary:** On `win32` hosts, inline the host file content (`fs.readFileSync` + `writeAtomic`) instead of `fs.symlinkSync`. Composition runs per-spawn so the inlined copy is never stale.
- **Why:** The upstream design uses symlinks whose targets are container-side absolute paths (`/app/CLAUDE.md`, `/app/src/mcp-tools/<x>.instructions.md`), valid inside the container via RO mounts, dangling on the POSIX host. On Windows, MSYS2/Git-Bash (NSSM service env, or any Node-via-Bash spawn) rewrites these POSIX-absolute targets at symlink-creation time to `/d/app/...`, which Docker then exposes as `/mnt/host/d/app/...` inside the container — permanently broken. Impact: without this patch the composed `groups/<folder>/CLAUDE.md` imports 1 broken `.claude-shared.md` + 5 broken `.claude-fragments/module-*.md` links, meaning the agent never sees the shared `container/CLAUDE.md` (non-negotiable rules, skills overview) nor the MCP tool instructions (agents, core, interactive, scheduling, self-mod).
- **Exit condition:** Upstream changes the composition to write content directly (not symlinks), or Node/Windows stops translating POSIX-absolute symlink targets.
- **Lines:** ~18 (platform branch in `syncFragment` + `hostSource` plumbing on 3 call sites).

### 6. Default GH_TOKEN from GH_TOKEN_JSBOIGE in host spawn

- **File:** `src/container-runner.ts` (extension of the patch #1 env-passthrough block in `buildContainerArgs`)
- **Summary:** After the prefix-based env passthrough, if `GH_TOKEN` is unset on the host and `GH_TOKEN_JSBOIGE` is set, append `-e GH_TOKEN=<value>` to the spawn args. The `multi-identity-github` skill still overrides per repo owner at runtime — this only provides the default.
- **Why:** `gh` CLI consults `GH_TOKEN` as its primary env credential. Without a default, bare `gh` fails out-of-the-box even though 4 identity tokens are passed through. Had to be host-side (not `entrypoint.sh`) because `container-runner.ts:492` overrides the Dockerfile `ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]` with `--entrypoint bash -c "exec bun run /app/src/index.ts"` — so anything in `entrypoint.sh` is dead code at spawn time.
- **Exit condition:** `multi-identity-github` skill is redesigned to set `GH_TOKEN` directly on startup, or upstream adds a generic env-defaulting hook in `buildContainerArgs`.
- **Lines:** ~5.

---

## Deferred / not yet applied

### 7. Per-MCP tool timeout

- **Status:** DEFERRED.
- **Context:** `@anthropic-ai/claude-agent-sdk@0.2.116` has no per-MCP `timeout` field on `McpServerConfig`. Production need: 1800000 ms (30 min) for roo-state-manager dashboard condense (local LLM calls).
- **Plan:** Open upstream PR on `claude-agent-sdk` adding `McpServerConfig.timeout?: number`. Until merged, long-running MCP tools may hit default 60s timeout.
- **Workaround:** `MCP_TOOL_TIMEOUT_MS` env var is already passed through to the container via patch #1 for when the SDK surface gains support.

### 8. Docker network per agent_group

- **Status:** Not applied. Apply only when starting Experience 2 (web-explorer).
- **File (when applied):** `src/container-runner.ts`
- **Plan:** Add `container.json:dockerNetwork` field read during `buildContainerArgs`, append `--network <name>`.
- **Why later:** cluster-manager runs on `internal: true` network (no internet); web-explorer needs standard bridge. Issue #5 on this repo.
- **Exit condition:** Upstream adds `container.json:dockerNetwork` natively.

### 9. Telegram voice transcription (ASR)

- **Status:** Post-migration follow-up.
- **Plan:** Implement as container skill `container/skills/voice-transcription/` that the agent invokes on audio content. Agent script fetches the voice file via Telegram Bot API, POSTs to `ASR_BASE_URL` (Whisper), receives text. No patch to the Telegram adapter.
- **Env vars:** `ASR_BASE_URL`, `ASR_API_KEY` already passed through via patch #1.

---

## Removed / not needed under v2

### ~~Mount allowlist env override~~ — SUPERSEDED BY V2 NATIVE (2026-04-24)

- **Was:** v1 commit `55043c2` patched `src/config.ts` to read `NANOCLAW_MOUNT_ALLOWLIST_PATH`.
- **Removed because:** v2 ships `src/modules/mount-security/` natively with hardcoded `${HOME}/.config/nanoclaw/mount-allowlist.json`. We relocated the allowlist to that path and set `HOME=C:/Users/MYIA` in `.env` for the NSSM service.

### ~~MCP HTTP type for roo-state-manager~~ — REPLACED BY STDIO BRIDGE (2026-04-24)

- **Was:** v1 patched `container/agent-runner/src/index.ts buildExtraMcpServers()` to support HTTP-type MCP servers.
- **Removed because:** Replaced by `mcp-remote` stdio wrapper declared in `groups/main/container.json:mcpServers`. No core patch.

### ~~RooSync inbox watcher~~ — OBSOLETE UNDER V2 (2026-04-24)

- **Was:** v1 `src/roosync-inbox-standalone.ts`, `src/roosync-inbox-watcher.ts` (550 lines).
- **Removed because:** v2 is message-first. All RooSync ops now go through the `roo-state-manager` HTTP MCP server. Host no longer polls RooSync.

### ~~Credential proxy (z.ai)~~ — REPLACED BY ENV PASSTHROUGH (2026-04-24)

- **Was:** v1 `src/credential-proxy.ts` from the `native-credential-proxy` skill.
- **Removed because:** The Claude SDK reads `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` directly from env. Combined with patch #1, the container receives z.ai credentials without a proxy process. OneCLI Vault remains available as a gateway option (not used on this install).

### ~~Role-based tool gating (cluster vs explorer)~~ — PENDING DESIGN

- **Was:** v1 patched `container/agent-runner/src/index.ts` with ~100 lines of per-group tool allowlist.
- **Removed because:** v2 has per-group skills via `groups/<folder>/container.json:skills`. Exp 2 (web-explorer) will declare a distinct skills subset — no core patch expected.

---

## Review schedule

- Monthly review of this file. For each active patch, check exit condition.
- If an exit condition is met: open PR removing the patch, reference this file.
- If a new upstream release breaks a patch: fix or open discussion upstream, do not revert silently.
- Budget: 10 active patches. At 8+, stop adding new and prioritize upstreaming.
