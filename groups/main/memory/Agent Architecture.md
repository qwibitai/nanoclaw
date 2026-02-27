---
description: MOC for agent system architecture, orchestration patterns, and production deployment strategies
type: moc
topics: [meta, agent-architecture]
created: 2026-02-27
---

# Agent Architecture

Map of Content for building production-ready AI agent systems.

## Core Principles

### Production vs Demo
- [[Production agents require state persistence not request-response architecture]]
  - Durability separates demos from systems
  - Must persist state, resume on crash
  - Long-lived computation, not request-response

### Human Bottlenecks
- [[Orchestrator agent bottleneck is human attention not agent capability]]
  - Real limitation is coordinating agents, not their coding ability
  - Remove human from CI/review loop
  - Orchestrator agent (not script) scales better

### Self-Improvement Loop
- [[Self-improving systems compound when agents build their own tools]]
  - Agents building harnesses → better agents → better harnesses
  - Recursive improvement pattern
  - Compounding returns over time

## Organizational Patterns

### Role Evolution
- [[Engineer role splits into environment builder and work manager with AI agents]]
  - **Harness engineer**: Build environment, tools, guardrails
  - **AI manager**: Direct and scope work before execution
  - Most important work happens before code is written

### Orchestration Layer
- [[Orchestration layer separates business context from coding context]]
  - Business logic separate from implementation
  - Allows architecture decisions without agent interference
  - Clear separation of concerns

## Implementation Patterns

### Parallel Execution
- [[Git worktrees enable parallel agent execution without conflicts]]
  - Each agent gets isolated directory
  - No interference between agents
  - Safe parallel work on same repository

### Task Discovery
- [[Proactive task discovery multiplies agent productivity]]
  - Agents find their own work
  - Don't wait for explicit instructions
  - Explore codebase for improvement opportunities

### Quality Assurance
- [[Multi-model code review catches different error types]]
  - Different models catch different bugs
  - Parallel review better than sequential
  - Diversity improves quality

### Code Quality
- [[Write-time enforcement catches LLM code quality issues before commit]]
  - Enforce quality at file write, not commit time
  - Faster feedback loop for agents
  - Prevents low-quality code from being saved

## Architecture Patterns Summary

**Production Requirements**:
- State persistence (JSONL, database)
- Resume capability on crash
- Multi-tenant isolation
- Observability and tracing

**Team Structure**:
- Harness engineers build environments
- AI managers direct agent work
- Orchestrator coordinates everything
- Humans focus on architecture and approval

**Parallel Execution**:
- Git worktrees for isolation
- Independent agent work streams
- No cross-interference
- Safe concurrent operations

**Quality & Discovery**:
- Write-time enforcement
- Multi-model review
- Proactive task finding
- Continuous improvement

## Related Topics

- [[Context Engineering]] - How to structure context for agents
- [[Documentation & Configuration]] - CLAUDE.md and progressive disclosure

## Real-World Examples

**Steinberger (OpenClaw)**:
- 6,600+ commits/month
- 5-10 agents simultaneously
- Ships code he doesn't read

**OpenAI Team**:
- Million-line product in 5 months
- 3 engineers, zero hand-written code
- 3.5 PRs/engineer/day

**Stripe Minions**:
- 1,000+ PRs/week
- Slack → Agent → CI → PR
- No human in between

## Key Insights

1. **Durability matters more than speed** - An agent that can resume is more valuable than a fast agent that crashes
2. **Environment > Code** - Building good harnesses is more important than writing code
3. **Parallel scales** - Multiple agents working independently beats sequential
4. **Human attention bottleneck** - Not agent capability
5. **Self-improvement compounds** - Agents improving their own tools creates exponential growth

---

*This MOC organizes 8 related notes about agent system architecture. As the knowledge base grows, more patterns and connections will emerge.*
