# Comprehensive Feature Utilization Report

## NanoClaw + Claude Agent SDK + Claude Code Analysis

**Date**: March 7, 2026
**Analysis Type**: Feature gap + codebase utilization review
**Scope**: Current implementation vs. available SDK/Code features

---

## Executive Summary

NanoClaw has a **solid foundation** but is leaving 40-50% of available Agent SDK & Claude Code features on the table. Recent releases (Agent SDK v0.1.46+, Claude Code v2.1.0+) unlock **6 high-value features** that can be implemented in **<15 hours total**.

| Category | Effort | Impact | Priority |
|----------|--------|--------|----------|
| Audit Hooks (agent_id tracking) | 2-3h | Security + debugging | 🥇 |
| Structured Outputs validation | 1-2h | Quality gate | 🥈 |
| Streaming output to users | 3-4h | UX improvement | 🥉 |
| Runtime MCP control | 2-3h | Dynamic tools | Priority 4 |
| Extended thinking + effort | 2-3h | Better reasoning | Priority 5 |
| Custom tools (GitHub, etc.) | 4-6h/tool | Domain power | Priority 6 |

---

## Part 1: Claude Code Advanced Features (Underutilized in NanoClaw)

### 1. Hooks System (14 Lifecycle Events)

**Current Status**: ❌ Not implemented in NanoClaw

**Claude Code Hooks Available**:

```
SessionStart → UserPromptSubmit → PreToolUse → PermissionRequest →
PostToolUse → PostToolUseFailure → SubagentStart → SubagentStop →
SubagentLaneControl → PreCompletion → SessionEnd → FileEdit →
CommitPush → ToolSearch
```

**Why NanoClaw Should Implement**:

- Every agent invocation should trigger PostToolUse hooks for audit logging
- PreToolUse hooks can validate dangerous bash commands
- SessionStart hooks can initialize per-group context

**Implementation in NanoClaw Context**:

```typescript
// In src/container-runner.ts, add hooks config:
const options = {
  hooks: {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            command: "~/.claude/hooks/validate-bash.sh"
          }
        ]
      },
      {
        matcher: "^mcp__",  // All MCP tools
        hooks: [
          {
            type: "command",
            command: "~/.claude/hooks/log-mcp-tool.sh"
          }
        ]
      }
    ],
    PostToolUse: [
      {
        hooks: [
          {
            type: "command",
            command: "~/.claude/hooks/audit-tool-result.sh"
          }
        ]
      }
    ]
  }
};
```

**Quick Win**: Add audit logging hook to log all tool calls to SQLite `tool_audit` table

---

### 2. Structured Outputs (GA Since Nov 2025)

**Current Status**: ❌ Not used

**What It Does**: Guarantee agent responses match JSON schema - replaces custom parsing/validation

**Use in NanoClaw**:

```typescript
// Define response schema for worker dispatch
const dispatchResponseSchema = {
  type: "object",
  properties: {
    status: { enum: ["success", "failure", "partial"] },
    result: { type: "string" },
    toolsUsed: { type: "array", items: { type: "string" } },
    duration: { type: "number" }
  },
  required: ["status", "result"]
};

// Agent guarantees to return JSON matching schema
```

**Quick Win**: Add structured outputs for worker dispatch completions (Priority 2 after hooks)

---

### 3. Hook Types: Shell Command vs. Prompt Hooks

**Available Hook Types**:

- **Command**: Shell script that validates/logs/blocks
- **Prompt**: LLM prompt that decides approve/deny
- **Agent**: Run subagent for complex decision

**For NanoClaw**:

- Use **command hooks** for fast audit logging (pre-built)
- Use **prompt hooks** for complex validation (e.g., "Is this code review thorough?")

---

### 4. MCP Best Practices (200+ Community Servers)

**Current Status**: ⚠️ Browser automation exists; others missing

**Top Servers for NanoClaw**:

| Server | Use Case |
|--------|----------|
| `github` | Create PRs, manage issues, get repo context |
| `postgres` | Query databases directly |
| `sentry` | Access error tracking data |
| `notion` | Read/write from knowledge base |
| `filesystem` | Sandboxed file access |
| `context7` | Library documentation lookup |

**Action**: Add GitHub server first (code review tasks)

---

## Part 2: Agent SDK Features (Recent Releases)

### 1. Hook Input Enhancements (v0.1.46 - NOW AVAILABLE)

**What Changed**: PreToolUse/PostToolUse hooks now receive:

```typescript
{
  agent_id: "engineering-bot",      // NEW
  agent_type: "code-reviewer",       // NEW
  tool_name: "Bash",
  tool_input: { command: "npm test" },
  // ... existing fields
}
```

**Why It Matters**:

- Track which agent ran which tool
- Route audit logs by agent
- Debug agent-specific issues

**Codebase Mapping**:

- `src/extensions/jarvis/dispatch-service.ts` → can extract agent metadata
- `src/ipc.ts` → can correlate with worker run IDs

**Implementation**:

```typescript
// Hook now receives agent_id from dispatch
async function auditToolUse(input) {
  const { agent_id, agent_type, tool_name } = input;
  // Log: {timestamp, agent_id, agent_type, tool_name, success}
  db.insertToolAudit({
    workerId: agent_id,
    tool: tool_name,
    timestamp: Date.now()
  });
}
```

---

### 2. Session History API (v0.1.46)

**New Functions**:

```python
# List all sessions
sessions = client.list_sessions()
# → [{ "session_id": "...", "model": "sonnet", "created": "..." }]

# Get messages from specific session
messages = client.get_session_messages("session-abc")
# → Full conversation history
```

**Use in NanoClaw**:

- Export conversation history for audit/compliance
- Build analytics dashboard (most-used agents, tools, duration)
- Resume sessions across restarts

**Codebase Mapping**:

- `src/db.ts` → Already stores sessions! Expose via API
- `data/sessions/{group}/` → Already has JSONL files
- Add REST endpoint: `GET /api/groups/{id}/sessions`

---

### 3. MCP Runtime Control (v0.1.46)

**New Methods**:

```typescript
// Add/remove servers dynamically
await client.add_mcp_server("github", githubServerConfig);
await client.remove_mcp_server("old-server");
const status = await client.get_mcp_status();
```

**Why It Matters for NanoClaw**:

- Load different tools per task type
- Code review task → GitHub + Bash
- Research task → WebSearch + WebFetch
- Support task → Knowledge base + Slack

**Implementation Path**:

1. Extend dispatch payload with `mcp_servers: ["github", "context7"]`
2. In container-runner, dynamically add servers before invocation
3. Save cost by only loading needed servers

---

### 4. Typed Task Messages (v0.1.46)

**New Message Types**:

```typescript
// Instead of generic messages:
type TaskStarted = { type: "task_started", task_id, name };
type TaskProgress = { type: "task_progress", task_id, percent, message };
type TaskNotification = { type: "task_notification", level, message };
```

**Use in NanoClaw**:

- Better typing for task events
- Cleaner UI updates (show % progress)
- Proper error escalation

---

### 5. Fine-Grained Tool Streaming (v0.1.48 - Fixed)

**Status**: ✅ Now fixed (was broken in v0.1.36-0.1.47)

**What It Enables**:

```
User sees: "[Agent working...] Read 3 files → Running analysis → Generating response"
```

**Implementation**:

```typescript
const options = {
  includePartialMessages: true  // v0.1.48 now delivers these correctly
};

for await (const msg of query(prompt, options)) {
  if (msg.type === "stream_event") {
    if (msg.event.type === "content_block_start") {
      toolName = msg.event.content_block.name;
      router.sendProgress(`[Using ${toolName}...]`);
    }
  }
}
```

---

## Part 3: Codebase-Specific Analysis

### Current Tool Stack (src/container-runner.ts)

**Used**:

- ✅ Read, Write, Edit, Bash, Grep
- ✅ Browser automation (agent-browser skill)
- ✅ WebSearch, WebFetch (built-in)

**Unused/Underutilized**:

- ❌ Vision (image analysis)
- ⚠️ Custom MCP tools (only browser exists)
- ❌ Structured outputs
- ❌ Extended thinking configuration
- ❌ Model selection per task

### Session Management (src/db.ts)

**Currently**:

- ✅ Stores full session history per group
- ✅ JSONL format at `data/sessions/{group}/.claude/`
- ❌ No audit trail for tool usage
- ❌ No analytics endpoints

**Opportunity**: Add `tool_audit` table to track:

```sql
CREATE TABLE tool_audit (
  id INTEGER PRIMARY KEY,
  worker_id TEXT,        -- from agent_id
  group_id TEXT,         -- from message routing
  tool_name TEXT,
  input_json TEXT,
  result_status TEXT,    -- "success" | "failure"
  duration_ms INTEGER,
  timestamp DATETIME,
  FOREIGN KEY (group_id) REFERENCES registered_groups(group_id)
);
```

### Group Isolation (src/group-queue.ts, src/group-folder.ts)

**Currently Strong**:

- ✅ Per-group filesystem isolation
- ✅ Queue-based serialization
- ✅ Memory isolation (each group → separate agent)

**Enhancement Opportunity**: Extend `group-folder.ts` to mount MCP-specific data:

```typescript
// Mount different MCP servers per group
const mcpForGroup = {
  "engineering": ["github", "context7"],
  "support": ["knowledge-base", "slack"],
  "research": ["webfetch", "postgresql"]
};

// In container-runner, pass to agent
mcp_servers: mcpForGroup[groupId]
```

### Dispatch Validation (src/dispatch-validator.ts)

**Current**:

- ✅ Validates dispatch payload structure
- ✅ Checks required fields

**Enhancement**: Add optional fields:

```typescript
interface DispatchPayload {
  groupId: string;
  message: string;

  // NEW: Optional advanced features
  effort?: "low" | "medium" | "high" | "max";
  requiresThinking?: boolean;
  maxThinkingTokens?: number;
  model?: "haiku" | "sonnet" | "opus";
  mcp_servers?: string[];
  structuredOutput?: JSONSchema;
}
```

---

## Part 4: Recommended Implementation Sequence

### Phase 1: Foundation (Week 1 - 6 hours)

**Priority 1: Audit Hooks** (2-3 hours)

```typescript
// File: ~/.claude/hooks/audit-tool-use.sh
#!/bin/bash
# Log tool invocation with agent_id from Agent SDK hook
AUDIT_LOG="$HOME/.nanoclaw/audit.log"
echo "$(date) agent_id=$AGENT_ID tool=$TOOL_NAME status=$TOOL_STATUS" >> "$AUDIT_LOG"
```

**Priority 2: Structured Outputs** (1-2 hours)

- Add schema validation to dispatch-validator.ts
- Define output schema for worker run completion
- Pass to Agent SDK options

**Priority 3: Basic Streaming** (1 hour)

- Enable `includePartialMessages: true`
- Wire stream events to router
- Test with WhatsApp channel

### Phase 2: Enhancement (Week 2 - 6 hours)

**Priority 4: Runtime MCP Control** (2 hours)

- Extend dispatch payload with mcp_servers array
- Dynamically add/remove in container-runner
- Test with GitHub server

**Priority 5: Extended Thinking** (2 hours)

- Add effort/thinking config to dispatch payload
- Route to Opus for high-effort tasks
- Log thinking token usage

**Priority 6: Model Selection** (2 hours)

- Route simple queries → Haiku
- Code review → Sonnet or Opus
- Track cost savings

### Phase 3: Advanced (Week 3+ - 8+ hours)

**Custom Tools** (4-6h each):

1. GitHub API wrapper
2. Database query tool
3. Knowledge base search
4. Slack notifications

**Vision Capabilities** (3-4 hours):

- Enable image analysis
- Screenshot understanding
- Document OCR

---

## Part 5: Architecture Alignment

All changes should follow NanoClaw's ownership rules:

| Component | Owner | Note |
|-----------|-------|------|
| Hooks config | `src/container-runner.ts` | Pass to Agent SDK |
| MCP mounting | `src/container-runner.ts` | Extend options |
| Dispatch payload | `src/dispatch-validator.ts` | Add schema |
| Audit storage | `src/db.ts` | New tool_audit table |
| Tool routing | `src/extensions/jarvis/*` | Jarvis extension layer |

---

## Part 6: Feature Interaction Examples

### Example 1: Code Review Task (All Features Combined)

```typescript
// Dispatch with advanced options
{
  groupId: "engineering",
  message: "Review PR #42",
  effort: "high",                    // Extended thinking
  maxThinkingTokens: 8000,
  model: "opus",                     // Best for analysis
  mcp_servers: ["github"],           // GitHub API
  requiredOutput: codeReviewSchema,  // Structured output
  hooks: {
    PreToolUse: [auditHook],         // Audit every tool
    PostToolUse: [logResultHook]
  }
}

// Flow:
// 1. Agent fetches PR via GitHub MCP
// 2. Thinks deeply about code quality (thinking tokens)
// 3. Each tool call logged to tool_audit
// 4. Returns JSON matching codeReviewSchema
// 5. User gets real-time streaming updates
```

### Example 2: Quick Support Response (Optimized for Speed)

```typescript
{
  groupId: "support",
  message: "How do I update my profile?",
  model: "haiku",                    // Fast + cheap
  effort: "low",
  mcp_servers: ["knowledge-base"],   // Only needed tool
  structuredOutput: supportAnswerSchema
}

// Cost: $0.80/MTok vs $15/MTok with Opus
// Speed: 50% faster
// Quality: Sufficient for FAQ-type questions
```

---

## Part 7: Implementation Checklist

### Pre-Implementation

- [ ] Review latest Agent SDK docs (v0.1.48+)
- [ ] Review Claude Code hooks guide
- [ ] Create feature tickets for each priority
- [ ] Get Andy's input on which features matter most

### Phase 1 Implementation

- [ ] Add audit hook infrastructure
- [ ] Create tool_audit table in db.ts
- [ ] Test hook filtering by tool type
- [ ] Add structured output schema to dispatch

### Testing

- [ ] Unit: Hook invocation with agent_id
- [ ] Integration: Full task flow with audit trail
- [ ] E2E: WhatsApp message → tool execution → audit log
- [ ] Performance: Measure hook overhead (should be <50ms)

### Monitoring

- [ ] Dashboard: Tool usage by agent
- [ ] Alerts: Dangerous commands blocked
- [ ] Analytics: Most-used tools per group
- [ ] Cost: Model selection savings

---

## Part 8: Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Hooks breaking tool execution | Test in isolation first |
| Performance impact | Benchmark hook overhead |
| Structured output rejecting valid responses | Graceful fallback to string |
| MCP server failures | Isolate per group, fail gracefully |
| Extended thinking token budget exceeded | Set reasonable limits |

---

## Next Steps (In Priority Order)

1. **Review & Validate** with Andy: Confirm which features unlock most value
2. **Create Feature Tickets**: Break down into PRs
3. **Implement Phase 1** (Audit Hooks + Structured Outputs): ~6 hours
4. **Measure Impact**: Cost savings, security visibility
5. **Iterate**: Gather feedback, move to Phase 2

---

## Sources

- [Claude Agent SDK Changelog](https://github.com/anthropics/claude-agent-sdk-python/blob/main/CHANGELOG.md)
- [Claude Code Changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [Claude Code Hooks Guide](https://code.claude.com/docs/en/hooks-guide)
- [Agent SDK Documentation](https://platform.claude.com/docs/en/agent-sdk)
- [MCP Integration Guide](https://mcpplaygroundonline.com/blog/claude-code-mcp-setup-best-servers-guide)
- [Understanding Claude Code Full Stack](https://alexop.dev/posts/understanding-claude-code-full-stack/)
