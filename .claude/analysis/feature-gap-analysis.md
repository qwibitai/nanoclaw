# NanoClaw Feature Gap Analysis

## Claude Agent SDK & Claude Code Utilization Review

**Date**: March 7, 2026
**Project**: NanoClaw (Personal Claude Assistant on Agent SDK)
**Analysis Scope**: Current vs. potential Agent SDK + Claude Code feature usage

---

## Executive Summary

NanoClaw implements **core Agent SDK patterns** (container orchestration, message routing, group isolation) but leaves significant **advanced capabilities unexploited**:

| Category | Status | Impact |
|----------|--------|--------|
| **Basic Tool Access** | ✅ Implemented | Read, Bash, Grep, Write, Edit |
| **Container Isolation** | ✅ Implemented | Per-group VMs with mount security |
| **Message Persistence** | ✅ Implemented | SQLite-backed session continuity |
| **Advanced Hooks** | ❌ Missing | PreToolUse, PostToolUse, SessionStart |
| **Extended Thinking** | ❌ Missing | Complex reasoning with configurable tokens |
| **Streaming Output** | ❌ Missing | Real-time agent feedback to user |
| **Model Selection** | ❌ Missing | Per-agent model assignment (Opus, Sonnet, Haiku) |
| **Custom MCP Tools** | ⚠️ Partial | Browser automation exists; others undefined |
| **Vision/Multimodal** | ❌ Missing | Image analysis capabilities |
| **Subagent Orchestration** | ⚠️ Partial | Groups exist; typed AgentDefinition not used |
| **Audit Logging** | ⚠️ Partial | No tool-use validation/tracking |
| **Batch Processing** | ❌ Missing | No parallel task execution |

---

## Part 1: Currently Implemented Features

### ✅ Core Agent SDK Patterns (Well-Used)

**1. Container-Based Agent Execution**

- **File**: `src/container-runner.ts`, `src/container-runtime.ts`
- **Usage**: Each group runs agents in isolated Linux containers
- **Benefit**: OS-level security + resource limits

```typescript
// Each message invokes: runContainerAgent(groupId, message, session)
// → Docker/Apple Container spawns isolated agent process
```

**2. Session Management & Continuity**

- **File**: `src/db.ts`, `src/index.ts`
- **Usage**: SQLite stores full conversation history per group
- **Benefit**: Agents maintain context across multiple interactions

```typescript
// Session JSONL at: data/sessions/{group}/.claude/
// → Passed to Agent SDK on each invocation
```

**3. Message Routing & Channel Integration**

- **File**: `src/router.ts`, `src/channels/whatsapp.ts`
- **Usage**: WhatsApp → SQLite → Agent → Router → WhatsApp
- **Benefit**: Multi-channel support with group-based routing

```typescript
// startMessageLoop() polls DB every 2s
// Matches against TRIGGER_PATTERN for group registration
```

**4. Group-Based Isolation**

- **File**: `src/group-queue.ts`, `src/group-folder.ts`
- **Usage**: Per-group filesystem + queue serialization
- **Benefit**: Groups can't access each other's files/memory

```typescript
// Each group: isolated <group>/CLAUDE.md, <group>/data/
// Prevents cross-group context leakage
```

**5. Task Scheduling**

- **File**: `src/task-scheduler.ts`
- **Usage**: Cron-based recurring/one-time tasks
- **Benefit**: Agents can schedule long-running or periodic work

```typescript
// startScheduler() checks for due tasks every 60s
// Tasks run as full agents within group context
```

**6. Basic Tool Access**

- **File**: Container agent has default tools
- **Implemented**: Read, Bash, Grep, Write, Edit
- **Partially**: Browser automation (agent-browser skill exists)
- **Benefit**: Agents can interact with filesystem + shell

---

## Part 2: Underutilized Features (High-Impact)

### ⚠️ 1. Hook System (PreToolUse, PostToolUse, etc.)

**What It Is**: Callbacks that intercept agent lifecycle events

**Current Status**: ❌ **Not implemented**

**Available Hook Types**:

- `PreToolUse`: Validate/block tools before execution
- `PostToolUse`: Audit tool results after execution
- `SessionStart`: Initialize per-session state
- `SessionEnd`: Cleanup after agent finishes
- `Stop`: Custom stopping criteria
- `UserPromptSubmit`: Validate user input

**Why It Matters**:

- **Audit Trail**: Track exactly which tools agents used + why
- **Security Gate**: Block dangerous commands (e.g., `rm -rf /`)
- **Cost Control**: Log token usage per tool
- **Compliance**: Record agent decisions for accountability
- **Rate Limiting**: Throttle expensive operations

**Implementation Path**:

```typescript
// In container-runner.ts, pass hooks to Agent SDK invocation:
const options = {
  hooks: {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [validateBashCommand],
        timeout: 60
      },
      {
        matcher: "^mcp__",  // All MCP tools
        hooks: [auditMcpTool]
      }
    ],
    PostToolUse: [
      {
        hooks: [logToolResult]  // Log all results
      }
    ]
  }
};
```

**Quick Win**: Add audit logging for tool usage (security + debugging)

---

### ⚠️ 2. Extended Thinking (Configurable Reasoning)

**What It Is**: Agent uses more processing time/tokens for complex problems

**Current Status**: ❌ **Not configured**

**Configuration Options**:

```typescript
const options = {
  thinking: {
    enabled: true,
    maxThinkingTokens: 5000,  // Budget for reasoning
  },
  effort: "high"  // Affects thinking depth
};
```

**Why It Matters**:

- **Complex Reasoning**: Multi-step problem decomposition
- **Accuracy**: Better results on ambiguous tasks
- **Debugging**: Agents can reason through failures
- **Cost Tradeoff**: Longer thinking = slower but better quality

**Use Cases**:

- Code review tasks (analyze architecture, catch edge cases)
- Data analysis (decompose complex queries)
- Planning (multi-step workflows)
- Bug triage (reason about root causes)

**Implementation Path**:

```typescript
// In dispatch payload, add effort level:
{
  groupId: "engineering",
  effort: "high",  // vs "medium" (default), "low"
  requiresThinking: true,  // Task tags
  maxThinkingTokens: 8000
}
```

**Quick Win**: Enable for task categories that need it (code review, analysis)

---

### ⚠️ 3. Streaming Output (Real-Time Feedback)

**What It Is**: Agent sends partial/intermediate results to user before completion

**Current Status**: ❌ **Not implemented**

**What It Enables**:

- User sees tool execution progress (e.g., "[Using Bash...] found X results")
- Faster perceived latency (feedback before full completion)
- Early user interrupt (cancel long-running tasks)
- Better UX for streaming integrations

**How It Works**:

```typescript
// Agent SDK returns partial messages
const options = {
  includePartialMessages: true  // Enable streaming
};

for await (const message of query(prompt, options)) {
  if (message.type === "stream_event") {
    // Handle intermediate updates
    // Send to WhatsApp/frontend in real-time
  }
}
```

**Implementation Path**:

1. Add `includePartialMessages: true` to Agent SDK options
2. Modify container-runner output handling for stream events
3. Pipe updates through router to WhatsApp channel
4. UI shows: "[Agent working...] Read 3 files, running analysis..."

**Quick Win**: Streaming for long tasks (research, analysis, code review)

---

### ⚠️ 4. Model Selection Per Task

**What It Is**: Choose Sonnet (fast), Opus (powerful), Haiku (cheap) per task

**Current Status**: ❌ **Not configurable**

**Available Models**:

- `opus`: Most capable, best for complex reasoning (expensive)
- `sonnet`: Balanced quality/speed (current default)
- `haiku`: Fastest, best for simple tasks (cheap)

**Why It Matters**:

- **Cost Optimization**: Haiku for simple tasks ($0.80/MTok vs $15 for Opus)
- **Quality Guarantee**: Opus for critical decisions
- **Speed**: Haiku for time-sensitive operations

**Implementation Path**:

```typescript
// In dispatch payload:
{
  groupId: "support",
  task: "answer_question",
  model: "haiku"  // Fast response
}

{
  groupId: "engineering",
  task: "code_review",
  model: "opus"  // Complex reasoning
}
```

**Quick Win**: Route simple tasks to Haiku, complex to Opus

---

### ❌ 5. Custom Tools via MCP (Beyond Browser)

**What It Is**: Define domain-specific tools for agents

**Current Status**: ⚠️ **Partial** (browser automation exists)

**Available SDK Feature**:

```typescript
// Create custom MCP server with typed tools
const customServer = createSdkMcpServer({
  name: "domain-tools",
  tools: [
    tool("fetch_invoice", "Retrieve invoice by ID",
      { invoiceId: z.string() },
      async (args) => ({ /* return */ })
    )
  ]
});
```

**Opportunities**:

- `fetch-document`: Query knowledge base / docs
- `create-ticket`: Integrate with bug tracker
- `send-notification`: Alert users
- `query-database`: Direct data access
- `github-api`: Create PRs, manage issues
- `slack-notify`: Post to Slack channels

**Implementation Path**:

1. Identify repeating manual agent patterns
2. Extract as reusable tools
3. Wrap in MCP server
4. Mount in container at startup

**Quick Win**: GitHub integration tool for code review tasks

---

### ❌ 6. Vision/Multimodal Capabilities

**What It Is**: Agents can read + analyze images

**Current Status**: ❌ **Not implemented**

**What It Unlocks**:

- Screenshot analysis (UI/UX testing)
- Document OCR (invoice processing)
- Diagram interpretation (architecture review)
- Code snippet recognition (legacy system discovery)

**Implementation Path**:

```typescript
// In tool set: enable vision
const options = {
  allowedTools: [
    "Read",
    "Vision"  // New tool: analyze images
  ]
};
```

**Quick Win**: Add screenshot analysis for web testing tasks

---

### ❌ 7. Subagent Orchestration (Typed)

**What It Is**: Define specialized subagents with custom prompts + tool restrictions

**Current Status**: ⚠️ **Partial** (groups exist, typed definitions missing)

**What It Enables**:

```typescript
// Instead of generic agent, define specialists
const agents = {
  code_reviewer: {
    description: "Expert code reviewer",
    prompt: "You are a senior engineer reviewing PRs...",
    tools: ["Read", "Grep", "Bash"]  // No browser/write
  },
  research_analyst: {
    description: "Research analyst",
    prompt: "You are a thorough researcher...",
    tools: ["Read", "Bash", "WebSearch", "WebFetch"]
  }
};
```

**Implementation Path**:

1. Define `AgentDefinition` for each role
2. Extend dispatch payload: `agentRole: "code_reviewer"`
3. Pass definitions to Agent SDK at startup
4. Agents auto-select based on task type

**Quick Win**: Specialized agents for review vs. research vs. support

---

## Part 3: Changelog Features (Recent Releases)

### NanoClaw Releases (1.2.8+)

From git log (last 20 commits):

- ✅ Control plane (lane status management)
- ✅ Runtime ownership isolation
- ✅ Codex integration + role descriptions
- ✅ Lane control service enhancements
- ✅ GitHub multi-agent collaboration

### Claude Agent SDK v0.1.46+ (March 2026)

- ✅ **Hook input enhancements**: `agent_id`, `agent_type` now available in PreToolUse/PostToolUse hooks
- ✅ **Session history API**: `list_sessions()`, `get_session_messages()` for querying past sessions
- ✅ **MCP runtime control**: `add_mcp_server()`, `remove_mcp_server()` for dynamic tool loading
- ✅ **Typed task messages**: `TaskStarted`, `TaskProgress`, `TaskNotification` for better event handling
- ✅ **ResultMessage.stop_reason**: Inspect why conversations ended (useful for debugging)
- ✅ **Fine-grained tool streaming**: Fixed (v0.1.48) partial message deltas now working

### Claude Code v2.1.0+ (Jan-Mar 2026)

- ✅ **LSP Integration**: Code structure understanding, go-to-definition, find references
- ✅ **Structured Outputs**: GA since Nov 2025 - guarantee JSON schema validation from agents
- ✅ **HTTP Hooks**: POST JSON to external services instead of shell hooks
- ✅ **File Checkpointing**: Rewind file changes to specific checkpoint
- ✅ **`--resume` sessions**: Resume multi-day sessions with full context
- ✅ **1M token context window**: Beta feature (`context-1m-2025-08-07`) on Sonnet 4/4.5
- ✅ **`/loop` command**: Recurring prompts + cron scheduling in sessions
- ✅ **Subagent type defaults**: Omit `agent_type` for generic-purpose agents

**Potential Next Steps**:

- Extended thinking + effort levels per task
- Hook-based audit logging (NOW enabled with agent_id/agent_type metadata)
- Streaming output to channels (fine-grained tool streaming fixed in v0.1.48)
- Custom tool definitions (runtime MCP control enables dynamic tool loading)
- Model selection per task type
- Vision capabilities for document/screenshot tasks
- Session history endpoints for analytics

---

## Part 4: Recommended Quick Wins (Priority Order)

### 🥇 Priority 1: Audit Hooks (2-3 hours)

**Impact**: Security + debugging
**Effort**: 2-3 hours
**What**: Log all tool invocations + results

```typescript
// Pre-hook: log tool name + args
// Post-hook: log success/failure + duration
// Storage: SQLite tool_audit table
```

### 🥈 Priority 2: Model Selection (1-2 hours)

**Impact**: Cost optimization
**Effort**: 1-2 hours
**What**: Route tasks to Haiku/Sonnet/Opus based on complexity

```typescript
// Add model field to dispatch payload
// Default: sonnet
// Simple tasks: haiku
// Complex: opus
```

### 🥉 Priority 3: Streaming Output (3-4 hours)

**Impact**: UX improvement
**Effort**: 3-4 hours
**What**: Real-time progress updates via WhatsApp

```typescript
// Enable includePartialMessages
// Parse stream events in container-runner
// Send progress messages to router
```

### Priority 4: Extended Thinking (2-3 hours)

**Impact**: Quality for complex tasks
**Effort**: 2-3 hours
**What**: Enable thinking for analysis/review tasks

```typescript
// Add thinking config to options
// Tag tasks: requiresThinking: true
// Budget tokens per effort level
```

### Priority 5: Custom Tools (4-6 hours per tool)

**Impact**: Domain specialization
**Effort**: 4-6 hours per tool
**What**: GitHub API, database query, ticket creation

```typescript
// Create MCP servers for high-frequency patterns
// Start with GitHub (PRs, issues, code review)
```

---

## Part 5: Architecture Alignment

**Where to Implement**:

| Feature | Recommended File | Rationale |
|---------|-----------------|-----------|
| Hooks | `src/container-runner.ts` | Pass options to Agent SDK |
| Model selection | `src/dispatch-validator.ts` → `src/container-runner.ts` | Route decision at dispatch time |
| Streaming | `src/container-runner.ts` | Intercept output, pipe to router |
| Extended thinking | `src/container-runner.ts` | Options passed to Agent SDK |
| Custom tools | `container/mcp-servers/` (new dir) | Mount at container startup |
| Vision | `container/skills/` (extend) | New tool skill |
| Subagents | `src/types.ts` + `src/extensions/jarvis/` | AgentDefinition in dispatch |

**Follow CLAUDE.md**: Jarvis extension (`src/extensions/jarvis/*`) owns task routing; core stays generic.

---

## Part 6: Feature Interaction Matrix

```
Extended Thinking + Audit Hooks
  → Log reasoning + final decision

Model Selection + Streaming
  → Fast feedback on simple tasks, detailed on complex

Custom Tools + Subagents
  → Specialists with domain-specific tools

Vision + Browser + Custom Tools
  → Complete web automation (screenshot → analyze → act)
```

---

## Appendix: Agent SDK Feature Checklist

| Feature | Available | Implemented | Priority |
|---------|-----------|------------|----------|
| Basic tools (Read, Bash, Grep, Edit) | ✅ | ✅ | — |
| Tool hooks | ✅ | ❌ | 1 |
| Extended thinking | ✅ | ❌ | 3 |
| Model selection | ✅ | ❌ | 2 |
| Streaming output | ✅ | ❌ | 4 |
| Custom MCP tools | ✅ | ⚠️ | 5 |
| Vision/image analysis | ✅ | ❌ | 6 |
| Subagent definitions | ✅ | ⚠️ | 5 |
| Session management | ✅ | ✅ | — |
| Browser automation | ✅ | ✅ | — |
| Batch processing | ✅ | ❌ | 7 |
| Caching | ✅ | ❌ | 7 |

---

## Next Steps

1. **Validate Priorities**: Review with Andy developer—confirm which features unlock most value
2. **Create Feature Tickets**: Break down into atomic feature cards
3. **Implement Priority 1 (Hooks)**: Start audit logging for security + debugging visibility
4. **Measure Impact**: Track tool usage, model selection cost savings, thinking quality gains
5. **Iterate**: Feedback loop for feature usage patterns
