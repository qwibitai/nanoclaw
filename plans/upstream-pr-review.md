# Upstream PR Review — Credentials & Channel Integrations

Review of open PRs on [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw/pulls) as of 2026-02-24.

## 1. Per-Group Credential Separation — Related PRs

No PR proposes per-group API keys or OAuth tokens. Four PRs touch adjacent concerns:

### PR #412 — Host Machine Authorization Passthrough (kerwin612)

**What it does:** Adds a third credential source — reads `ANTHROPIC_AUTH_TOKEN` from `~/.claude/settings.json` on the host machine, with `.env` values taking priority. Designed for users who authenticate Claude via third-party providers (e.g. Zhipu) where credentials live in the host's Claude config rather than in `.env`.

**Source changes:**
- `src/env.ts` — adds `readHostClaudeEnv(keys)` to read from `~/.claude/settings.json`
- `src/container-runner.ts` — merges host auth tokens into `readSecrets()` as fallback behind `.env`; regenerates per-group `settings.json` on every container start instead of only on first run

**Relevance:** Modifies the same `readSecrets()` function our per-group credentials plan targets. Adds a global fallback layer (host → `.env`), which would need to be reconciled into the per-group resolution chain: `group credential → .env → host settings.json`.

### PR #449 — `/add-persistent-secrets` Skill (goern)

**What it does:** Skill that mounts a persistent `data/secrets/{group}/` directory into containers so agent-generated secrets (GPG keys, gopass stores) survive container restarts.

**Source changes:** Skill-only — instructs Claude to add a mount in `container-runner.ts` and set `GNUPGHOME` in the container environment.

**Relevance:** Validates the per-group isolated secret storage pattern. Different scope (agent-generated secrets, not API credentials) but proves the directory-per-group approach works.

### PR #419 — Prevent .env Secret Leakage (roeeho-tr)

**What it does:** Mounts `/dev/null` over `/workspace/project/.env` inside main-group containers. Despite secrets being delivered via stdin and sanitized from env vars by the bash hook, the project-root bind mount exposed `.env` directly — agents could read API keys with `cat /workspace/project/.env`.

**Source changes:**
- `src/container-runner.ts` — adds `/dev/null` overlay mount for `.env`
- `src/db.ts` — wraps `JSON.parse(container_config)` in try/catch to prevent crash loops from corrupt JSON

**Relevance:** Fixes a real secret leakage vector. Should be merged before or alongside per-group credentials — otherwise per-group secrets stored in the DB are moot if agents can still read the global `.env` from the mounted project root.

### PR #401 — Per-Group WebFetch/WebSearch Attenuation (MunemHashmi)

**What it does:** Adds `WebAccessConfig` to `ContainerConfig` with per-group `webFetch`, `webSearch`, and `fetchAllowlist` fields. Dynamically builds `allowedTools` in the agent runner based on per-group config.

**Source changes:** `src/types.ts`, `src/container-runner.ts`, `src/index.ts`, `container/agent-runner/src/index.ts`

**Relevance:** Same architectural pattern as per-group credentials — extends `ContainerConfig` with per-group overrides that flow through the container input to the agent runner. Good precedent for structuring the credential config.

### Summary

| PR | Status | Conflicts with our plan? | Should merge first? |
|----|--------|--------------------------|---------------------|
| #412 Host auth passthrough | Open | Yes — modifies `readSecrets()` | Reconcile during implementation |
| #449 Persistent secrets | Open | No | Independent |
| #419 .env leakage fix | Open | No | Yes — fixes a real hole |
| #401 Per-group web access | Open | No | No, but useful pattern reference |

---

## 2. Telegram & Slack Integration — What's Available

### Telegram — Ready to Use

Telegram is **already in the repo** as a built-in skill at `.claude/skills/add-telegram/`.

**To apply:** Run `/add-telegram` in Claude Code.

**What it provides:**
- `src/channels/telegram.ts` — `TelegramChannel` class implementing the `Channel` interface
- Uses the `grammy` library for Telegram Bot API
- Can replace WhatsApp entirely (`TELEGRAM_ONLY=true`) or run alongside it
- 46 unit tests included
- Three-phase interactive setup: pre-flight checks, deterministic code application via skills engine, guided bot creation and token configuration

**Open fix — PR #424 (kerwin612):** Removes Apple Container–specific code that leaked into the Telegram skill's `modify/src/index.ts` when the skill was authored on a codebase that had already applied the `convert-to-apple-container` skill. After this fix, the Telegram skill's index.ts modifications are limited to the three changes Telegram actually requires (config imports, channel import, conditional creation in `main()`). Also adds state/code mismatch detection. Worth cherry-picking.

### Slack — Two Competing PRs

| | PR #423 (rgarcia) | PR #366 (darrellodonnell) |
|---|---|---|
| **Approach** | Full implementation + skill package | Skill-only package |
| **Source changes** | Yes — `src/channels/slack.ts`, config, index, routing tests | No source changes in PR |
| **Tests** | 30 unit tests | Tests in skill package only |
| **Library** | `@slack/bolt` with Socket Mode | `@slack/bolt` with Socket Mode |
| **Threading** | Smart threading: @mention starts thread, auto-replies within, DMs always respond | Similar |
| **Setup guide** | 5-phase interactive | Present but less detailed |
| **JID format** | `slack:{channelId}`, `slack:{userId}` | Same |
| **Public URL needed** | No (Socket Mode) | No (Socket Mode) |

**Recommendation: PR #423 is the stronger candidate.** It includes working source code, comprehensive tests (30 passing), and was verified live. PR #366 is skill-only with a minimal description.

### How Channel Skills Work

Channels in NanoClaw are not plugins or config toggles. They are **skills** — markdown instruction documents (`.claude/skills/{name}/SKILL.md`) that Claude Code reads and executes to modify your source code. When you run `/add-slack`:

1. Claude Code reads `SKILL.md` and follows its phases
2. The skills engine (`scripts/apply-skill.ts`) adds new files from the skill's `add/` directory and three-way merges modifications into existing files using the `modify/` directory
3. npm dependencies are installed (`@slack/bolt`)
4. Claude interactively guides you through Slack app creation, token setup, and testing
5. The channel code lives in `src/channels/slack.ts` as first-class editable source code — no plugin abstraction

After application, the code is yours to customize directly. The `modify/*.intent.md` files in each skill explain the purpose of changes so Claude can resolve merge conflicts intelligently if the base code has diverged.
