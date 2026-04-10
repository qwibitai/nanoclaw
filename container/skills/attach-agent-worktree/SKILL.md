---
name: attach-agent-worktree
description: Attach to Agent Session
user-invocable: true
---

# /attach-agent-worktree - Attach to Agent Session

Changes to agent worktree directory and attaches to its tmux session.

## Usage

```bash
/attach-agent-worktree {timestamp}
```

## Implementation

```bash
#!/bin/bash

AGENT_ID="$1"

if [ -z "$AGENT_ID" ]; then
    echo "Agent ID required"
    echo "Usage: /attach-agent-worktree {timestamp}"
    exit 1
fi

# Find worktree directory
WORKTREE_DIR=$(find worktrees -type d -name "agent-${AGENT_ID}*" 2>/dev/null | head -1)

if [ -z "$WORKTREE_DIR" ] || [ ! -d "$WORKTREE_DIR" ]; then
    echo "Worktree not found for agent: $AGENT_ID"
    exit 1
fi

SESSION="agent-${AGENT_ID}"

# Check if tmux session exists
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Tmux session not found: $SESSION"
    exit 1
fi

echo "Worktree: $WORKTREE_DIR"
echo "Attaching to session: $SESSION"
echo ""

# Attach to session
tmux attach -t "$SESSION"
```
