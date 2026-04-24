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

---

## Deferred / not yet applied

### 4. Per-MCP tool timeout

- **Status:** DEFERRED.
- **Context:** `@anthropic-ai/claude-agent-sdk@0.2.116` has no per-MCP `timeout` field on `McpServerConfig`. Production need: 1800000 ms (30 min) for roo-state-manager dashboard condense (local LLM calls).
- **Plan:** Open upstream PR on `claude-agent-sdk` adding `McpServerConfig.timeout?: number`. Until merged, long-running MCP tools may hit default 60s timeout.
- **Workaround:** `MCP_TOOL_TIMEOUT_MS` env var is already passed through to the container via patch #1 for when the SDK surface gains support.

### 5. Docker network per agent_group

- **Status:** Not applied. Apply only when starting Experience 2 (web-explorer).
- **File (when applied):** `src/container-runner.ts`
- **Plan:** Add `container.json:dockerNetwork` field read during `buildContainerArgs`, append `--network <name>`.
- **Why later:** cluster-manager runs on `internal: true` network (no internet); web-explorer needs standard bridge. Issue #5 on this repo.
- **Exit condition:** Upstream adds `container.json:dockerNetwork` natively.

### 6. Telegram voice transcription (ASR)

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
