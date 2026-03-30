---
name: add-cli-backend
description: Replace Agent SDK with Claude Code CLI in the container agent-runner. Enables Max subscription OAuth for TOS-compliant flat-rate pricing. Removes @anthropic-ai/claude-agent-sdk dependency.
---

# Add CLI Backend

Replaces `@anthropic-ai/claude-agent-sdk` with `claude -p` CLI in the container agent-runner. This enables using Max subscription OAuth tokens legally (per Anthropic's TOS clarification) and removes a dependency.

**What changes:**
- Agent-runner spawns `claude -p --input-format stream-json` instead of SDK `query()`
- Pre-compact hook moved to standalone CLI-compatible script
- `@anthropic-ai/claude-agent-sdk` removed from dependencies
- `ipc-mcp-stdio.ts` unchanged (reused via `--mcp-config`)
- All host-side protocols unchanged (stdin JSON, stdout markers, IPC files)

## Phase 1: Pre-flight

Check if already applied:

```bash
grep -q "claude-agent-sdk" container/agent-runner/package.json && echo "Not applied (SDK still present)" || echo "Already applied"
```

If already applied, skip to Phase 3 (Verify).

## Phase 2: Apply Code Changes

Merge the skill branch:

```bash
git fetch upstream skill/cli-backend
git merge upstream/skill/cli-backend || {
  git checkout --theirs container/agent-runner/package-lock.json
  git add container/agent-runner/package-lock.json
  git merge --continue
}
```

> **Note:** `upstream` is the remote pointing to `qwibitai/nanoclaw`. If using a different remote name, substitute accordingly.

This modifies:
- `container/agent-runner/src/index.ts` (SDK → CLI spawn)
- `container/agent-runner/package.json` (removes SDK dependency)

And adds:
- `container/agent-runner/src/hooks/pre-compact.ts` (standalone hook script)

### Install dependencies

```bash
cd container/agent-runner && npm install
```

### Validate build

```bash
cd container/agent-runner && npm run build
```

### Rebuild container

```bash
./container/build.sh
```

### Restart service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 3: Verify

1. Container health: `nanoclaw test --exec "echo ok"`
2. Send a test message from the main group and verify a response
3. Send a follow-up message — verify context is maintained (multi-turn)
4. Trigger `send_message` MCP tool (e.g., "send me a separate message with a joke") — verify two messages arrive
5. Create a scheduled task (e.g., "remind me in 1 minute") — verify it fires

## Configuration

### Model Override

The CLI defaults to Sonnet. To use a different model, set the `CLAUDE_MODEL` environment variable in your `.env`:

```
CLAUDE_MODEL=claude-opus-4-6
```

The agent-runner reads this and passes `--model` to the CLI.

## Known Differences from SDK

| Feature | SDK | CLI | Impact |
|---------|-----|-----|--------|
| Tool use | `allowedTools` option | `--allowed-tools` flag | None — same tool names |
| MCP servers | `mcpServers` option | `--mcp-config` JSON file | None — same server |
| Session resume | `resume` + `resumeSessionAt` | `--resume sessionId` | CLI resumes from latest state (no mid-session resume) |
| Permissions | `permissionMode: 'bypassPermissions'` | `--dangerously-skip-permissions` | None |
| Hooks | In-process `HookCallback` | External command via `settings.json` | Hook runs as separate process |
| Structured output | Native SDK types | `--output-format stream-json` NDJSON | Same event types |
| Script phase | N/A (upstream feature) | Preserved — `runScript()` unchanged | None |
| Query loop | SDK `query()` per turn | CLI spawn per turn | Same multi-turn semantics |

## How It Works

The agent-runner uses the same query loop as the SDK version — one CLI spawn per turn:

```
Host → stdin (ContainerInput JSON) → agent-runner
  → [optional] runScript() for scheduled tasks with scripts
  → loop:
      spawn claude -p --input-format stream-json --output-format stream-json
      → Write user message to CLI stdin (NDJSON)
      → Read NDJSON events from CLI stdout
      → IPC file polling injects follow-ups into CLI stdin
      → On result: writeOutput() with stdout markers → Host
      → On _close during query: end CLI stdin, break
      → Wait for next IPC message (or _close → break)
```

The MCP server (`ipc-mcp-stdio.ts`) is unchanged — the CLI spawns it as a stdio subprocess via `--mcp-config`.

## Rollback

To revert to the SDK backend:

```bash
git revert HEAD  # if single commit
# or
git merge --abort  # if merge hasn't been committed
npm install
npm run build
./container/build.sh
# restart service
```
