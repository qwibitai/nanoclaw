# NanoClaw Jarvis Worker Runtime

Runtime contract for OpenCode-based worker containers.

## Worker Image

- Default image: `nanoclaw-worker:latest` (`WORKER_CONTAINER_IMAGE`)
- Built from: `container/worker/Dockerfile`
- Runtime: OpenCode CLI (`opencode-ai`) with pinned free-model defaults and runtime fallback handling
- Build path is network-minimal in buildkit:
  - `container/worker/build.sh` prepares `container/worker/vendor/opencode-ai-node_modules.tgz` via `container run`
  - Docker build then uses local bundle only (no apt/npm registry dependency inside buildkit)

## OpenCode Runtime Config

`OPENCODE_CONFIG_CONTENT` is set in image with:

- model: `opencode/minimax-m2.5-free`
- instructions: `/workspace/group/CLAUDE.md`
- skills path: `/home/node/.claude/skills`
- default MCP servers:
  - `deepwiki` (remote: `https://mcp.deepwiki.com/mcp`)
  - `context7` (local: `npx -y @upstash/context7-mcp`)
  - `token-efficient` (local: `/workspace/mcp-servers/token-efficient-mcp/dist/index.js`)
  - `chrome-devtools` (local: `npx -y chrome-devtools-mcp --channel=beta`)

Model can be overridden per-group via `containerConfig.model`.

Worker runner also applies fallback model attempts when OpenCode returns model errors:

1. requested model (`containerConfig.model` / `WORKER_MODEL`)
2. `opencode/minimax-m2.5-free`
3. `opencode/big-pickle`
4. `opencode/kimi-k2.5-free`

## Mount Model

Worker container mounts:

| Container Path | Source | Access |
|----------------|--------|--------|
| `/workspace/group` | `groups/jarvis-worker-*` | read-write |
| `/workspace/global` | `groups/global` | read-only (if present) |
| `/workspace/ipc` | `data/ipc/<group>` | read-write |
| `/workspace/mcp-servers` | host MCP root | read-only (if present) |
| `/home/node/.claude/skills` | staged from `container/skills` | read-only |
| `/home/node/.claude/rules` | staged from `container/rules` | read-only |

## Skill/Rule Staging

Before run, host copies skills/rules to `data/sessions/<group>/.opencode/*` with symlinks dereferenced.
Hidden metadata entries are skipped and source/destination overlap is rejected.
This prevents broken symlink targets and copy-collision failures inside the worker container.

## Role-Based Prebaked Bundles

Bundles are group-aware:

- `jarvis-worker-*` gets the worker skill bundle + worker rules.
- `andy-bot` gets an observer/research bundle + Andy-bot rules.
- `andy-developer` gets a reviewer/orchestrator-focused skill bundle + Andy rules.
- Other groups default to full skill/rule sync.

IPC authorization lane:

- `andy-developer` is allowed to delegate only to `jarvis-worker-*` targets (messages + task controls).
- `andy-bot` is observer/research only; it does not dispatch worker tasks.
- Other non-main groups remain self-only.
- `main` remains full-access orchestrator.

Worker rules include:

- `container/rules/compression-loop.md`
- `container/rules/jarvis-worker-operating-rule.md`

Andy-developer rules include:

- `container/rules/compression-loop.md`
- `container/rules/andy-developer-operating-rule.md`

Andy-bot rules include:

- `container/rules/compression-loop.md`
- `container/rules/andy-bot-operating-rule.md`

## Secrets and Identity

- Worker receives only `GITHUB_TOKEN` from host env loading.
- Worker sets `GH_TOKEN = GITHUB_TOKEN` for CLI compatibility.
- `andy-bot` and `andy-developer` both receive `GITHUB_TOKEN`/`GH_TOKEN` for `openclaw-gurusharan` GitHub activity.
- `andy-bot` GitHub usage scope: research, repository inspection, and reporting (not worker dispatch control).
- Git identity defaults:
  - `WORKER_GIT_NAME=Andy (openclaw-gurusharan)`
  - `WORKER_GIT_EMAIL=openclaw-gurusharan@users.noreply.github.com`

## Output Protocol

Worker runner communicates with NanoClaw host using marker-framed JSON:

- `---NANOCLAW_OUTPUT_START---`
- JSON payload
- `---NANOCLAW_OUTPUT_END---`

This is shared with the host parser and supports robust extraction from stdout.

## Container Lifecycle Safety

As of 2026-02-23, container lifecycle adds hard guards against duplicate-running
group containers and stuck orphan cleanup:

1. Startup orphan cleanup (`src/index.ts` -> `cleanupOrphans()`)
   - On service start, NanoClaw scans running `nanoclaw-*` containers.
   - Each stop is verified; stop escalation order is:
     - `container stop <name>`
     - `container stop -s SIGKILL -t 1 <name>`
     - `container kill <name>`

2. Pre-launch same-group cleanup (`src/container-runner.ts`)
   - Before spawning `nanoclaw-<group>-<timestamp>`, NanoClaw stops any already-running
     container with prefix `nanoclaw-<group>-`.
   - This prevents two active containers for the same group lane.

3. Timeout cleanup with verification (`src/container-runner.ts`)
   - Timeout shutdown uses the same verified stop escalation instead of a single blind stop.
   - Failed attempts are logged with full command history for debugging.

Operational logs:
- Success: `Stopped orphaned containers`
- Pre-launch cleanup: `Stopped stale running containers before launch`
- Failure with attempts: `Failed to stop some orphaned containers`

## Usage Stats

Current usage payload includes:

- `duration_ms`
- `peak_rss_mb`
- `input_tokens=0`
- `output_tokens=0`

Token counts are zero-filled until OpenCode exposes deterministic per-call usage values.

## Guardrails

1. Worker behavior is contract-driven (`dispatch-validator.ts`), not prompt-only.
2. Non-worker groups remain on the Claude Agent SDK runtime path.
3. Worker-specific behavior is bounded by folder/image detection and does not alter main-group orchestration semantics.
