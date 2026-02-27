---
description: Model selection pattern - route tasks to agents based on their specific strengths not generic capability
topics: [agent-selection, task-routing, ai-models]
created: 2026-02-24
source: https://x.com/elvissun/status/2025920521871716562
---

# Agent specialization by task type maximizes effectiveness

Not all coding agents are equal. Choose based on task type, not availability.

## Agent Strengths

### Codex (Workhorse - 90% of tasks)
**Best for**:
- Backend logic
- Complex bugs
- Multi-file refactors
- Anything requiring reasoning across codebase

**Characteristics**:
- Slower but thorough
- Better at deep reasoning
- Handles complexity well

**When to use**: Default choice for implementation work

### Claude Code (Fast executor)
**Best for**:
- Frontend work
- Git operations (fewer permission issues)
- Quick fixes
- Component implementation

**Characteristics**:
- Faster than Codex
- Good at structured tasks
- Better permission handling

**When to use**: Frontend, git workflows, speed matters

### Gemini (Design specialist)
**Best for**:
- Beautiful UIs
- Design specs
- Visual components

**Workflow pattern**:
1. Gemini generates HTML/CSS spec
2. Hand spec to Claude Code
3. Claude implements in component system

**Characteristics**:
- Different superpower: Design sensibility
- Not for implementation, for specification

**When to use**: UI/UX that needs to look good

## Orchestrator's Role

**Zoe (orchestrator) picks the right agent**:
- Billing system bug → Codex
- Button style fix → Claude Code
- New dashboard design → Gemini (spec) → Claude Code (implementation)

**Routes outputs between agents**:
- Multi-stage workflows
- Spec → implementation handoffs
- Design → development pipeline

## Why This Matters

**Wrong agent selection**:
- Gemini implementing complex backend → poor results
- Codex for simple styling → overkill, slow
- Claude Code for deep refactor → misses edge cases

**Right agent selection**:
- Task completes faster
- Higher quality output
- Better success rate on first attempt

## Model Selection Criteria

Consider:
1. **Task complexity**: Simple → Claude, Complex → Codex
2. **Task type**: Backend → Codex, Frontend → Claude, Design → Gemini
3. **Speed requirement**: Fast → Claude, Thorough → Codex
4. **Cross-file reasoning**: Multi-file → Codex, Single file → Claude

## Cost Optimization

**Not all tasks need the best model**:
- Simple fixes: Use cheaper/faster model
- Critical features: Use best model for task type
- Design work: Use Gemini (specialized)

## Related Notes
- [[Orchestration layer separates business context from coding context]]
- [[Multi-model code review catches different error types]]

## Source
Elvis - Agent selection strategy in multi-agent swarm

---
*Topics: [[agent-selection]] · [[task-routing]] · [[ai-models]]*
