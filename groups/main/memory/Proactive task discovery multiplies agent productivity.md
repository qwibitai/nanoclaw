---
description: Automation pattern - orchestrator finds work autonomously by scanning error logs, meeting notes, and git history
topics: [automation, proactive-agents, task-discovery]
created: 2026-02-24
source: https://x.com/elvissun/status/2025920521871716562
---

# Proactive task discovery multiplies agent productivity

Orchestrator doesn't wait for task assignment. It finds work autonomously.

## Three Scanning Patterns

### Morning: Error Discovery
**Source**: Sentry error logs

**Action**:
- Scans for new errors
- Spawns agent per error to investigate and fix
- Example: "Found 4 new errors → spawned 4 agents"

**Value**: Bugs get fixed before users complain

### After Meetings: Feature Extraction
**Source**: Meeting notes (auto-synced to Obsidian)

**Action**:
- Scans notes for feature requests
- Flags customer-mentioned features
- Spawns agents to implement
- Example: "Scanned meeting notes → flagged 3 features → spawned 3 Codex agents"

**Value**: Feature requests become PRs same-day

### Evening: Documentation Updates
**Source**: Git commit log

**Action**:
- Scans commits for shipped features
- Spawns Claude Code to update changelog
- Updates customer-facing documentation
- Example: "Scanned git log → spawned agent for docs"

**Value**: Documentation stays current automatically

## User Experience

**Traditional workflow**:
1. User returns from meeting
2. Opens editor
3. Manually creates tasks from notes
4. Assigns to team or self
5. Starts implementation

**With proactive discovery**:
1. User takes a walk after customer call
2. Returns to Telegram: "7 PRs ready for review. 3 features, 4 bug fixes."
3. That's it.

**Zero manual task creation. Work happens while you're away.**

## Learning Pattern

**Orchestrator logs what works**:
- "This prompt structure works for billing features"
- "Codex needs type definitions upfront"
- "Always include test file paths"

**Reward signals**:
- CI passing
- All three code reviews passing
- Human merge

**Failure triggers loop**:
- Orchestrator analyzes why it failed
- Rewrites prompt with better context
- Respawns agent (max 3 attempts)

**Over time**: Orchestrator writes better prompts because it remembers what shipped

## Task Sources

**Current sources Elvis uses**:
1. Sentry (error monitoring)
2. Meeting notes (Obsidian vault)
3. Git commit log
4. CI failures (implicit)

**Potential sources**:
- Customer support tickets
- Analytics anomalies
- Performance monitoring alerts
- Slack/Discord mentions
- Email feature requests
- User feedback forms

## Contrast with Manual Assignment

**Manual**: Human creates backlog → prioritizes → assigns → monitors
**Proactive**: System discovers → spawns → completes → notifies when ready

**Savings**: Hours of project management per day

## Implementation Requirements

**Orchestrator needs**:
1. **Read access** to all source systems (Sentry, notes, git, etc.)
2. **Pattern recognition** to identify tasks
3. **Prioritization logic** (what's urgent vs. can wait)
4. **Agent spawning** capability
5. **Success/failure tracking** for learning

**Key insight**: Orchestrator has business context to determine what matters

## Related Notes
- [[Orchestration layer separates business context from coding context]]
- [[Episodic memory stores judgment not just facts]]

## Source
Elvis - Proactive task discovery in agent orchestration system

---
*Topics: [[automation]] · [[proactive-agents]] · [[task-discovery]]*
