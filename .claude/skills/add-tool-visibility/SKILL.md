---
name: add-tool-visibility
description: Add live chat-side visibility for agent tool calls — shows "🖥️ bash: <cmd>" before each tool call and a duration marker after slow Bash. Reduces "agent is silent for 30s, am I dead?" UX by surfacing what the agent is doing in real time. Triggers on "tool visibility", "live tool use", "show tool calls", "tool preview".
---

# Add Tool Visibility

Adds live tool-call previews to chat. When the agent runs Bash, Read, Write, Edit, WebFetch, or sub-agent (Task/Agent) tools, a short message describing the call is sent into the same chat thread the user is conversing in. Long Bash calls (> 3s) get a completion marker on the way out. Long-running Agent/Task calls get a "still working — Xs elapsed" tick every 30s.

Useful for:
- Mobile users on Telegram/Slack/Discord who want to see *something* during multi-step agent runs
- Debugging — knowing whether the agent is reading files, running commands, or stuck in compaction
- Long-running operations (SSH into remote boxes, package installs, multi-file edits)

## Phase 1: Pre-flight

Check if `container/agent-runner/src/hooks/tool-visibility.ts` already exists. If it does, skip Phase 2 — the skill is already merged.

## Phase 2: Apply Code Changes

```bash
git fetch origin skill/tool-visibility
git merge origin/skill/tool-visibility
```

If merge conflicts, resolve them (most likely in `container/agent-runner/src/providers/claude.ts` where the hooks are wired). Then rebuild:

```bash
pnpm tsc --noEmit -p container/agent-runner   # typecheck
./container/build.sh                           # rebuild container image
systemctl restart nanoclaw-v2-*                # pick up host-side changes
```

Already-running container sessions keep their old image until they exit + respawn — that's fine, they'll pick up the new visibility hooks on the next spawn.

## Phase 3: Verify

Send any message that triggers a multi-step agent action (e.g. "list the files in /etc/systemd/"). You should see:

1. `🖥️ bash: ls /etc/systemd/` (PreToolUse — appears immediately)
2. The actual tool result the agent uses internally
3. The agent's final natural-language response

For Bash calls under 3 seconds, no PostToolUse marker is sent (avoids chat spam). For Bash > 3s: `✅ bash: 4s`.

## What this skill provides

| Tool | Pre-call message | Post-call message |
|------|------------------|-------------------|
| `Bash` | `🖥️ bash: <cmd-summary>` | `✅ bash: Xs` (only if > 3s) |
| `Read` / `Write` / `Edit` / `MultiEdit` | `📖 read: <path>` (debounced ×N) | — |
| `WebFetch` | `🌐 fetch: <domain>` | — |
| `WebSearch` | (skipped — too noisy) | — |
| `Glob` / `Grep` | (skipped — too noisy) | — |
| `Task` / `Agent` (subagents) | `🤖 task: <description>` + 30s progress ticks | — |
| `MCP tools` | `🔧 mcp: <input-summary>` | — |

## Smart bash summarization

The `summarizeBash()` function recognizes common patterns:

- `ssh -i key -o opt root@host "cmd"` → renders as `ssh root@host: cmd`
- `SSHK="ssh ..." && $SSHK root@host "cmd"` → variable assignments stripped, renders as remote-cmd
- `git`, `docker`, `pnpm`, `npm`, `cargo` etc. — shows `<bin> <subcommand>` (e.g. `git status`, `docker ps`)
- Otherwise — first ~120 chars of the command, before any `&&`/`||`/`;`/`|`

## Configuration

No environment variables required. The hook activates automatically once merged.

To suppress visibility for a specific session/agent, the route is to skip the hook at call site — but most users want it on globally.

## Files added

- `container/agent-runner/src/hooks/tool-visibility.ts` (new) — hook implementations + bash-summarizer
- `container/agent-runner/src/providers/claude.ts` (modified) — wires `preToolUseVisibility` + `postToolUseVisibility` into the Claude provider's hook list

## Removing the skill

```bash
# Find the merge commit
git log --merges --oneline | grep skill/tool-visibility

# Revert it
git revert -m 1 <merge-commit>

pnpm build && ./container/build.sh && systemctl restart nanoclaw-v2-*
```
