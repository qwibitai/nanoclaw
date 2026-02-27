---
description: Architectural pattern - production agents need durability (persist state, resume on crash) vs demo agents (fresh every run)
topics: [agent-architecture, production-systems, state-management]
created: 2026-02-27
source: https://x.com/ashpreetbedi/status/2026708881972535724
---

# Production agents require state persistence not request-response architecture

**Context: Building production-ready AI agent systems**

Demo agents work great as request-response systems. Production agents need fundamentally different architecture.

## The Core Difference

**Demo Agents**:
- Run fresh every time
- Request → Response
- No memory between runs
- Single user
- Can fail and restart

**Production Agents**:
- Live across sessions
- Accumulate context
- Mutate state
- Remember previous interactions
- Multi-tenant
- Must resume on crash

## What Must Be Persisted

**Execution State**:
- Inputs and outputs
- Intermediate artifacts
- State transitions
- Execution traces

**Why**: If agent crashes on step 12 of 15, you must know exactly where it was to resume.

## Agents Break Request-Response Contract

**Traditional Web**: Request → Work → Response

**Agents**:
- Think and stream tool calls
- Spawn sub-agents
- Retrieve memory and change direction mid-execution
- Run background tasks ("analyze this and email me")

**Architecture Implications**:
- Use SSE (Server-Sent Events) for streaming
- WebSockets for bidirectional control
- Background task polling for long-running jobs
- State persistence for resume capability

## Benefits of Persistence

**Without persistence**: Every run starts from zero

**With persistence**:
- Every run can become cheaper (reuse cached results)
- Safer (know what failed and why)
- Smarter (learn from previous runs)

**Optimization opportunities**:
- Compress context instead of replaying full history
- Debug failures with full trace
- Extract successful runs into reusable few-shot patterns
- Analyze latency, token usage, tool behavior to optimize cost

## The Key Quote

> "An agent without durability is a demo.
> An agent with durability is a system."

> "You are no longer serving responses.
> You are maintaining long-lived computation."

## Implementation Pattern

**For long-running tasks**:
1. Agent receives task
2. Persist initial state
3. Execute steps, persisting after each
4. On crash: read persisted state, resume from last checkpoint
5. On completion: persist final result

**For resumable conversations**:
1. Load conversation history
2. Load accumulated context/memory
3. Process new input
4. Persist updated state
5. Return response

## When to Use Each Approach

**Request-Response (Demo)**:
- Single-turn interactions
- Stateless operations
- No need to resume
- One user, development/testing

**State Persistence (Production)**:
- Multi-turn conversations
- Long-running tasks
- Must resume on failure
- Multi-tenant systems
- Learning from history

## Related Notes
- [[Orchestrator agent bottleneck is human attention not agent capability]]
- [[Self-improving systems compound when agents build their own tools]]
- [[JSONL format prevents agent data loss through append-only design]]

## Source
Ashpreet Bedi (@ashpreetbedi) - "The 7 Sins of Agentic Software"
- Tweet: https://x.com/ashpreetbedi/status/2026708881972535724
- Context: 3 years building agent infrastructure
- Key insight: Durability separates demos from systems

---
*Topics: [[agent-architecture]] · [[production-systems]] · [[state-management]]*
