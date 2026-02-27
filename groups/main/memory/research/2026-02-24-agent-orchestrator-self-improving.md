# Article: The Self-Improving AI System That Built Itself

**Source**: https://x.com/agent_wrapper/status/2025986105485733945
**Author**: Prateek (@agent_wrapper), Composio
**Date**: February 23, 2026
**Read**: February 24, 2026

## Summary

Story of building Agent Orchestrator - a self-improving multi-agent system where agents built the orchestrator that manages them. Started with 2,500 lines of bash scripts, agents built v1 TypeScript replacement, v1 managed agents that built v2, v2 continues improving itself.

Key insight: The real bottleneck in multi-agent systems isn't agent capability - it's human attention coordinating them. An orchestrator agent (not a script) removes that bottleneck and enables compound improvement.

Results: 40,000 lines TypeScript, 17 plugins, 3,288 tests in 8 days. 27 PRs merged in single day. 41 CI failures all self-corrected. 700 automated code reviews, 1% needed human.

## Key Learnings

### Tier 1: Immediately Applicable ✅

1. **Human attention is the bottleneck, not agent capability**
   - Created: [[Orchestrator agent bottleneck is human attention not agent capability]]
   - Spawning agents is easy, coordinating them is hard
   - Orchestrator agent (not script) manages: CI watching, review routing, failure forwarding
   - Humans only notified when decision actually needed

2. **Self-improving systems compound when agents build tools**
   - Created: [[Self-improving systems compound when agents build their own tools]]
   - Agents build orchestrator → Orchestrator improves agents → Better agents improve orchestrator
   - Recursive improvement, not linear
   - The ceiling: "How good can system get at managing agents?" (much higher than "how good is the agent?")

### Tier 2: Strategic Value 📋

1. **8-plugin architecture enables flexibility**
   - Tracker (GitHub/Linear)
   - Workspace (git worktrees)
   - Runtime (tmux/process/Docker)
   - Agent (Claude Code/Aider/etc)
   - Terminal (iTerm2/web)
   - SCM (PR creation)
   - Reactions (auto-respawn on failures)
   - Notifier (Slack/Telegram)

2. **Self-healing CI pattern**
```yaml
reactions:
  ci_failed:
    action: spawn_agent
    prompt: "CI failed. Read logs and fix."
  changes_requested:
    action: spawn_agent
    prompt: "Address review comments."
```
Result: 41 CI failures, all self-corrected

3. **Activity detection without self-reporting**
   - Don't ask agents what they're doing (they lie/get confused)
   - Read structured event files directly
   - Claude Code writes JSONL, parse it for: generating tokens, waiting for tool, idle, finished

4. **Signal capture for learning**
   - Which prompts → clean PRs?
   - Which → 12 CI failures?
   - Which patterns → conflicts?
   - System learns and adjusts future management

5. **Web dashboard with attention zones**
   - Sessions grouped by what needs attention (failing CI, awaiting review, running fine)
   - Live terminal (xterm.js, agent's actual output in browser)
   - Not showing data, giving decisions: "This PR blocks 3 tasks, this is flaky test, this comment matters"

### Tier 3: Reference Knowledge 📚

1. **Metrics from 8-day build**
   - 40,000 lines TypeScript (from 2,500 bash)
   - 17 plugins
   - 3,288 tests (all written by agents)
   - 722 commits (every commit tagged with model)
   - 86 of 102 PRs created by agents
   - 700 code review comments (automated)
   - 68% of review comments fixed immediately by agents
   - 84.6% CI success rate

2. **Model distribution**
   - Opus 4.6: Complex architecture, cross-package integrations (hard stuff)
   - Sonnet: Plugin implementations, tests, docs (volume work)
   - Some commits: One model wrote, another reviewed/fixed

3. **Peak productivity**: Feb 14 - 27 PRs merged in single day
   - Core services, CLI, web dashboard, all 17 plugins, npm publishing
   - All in one day

4. **PR #125 story**: 12 CI failure→fix cycles, zero human intervention
   - Type errors → Agent fixed
   - Lint failures → Agent fixed
   - Test regressions → Agent fixed
   - Shipped clean after 12 rounds

5. **Inception pattern**:
   - 30 concurrent agents working on Agent Orchestrator
   - Building TypeScript replacement while bash version managed them
   - Thing being built was managing its own construction

## Memory Notes Created

1. [[Orchestrator agent bottleneck is human attention not agent capability]]
2. [[Self-improving systems compound when agents build their own tools]]

## Applications to NanoClaw

### High Priority

**1. Orchestrator pattern for self-edit workflow**
- Currently: User initiates self-edit, monitors PR, checks CI manually
- Enhancement: Orchestrator agent watches PR, forwards CI failures back, notifies only when merge decision needed
- Pattern: Same self-healing reactions for NanoClaw's own development

**2. Activity detection for long-running tasks**
- Don't rely on agent self-reporting progress
- Parse structured logs/events if available
- Show actual state (generating, waiting, idle, done)

**3. Signal capture from sessions**
- Log which prompts led to successful PRs vs failures
- Track common failure patterns
- Adjust future prompts based on learnings

### Medium Priority

**4. Plugin architecture for flexibility**
- Currently: Hardcoded to specific tools
- Enhancement: Pluggable skills system
- Example: Swap agent-browser for playwright, or WebFetch for custom scraper

**5. Attention zones in UI**
- Group tasks by urgency (needs attention, running fine, completed)
- Show decisions, not just data
- "This task blocks 3 others" vs "Task status: pending"

### Low Priority

**6. Self-improving skill prompts**
- Track skill success rates
- Identify which skills often need revision
- Auto-adjust skill prompts based on outcomes

## Implementation Metrics

- **Memory notes created**: 2
- **Plugins in architecture**: 8 swappable slots
- **Self-healing pattern**: Automated reactions to CI/reviews
- **Build metrics**: 40K lines in 8 days, 84.6% CI success

## Architecture Comparison

| Aspect | Traditional Multi-Agent | Agent Orchestrator |
|--------|------------------------|-------------------|
| **Coordination** | Human checks PRs/CI | Orchestrator agent manages |
| **CI failures** | Human reads, tells agent | Auto-forwarded to agent |
| **Review comments** | Human routes to agent | Auto-routed with context |
| **Attention needed** | Constant (checking status) | Only for decisions |
| **Improvement** | Linear (human updates) | Compound (agents improve tools) |
| **Bottleneck** | Human bandwidth | System capability (higher ceiling) |

## Key Quotes

"The agents can code. That's not the bottleneck. You are."

"You've automated engineering and replaced it with project management. Bad project management."

"The ceiling isn't 'how good is Claude Code at TypeScript.' It's 'how good can a system get at deploying, observing, and improving dozens of agents working in parallel.' That ceiling is much higher."

"The tool is improving itself through the agents it manages."

"The thing being built was the thing managing its own construction."

## Pattern: Self-Improving Loop

```
Agents build features
    ↓
Orchestrator observes what worked
    ↓
Adjusts how it manages future sessions
    ↓
Agents build better features
    ↓
Better agents improve orchestrator
    ↓
Loop (compound growth)
```

## What Humans Did vs. Agents Did

**Humans**:
- Architecture decisions (plugin slots, config schema)
- Spawning sessions and assigning issues
- Reviewing PRs (architecture level, not line-by-line)
- Resolving cross-agent conflicts
- Judgment calls (reject this, try that)

**Agents**:
- All implementation (40K lines)
- All tests (3,288 cases)
- All PR creation (86 of 102)
- All review comment fixes
- All CI failure resolution

**Human never committed directly to feature branch.**

## Related Research

- [[Orchestration layer separates business context from coding context]] - Elvis's swarm uses similar pattern
- [[Git worktrees enable parallel agent execution without conflicts]] - Agent Orchestrator uses worktrees
- [[Multi-model code review catches different error types]] - Automated review with Bugbot

## Next Steps

**For Agent Orchestrator** (from article):
1. Message orchestrator from Telegram/Slack (check status, approve merge, redirect agent while on walk)
2. Tighter mid-session feedback (detect drift, inject course corrections)
3. Automatic escalation (agent → orchestrator → human, only if genuinely needed)
4. Reconciler for auto conflict resolution
5. Docker/K8s runtimes for cloud

**For NanoClaw** (potential applications):
1. Implement self-healing PR workflow for self-edit
2. Add structured logging for activity detection
3. Capture success/failure patterns from skill executions
4. Build pluggable architecture for swappable tools
5. Create orchestrator for complex multi-agent tasks

## Source

Article: https://x.com/agent_wrapper/status/2025986105485733945
GitHub: https://github.com/ComposioHQ/agent-orchestrator (Open Source)
Metrics report: https://github.com/ComposioHQ/agent-orchestrator/releases/tag/metrics-v1
Visualizations: https://pkarnal.com/ao-labs/
Company: Composio (hiring SF & Bangalore)
Author: Prateek (@agent_wrapper)
