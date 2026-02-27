# Article: The 7 Sins of Agentic Software

**Source**: https://x.com/ashpreetbedi/status/2026708881972535724
**Author**: Ashpreet Bedi (@ashpreetbedi)
**Date**: February 2026
**Read**: February 25, 2026

## Summary

"Demos are easy. Production is hard" - After 3 years building agent infrastructure, the real challenge isn't building agents, it's building production systems. Seven critical mistakes teams make when shipping agentic software: treating agents as request-response, ignoring state persistence, lacking observability, forgetting multi-tenancy, skipping governance, underestimating cost, and neglecting security.

Key insight: Production agents are fundamentally different from demos - they need durability, isolation, governance, and proper architecture.

## The 7 Sins

### Sin 1: Treating Agents as Request-Response

**The mistake**: Wrap agent in FastAPI, create endpoints for chat/session/auth/uploads. One endpoint becomes five, then fifteen. Traffic spikes, rate limits hit.

**The problem**: Traditional software = request → work → response. Agents break this contract.

**What agents do**:
- Think and stream tool calls
- Spawn sub-agents
- Retrieve memory
- Change direction mid-execution

**Solution**: Use SSE (Server-Sent Events) for streaming, WebSockets for bidirectional control. But some tasks require background execution and polling.

**Example**: "Analyze this dataset and email me a report"
- Long-running background task
- Need to persist execution state
- Resume on crash
- Email when done

### Sin 2: Ignoring State Persistence

**Demo agents**: Run fresh every time

**Production agents**:
- Live across sessions
- Accumulate context
- Mutate state
- Remember

**Must persist**:
- Inputs and outputs
- Intermediate artifacts
- State transitions
- Execution traces

**Why**: If agent crashes on step 12 of 15, you must know exactly where it was.

**What to persist**:
- Compress context instead of replaying full history
- Debug failures
- Extract successful runs into reusable few-shot patterns
- Analyze latency, token usage, tool behavior to optimize cost

**Key quote**: "Without persistence, every run starts from zero. With persistence, every run can become cheaper, safer, and smarter."

"An agent without durability is a demo. An agent with durability is a system."

"You are no longer serving responses. You are maintaining long-lived computation."

### Sin 3: Ignoring Observability

**The mistake**: No logging, monitoring, or tracing built in from day one.

**What you need**:
- Structured logging (not print statements)
- Distributed tracing
- Token usage tracking
- Tool call metrics
- Error patterns
- Latency breakdowns

**Why**: When agent fails in production, you need to know:
- Which step failed
- What state it was in
- Which tools were called
- What the LLM saw
- Token usage at each step

**Build observability from the start** - it's nearly impossible to retrofit.

### Sin 4: Ignoring Multi-Tenancy

**Demo agents**: Serve one user

**Production agents**: Serve thousands

**Infrastructure not designed for this**:
- Database wasn't
- Vector store wasn't
- Model provider definitely wasn't

**Build isolation yourself**:
- Namespaces
- Resource scoping
- RBAC (Role-Based Access Control)
- Policy enforcement

**One missing filter = incident report**
**One incorrect join = writing incident report**

**Key quote**: "Isolation is optional in a demo. It is critical in production."

### Sin 5: Ignoring Governance

**The mistake**: Treat governance as a feature to add later

**The reality**: Governance is part of the execution model

**Runtime must express policy**:
- Which actions are free?
- Which require user confirmation?
- Which require admin approval?

**When action is blocked, agent cannot crash. It must**:
- Pause
- Persist state
- Wait for approval
- Resume exactly where it left off

**Not**: Restart (restarting might issue the refund twice)

**Key quote**: "Governance is not a feature. It is part of the execution model."

### Sin 6: Ignoring Cost

**The mistake**: "We'll optimize later"

**The reality**: Cost optimization requires architectural changes

**Costs come from**:
- Model calls (prompt + completion tokens)
- Tool calls
- Vector search
- Storage
- Compute time

**What you need**:
- Per-user cost tracking
- Per-task cost tracking
- Cost budgets and limits
- Automatic fallback to cheaper models
- Caching strategies
- Token usage optimization

**Build cost tracking from day one** - retrofitting is hard.

### Sin 7: Ignoring Security

**The mistake**: "It's just calling APIs, how dangerous can it be?"

**The reality**: Agents have access to:
- User data
- External APIs
- Database queries
- File systems
- Email
- Payment systems

**Security requirements**:
- Input validation
- Output sanitization
- Tool call sandboxing
- Secrets management
- Audit logs
- Access controls

**One prompt injection** = data leak
**One unsanitized tool call** = RCE (Remote Code Execution)

**Security must be built in, not bolted on.**

## Key Learnings

### Tier 1: Immediately Applicable ✅

1. **State persistence is non-negotiable for production**
   - Demo agents run fresh every time
   - Production agents live across sessions, accumulate context, remember
   - Must persist: inputs/outputs, artifacts, state transitions, execution traces
   - If crash on step 12/15, must resume exactly where it stopped

2. **Agents break request-response contract**
   - Traditional: request → work → response
   - Agents: think, stream, spawn sub-agents, change direction mid-execution
   - Use SSE for streaming, WebSockets for bidirectional
   - Background tasks need polling architecture

3. **Governance is execution model, not feature**
   - Runtime must express policy (free actions, user confirmation, admin approval)
   - When blocked: pause, persist state, wait, resume (not restart)
   - Restarting could duplicate dangerous actions (refund twice)

4. **Build observability from day one**
   - Structured logging, distributed tracing, token metrics
   - Track which step failed, what state, which tools called
   - Nearly impossible to retrofit

### Tier 2: Strategic Value 📋

1. **Multi-tenancy requires isolation you build**
   - Databases, vector stores, model providers not designed for agent workloads
   - Build: namespaces, resource scoping, RBAC, policy enforcement
   - One missing filter = incident report

2. **Cost optimization requires architecture**
   - Can't optimize later - needs per-user/task tracking from start
   - Track: model calls, tool calls, vector search, storage, compute
   - Need budgets, limits, automatic fallback, caching

3. **Security must be built in**
   - Agents access: user data, APIs, databases, filesystems, email, payments
   - One prompt injection = data leak
   - One unsanitized tool call = RCE
   - Need: input validation, output sanitization, sandboxing, secrets management

### Tier 3: Reference Knowledge 📚

**Production vs Demo Agents**:

| Aspect | Demo | Production |
|--------|------|------------|
| Architecture | Request-response | Streaming + background tasks |
| State | Fresh every time | Persistent across sessions |
| Users | One | Thousands (multi-tenant) |
| Observability | Print statements | Structured logging + tracing |
| Governance | Optional | Part of execution model |
| Cost | Ignored | Tracked per-user/task |
| Security | "It's safe" | Input validation, sandboxing |

**Quote**: "Production is not the problem. Distributed systems have always been hard."

"The real challenge: Production agents are distributed systems that need durability, isolation, governance, and proper architecture from day one."

## Memory Notes Created

None - This is strategic knowledge about production considerations rather than specific patterns to extract as atomic notes. The learnings apply broadly to any production agent system.

## Applications to NanoClaw

### High Priority

**1. State persistence architecture**
- Currently: Conversation history in JSONL (good!)
- Need: Execution traces, intermediate artifacts, state transitions
- For multi-step tasks: ability to resume on crash

**2. Observability from start**
- Add structured logging (not just output)
- Track token usage per conversation
- Tool call metrics
- Error patterns

**3. Governance model**
- Define which actions need approval (destructive operations, external API calls with cost)
- Implement pause/resume for approval flow
- Prevent restart loops for dangerous actions

### Medium Priority

**4. Multi-tenant isolation**
- NanoClaw already has groups (main, other groups)
- Ensure proper resource scoping between groups
- RBAC for different user roles

**5. Cost tracking**
- Per-conversation token usage
- Per-group cost allocation
- Budget limits

**6. Security hardening**
- Input validation for commands
- Tool call sandboxing
- Secrets management (already using .env, good)
- Audit logs

### Low Priority

**7. Architecture for background tasks**
- Currently: synchronous responses
- Consider: long-running tasks that resume
- Polling architecture for "analyze this and notify me"

## Implementation Metrics

- **Memory notes created**: 0 (strategic/reference material)
- **Sins identified**: 7
- **Production requirements**: State persistence, observability, multi-tenancy, governance, cost, security
- **Key pattern**: Agent durability separates demos from systems

## Key Quotes

"Demos are easy. Production is hard"

"Production is not the problem. Distributed systems have always been hard."

"An agent without durability is a demo. An agent with durability is a system."

"Without persistence, every run starts from zero. With persistence, every run can become cheaper, safer, and smarter."

"Governance is not a feature. It is part of the execution model."

"Isolation is optional in a demo. It is critical in production."

## Related Research

- [[Orchestrator agent bottleneck is human attention not agent capability]] - Production systems need automation
- [[Self-improving systems compound when agents build their own tools]] - Persistence enables learning
- [[Write-time enforcement catches LLM code quality issues before commit]] - Security/quality from day one

## Source

Tweet: https://x.com/ashpreetbedi/status/2026708881972535724
Author: Ashpreet Bedi (@ashpreetbedi)
Context: 3 years building agent infrastructure
Type: Production engineering lessons
