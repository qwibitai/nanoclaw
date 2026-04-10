---
name: swarm-agent-troubleshooting
description: Diagnose and fix swarm agent spawn failures when agents don't start processing tasks
user-invocable: true
---

# Swarm Agent Troubleshooting

Diagnose and fix swarm agent spawn failures when agents don't start processing tasks.

## When to Use

- Agent tmux session created but stuck at shell prompt
- Agent not responding to inbox messages
- `wait_for_claude_ready()` times out
- Symptoms: dotenv prompt, zsh theme loading, or no Claude banner visible

## Quick Diagnosis

```bash
# 1. List swarm sessions
tmux list-sessions | grep swarm

# 2. Attach to stuck agent
tmux attach -t swarm-XXXX-agent-1

# 3. Check what's showing:
#    - Shell prompt (zsh/bash) = Claude didn't start
#    - "dotenv: found '.env'" = Blocked by prompt
#    - Claude banner = Ready (check if task was sent)
```

## Common Causes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `dotenv: found '.env' file. Source it?` | dotenv plugin prompt | Send `a` (always) then restart claude |
| Shell prompt showing | Claude command never ran | Manually run `claude --dangerously-skip-permissions` |
| Claude banner but idle | Task not sent after spawn | Resend the task prompt |
| "command not found: claude" | Claude not in PATH | Check `which claude` or use full path |

## Manual Recovery Steps

```bash
# Step 1: Attach to the stuck session
tmux attach -t swarm-XXXX-agent-1

# Step 2: If at dotenv prompt, answer it
# (type 'a' for always, then Enter)

# Step 3: If at shell, start Claude manually
claude --dangerously-skip-permissions

# Step 4: Once Claude is ready, send the task
# (paste the agent's task prompt)

# Step 5: Detach (Ctrl+B, D) and continue monitoring
```

## Prevention

### Update Shell Config

Add to `~/.zshrc` or `~/.bashrc`:
```bash
# Auto-accept dotenv in non-interactive contexts
export DOTENV_ASSUME_YES=1
```

### Increase Detection Timeout

In `spawn-agent-lib.sh`, increase the timeout:
```bash
wait_for_claude_ready "$SESSION" 60  # Increase from 30 to 60 seconds
```

### Add Detection Patterns

The `wait_for_claude_ready()` function looks for these patterns:
- "Claude Code"
- "Welcome back"
- "──────" (horizontal rule)
- "Style:"
- "bypass permissions"

If your terminal has different output, add patterns to the grep regex.

## Debug Logs

Failed spawn attempts save debug output:
```bash
cat /tmp/spawn-agent-swarm-XXXX-agent-1-failure.log
```

## Related

- `/swarm-status` - Check overall swarm health
- `/swarm-shutdown` - Clean up stuck swarm
- `spawn-agent-lib.sh` - Core spawning library
