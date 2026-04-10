---
name: merge-agent-work
description: Merge Agent Branch
user-invocable: true
---

# /merge-agent-work - Merge Agent Branch

Merges an agent's branch into the current branch.

## Usage

```bash
/merge-agent-work {timestamp}
```

## Implementation

```bash
#!/bin/bash

AGENT_ID="$1"

if [ -z "$AGENT_ID" ]; then
    echo "Agent ID required"
    echo "Usage: /merge-agent-work {timestamp}"
    exit 1
fi

# Source utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../utils/git-worktree-utils.sh"

# Merge agent work
merge_agent_work "$AGENT_ID"
```
