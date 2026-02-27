---
description: Development pattern - each agent works in isolated worktree to prevent merge conflicts and context pollution
topics: [git, development-workflow, agent-coordination]
created: 2026-02-24
source: https://x.com/elvissun/status/2025920521871716562
---

# Git worktrees enable parallel agent execution without conflicts

Multiple agents can work simultaneously on different features without stepping on each other.

## Problem with Shared Working Directory

- Multiple agents on same branch = merge conflicts
- Context pollution (agents see each other's uncommitted changes)
- Can't run parallel builds/tests

## Git Worktree Solution

Each agent gets isolated working directory:

```bash
# Create worktree for new feature
git worktree add ../feat-custom-templates -b feat/custom-templates origin/main
cd ../feat-custom-templates && pnpm install
```

**Benefits**:
- Separate `node_modules` per agent
- Independent builds, type checks, tests
- No conflicts between agents
- Clean git history per feature

## Agent Execution Pattern

**Launch in tmux session**:
```bash
tmux new-session -d -s "codex-templates" \
  -c "/path/to/feat-custom-templates" \
  "$HOME/.codex-agent/run-agent.sh templates gpt-5.3-codex high"
```

**Why tmux**:
- Full terminal logging
- Mid-task redirection (don't kill stuck agent, redirect it)
- Monitor multiple agents simultaneously

**Mid-task correction examples**:
```bash
# Wrong approach - redirect
tmux send-keys -t codex-templates "Stop. Focus on API layer first, not UI." Enter

# Needs context - inject
tmux send-keys -t codex-templates "Schema is in src/types/template.ts. Use that." Enter
```

## Task Registry Pattern

Track each agent with JSON:

```json
{
  "id": "feat-custom-templates",
  "tmuxSession": "codex-templates",
  "agent": "codex",
  "description": "Custom email templates for agency customer",
  "worktree": "feat-custom-templates",
  "branch": "feat/custom-templates",
  "startedAt": 1740268800000,
  "status": "running",
  "notifyOnComplete": true
}
```

**On completion, updates with**:
```json
{
  "status": "done",
  "pr": 341,
  "completedAt": 1740275400000,
  "checks": {
    "prCreated": true,
    "ciPassed": true,
    "claudeReviewPassed": true,
    "geminiReviewPassed": true
  },
  "note": "All checks passed. Ready to merge."
}
```

## Monitoring Pattern

**Cron job every 10 minutes** runs deterministic checks:
- Are tmux sessions alive?
- Are there open PRs on tracked branches?
- What's CI status? (via `gh cli`)
- Auto-respawn failed agents (max 3 attempts)
- Alert only if human attention needed

**Token-efficient**: No polling agents directly, just check git/CI status

## Hardware Bottleneck

**Problem**: Each worktree needs own `node_modules`, runs own builds/tests
- 5 agents = 5 TypeScript compilers, 5 test runners, 5 dependency sets in memory
- 16GB RAM tops out at 4-5 agents before swapping

**Solution**: More RAM (Elvis bought Mac Studio M4 Max with 128GB)

## Cleanup

**Daily cron job**:
- Remove orphaned worktrees
- Clean task registry JSON
- Archive completed feature branches

## Related Notes
- [[Orchestration layer separates business context from coding context]]

## Source
Elvis - Agent Swarm setup using git worktrees + tmux + task registry

---
*Topics: [[git]] · [[development-workflow]] · [[agent-coordination]]*
