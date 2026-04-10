---
name: cleanup-agent-worktree
description: Remove Agent Worktree
user-invocable: true
---

# /cleanup-agent-worktree - Remove Agent Worktree

Removes a specific agent worktree and its branch.

## Usage

```bash
/cleanup-agent-worktree {timestamp}
/cleanup-agent-worktree {timestamp} --force
```

## Implementation

```bash
#!/bin/bash

AGENT_ID="$1"
FORCE="$2"

if [ -z "$AGENT_ID" ]; then
    echo "Agent ID required"
    echo "Usage: /cleanup-agent-worktree {timestamp} [--force]"
    exit 1
fi

# Source utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../utils/git-worktree-utils.sh"

# Cleanup worktree
if [ "$FORCE" = "--force" ]; then
    cleanup_agent_worktree "$AGENT_ID" true
else
    cleanup_agent_worktree "$AGENT_ID" false
fi
```
