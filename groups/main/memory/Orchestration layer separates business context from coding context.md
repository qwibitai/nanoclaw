---
description: Architecture pattern - orchestrator holds business context while coding agents focus on implementation
topics: [agent-architecture, context-engineering, orchestration]
created: 2026-02-24
source: https://x.com/elvissun/status/2025920521871716562
---

# Orchestration layer separates business context from coding context

Context windows are zero-sum. You must choose what goes in.

**Problem**: One AI can't effectively handle both business context AND code
- Fill with code → no room for business context
- Fill with customer history → no room for codebase

**Solution**: Two-tier system where each AI gets exactly what it needs

## Architecture

**Orchestrator (OpenClaw "Zoe")**:
- Holds business context (customer data, meeting notes, past decisions, failures)
- Lives in Obsidian vault
- Spawns specialized agents
- Writes their prompts with full context
- Picks right model for each task
- Monitors progress
- Respawns failed agents with better prompts

**Coding Agents (Codex/Claude Code)**:
- Focus purely on implementation
- Get precise, context-rich prompts from orchestrator
- Work in isolated worktrees
- Create PRs when done

## Why This Works

**Specialization through context, not models**:
- Orchestrator sees: "Customer wants reusable configs. They're an agency. Meeting notes say they need templates."
- Coding agent sees: "Implement template system. Schema in src/types/template.ts. Customer config: {json}"

**Orchestrator advantages**:
- Proactive task finding (scans Sentry errors, meeting notes, git log)
- Learns from failures (logs what worked: "This prompt structure works for billing features")
- Unblocks stuck agents with business context
- Never has to juggle code and strategy simultaneously

## Real Results

From Elvis (@elvissun):
- 94 commits in one day (3 client calls, never opened editor)
- Average 50 commits/day
- 7 PRs in 30 minutes (idea to production)
- Success rate: One-shots most small-medium tasks without intervention

**Cost**: ~$190/month (Claude + Codex)

## Key Insight

This is the Ralph Loop V2:
- **Old Ralph Loop**: Same prompt each cycle, distilled learnings improve retrieval
- **New version**: Orchestrator rewrites prompts on failure using business context
  - "Agent went wrong direction? Stop. Customer wanted X not Y. Here's what they said."
  - "Out of context? Focus only on these three files."

## Implementation Pattern

**Orchestrator responsibilities**:
1. Translate customer requests into agent tasks
2. Pull relevant context (DB config, meeting notes, past attempts)
3. Spawn agent with detailed prompt
4. Monitor via task registry JSON
5. Respawn with better prompt if failed
6. Notify human only when ready for review

**Agent responsibilities**:
1. Implement feature in isolated worktree
2. Create PR
3. Pass CI and code reviews
4. Include screenshots for UI changes

**Separation of concerns = Specialization through context**

## Related Notes
- [[Progressive disclosure uses three-level architecture for AI context]]
- [[Cross-module references enable knowledge graph traversal without loading entire system]]

## Source
Elvis - "OpenClaw + Codex/ClaudeCode Agent Swarm: The One-Person Dev Team"
Twitter: https://x.com/elvissun/status/2025920521871716562

---
*Topics: [[agent-architecture]] · [[context-engineering]] · [[orchestration]]*
