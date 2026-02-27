---
description: System design insight - in multi-agent systems the real bottleneck is human coordination not agent coding ability
topics: [agent-orchestration, system-design, automation]
created: 2026-02-24
source: https://x.com/agent_wrapper/status/2025986105485733945
---

# Orchestrator agent bottleneck is human attention not agent capability

**Context: Multi-agent software development systems**

Most people get the AI coding agent problem wrong. The agents can code. That's not the bottleneck. You are.

## The Problem

**Without orchestrator**:
- Spawn 5 agents
- Come back 20 minutes later
- Now just refreshing GitHub tabs
- Waiting for PRs, checking CI, reading review comments
- **Result**: Automated engineering, replaced it with project management

**The real issue**: You've moved the bottleneck from "writing code" to "coordinating agents."

## The Solution: Orchestrator Agent

**Not a script. An actual AI agent** that:
- Has context on every active session
- Has context on every open PR
- Has context on every CI run
- Tracks everything
- Watches for failures
- Forwards review comments to coding agents
- **Only pings you when something needs human decision**

## Why This Works

**Traditional approach** (human as coordinator):
```
Agent 1 → PR → Human checks CI → Human reads review → Human responds
Agent 2 → PR → Human checks CI → Human reads review → Human responds
Agent 3 → PR → Human checks CI → Human reads review → Human responds
```

**With orchestrator agent**:
```
Agent 1 → PR → Orchestrator watches CI → Routes failures back → Agent fixes
Agent 2 → PR → Orchestrator watches CI → Routes failures back → Agent fixes
Agent 3 → PR → Orchestrator watches CI → Routes failures back → Agent fixes
                     ↓
              Human gets notification only when needed
```

## Key Insight

**Once the bottleneck (your attention) goes away, things start compounding fast.**

The orchestrator agent:
- Looked at all workstreams
- Tells you: "This PR is blocking three other tasks, this CI failure is a flaky test, this review comment is the one that matters"
- **Not showing you data. Giving you decisions.**

## Real Results (Agent Orchestrator project)

**Timeline**: 8 days (3 days focused work, agents filled gaps)
**Output**: 40,000 lines TypeScript, 17 plugins, 3,288 tests
**Best day**: 27 PRs merged in single day (Feb 14)
**CI failures**: 41 total, all self-corrected by agents (84.6% success rate)
**Code reviews**: 700 automated comments, 1% required human

## Self-Healing Pattern

**Automated reactions** to GitHub events:

```yaml
reactions:
  ci_failed:
    action: spawn_agent
    prompt: "CI failed. Read failure logs and fix."

  changes_requested:
    action: spawn_agent
    prompt: "Review comments posted. Address each and push fixes."

  approved:
    action: notify
    channel: slack
    message: "PR approved, ready to merge."
```

**Example**: PR #125 went through 12 CI failure→fix cycles with zero human intervention.

## Architecture Pattern

**Plugin system with 8 swappable slots**:
1. **Tracker**: Pulls issues (GitHub/Linear)
2. **Workspace**: Creates isolated worktree
3. **Runtime**: Starts tmux/process
4. **Agent**: Claude Code/Aider/etc works autonomously
5. **Terminal**: Observe live (iTerm2/web)
6. **SCM**: Creates PRs with context
7. **Reactions**: Auto-respawn on failures
8. **Notifier**: Pings only when needed

**Session lifecycle**: Issue → Worktree → Agent → PR → CI → Review → Merge (orchestrator manages each step)

## What Makes This Different

**Other "run agents in parallel" setups**:
- Scripts that poll GitHub
- Dashboards that show status
- Cron jobs that check conditions

**Agent Orchestrator**:
- The thing managing agents **is itself intelligent**
- Reads codebase
- Understands backlog
- Decides how to decompose features
- Assigns parallelizable tasks
- Monitors progress with context

## Activity Detection

**Tricky problem**: What is agent actually doing?

**Don't rely on self-reporting** (agents lie or get confused)

**Read event files directly**:
- Is agent generating tokens?
- Is it waiting for tool execution?
- Is it idle?
- Has it finished?

**Example**: Claude Code writes JSONL event files, orchestrator parses them.

## The Self-Improving Loop

Most agent setups throw away signal. Session finishes, next session starts from zero.

**Agent Orchestrator learns**:
- Which prompts led to clean PRs?
- Which spiraled into 12 CI failures?
- Which patterns caused merge conflicts?
- Logs performance, tracks outcomes, runs retrospectives

**Result**: Agents build features → Orchestrator observes what worked → Adjusts how it manages future sessions → Agents build better features

**Recursive**: Agents built the orchestrator, orchestrator makes agents more effective, agents keep improving orchestrator.

## Attention is the Ceiling

**Most people think**: "How good is Claude Code at TypeScript?"

**Reality**: "How good can a system get at deploying, observing, and improving dozens of agents in parallel?"

**The second ceiling is much higher. And it rises every time the loop runs.**

## Related Notes
- [[Orchestration layer separates business context from coding context]]
- [[Proactive task discovery multiplies agent productivity]]
- [[Git worktrees enable parallel agent execution without conflicts]]

## Source
Prateek (@agent_wrapper) - "The Self-Improving AI System That Built Itself"
- Article: Built Agent Orchestrator using agents managed by bash scripts, then agents built TypeScript replacement
- GitHub: https://github.com/ComposioHQ/agent-orchestrator (Open Source)
- Company: Composio

---
*Topics: [[agent-orchestration]] · [[system-design]] · [[automation]]*
