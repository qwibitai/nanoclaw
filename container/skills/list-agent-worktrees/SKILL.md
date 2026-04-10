---
name: list-agent-worktrees
description: List All Agent Worktrees
user-invocable: true
---

# /list-agent-worktrees - List All Agent Worktrees

Shows all active agent worktrees with their paths and branches.

## Usage

```bash
/list-agent-worktrees
```

## Implementation

```bash
#!/bin/bash
git worktree list | grep "worktrees/agent-" || echo "No agent worktrees found"
```
