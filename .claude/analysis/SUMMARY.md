# NanoClaw Feature Utilization Analysis - Executive Summary

**Date**: March 7, 2026
**Status**: ✅ Complete Analysis
**Recommendation**: Implement Phase 1 (6 hours) for immediate value

---

## Quick Answer

**NanoClaw uses ~50% of available Agent SDK + Claude Code features.**

You have access to **6 high-value features** released in last 3 months that can be implemented in **<15 hours**:

| # | Feature | Effort | Impact | Status |
|---|---------|--------|--------|--------|
| 1 | Audit Hooks (agent_id tracking) | 2-3h | 🔴 Security+Debugging | Not used |
| 2 | Structured Outputs | 1-2h | 🟡 Quality gates | Not used |
| 3 | Streaming Output | 3-4h | 🟢 UX/Perception | Broken in v0.1.36-47, fixed v0.1.48 |
| 4 | Runtime MCP Control | 2-3h | 🟡 Tool flexibility | Not used |
| 5 | Extended Thinking | 2-3h | 🔴 Complex reasoning | Not configured |
| 6 | Custom MCP Tools | 4-6h/tool | 🔴 Domain power | Only browser exists |

---

## What's Working Well ✅

- **Container isolation** per group (solid foundation)
- **Session persistence** with full history
- **Basic tools**: Read, Bash, Grep, Write, Edit
- **Browser automation** via agent-browser skill
- **Message routing** across WhatsApp + group queues
- **Task scheduling** via cron

---

## What You're Missing ❌

### Claude Code Feature Gaps

- **14 Lifecycle Hooks** available (SessionStart, PreToolUse, PostToolUse, etc.)
  - Use case: Audit logging, permission gates, auto-validation
  - Current: Not implemented in NanoClaw

- **Structured Outputs** (GA Nov 2025)
  - Use case: Guarantee agent response matches JSON schema
  - Current: No validation on dispatch completion

- **14 Hook Event Types** (command, prompt, agent)
  - Use case: Deterministic validation (PreToolUse), complex decisions (prompt hooks)
  - Current: No hooks at all

- **200+ MCP Servers** available
  - Current: Only browser automation mounted
  - Missing: GitHub, PostgreSQL, Notion, Sentry, Context7

### Agent SDK Feature Gaps

- **Hook Metadata** (v0.1.46+)
  - `agent_id`, `agent_type` now available in hooks
  - Current: No hooks to receive them

- **Session History API** (v0.1.46)
  - `list_sessions()`, `get_session_messages()`
  - Current: Sessions stored but not exposed via API

- **Runtime MCP Control** (v0.1.46)
  - `add_mcp_server()`, `remove_mcp_server()` at runtime
  - Current: Static tool set

- **Typed Task Messages** (v0.1.46)
  - `TaskStarted`, `TaskProgress`, `TaskNotification`
  - Current: Generic message handling

- **Fine-Grained Streaming** (v0.1.48)
  - Fixed in latest version
  - Current: Not enabled

---

## Recommended Phased Rollout

### Week 1: Phase 1 - Foundation (6 hours)

**Do These 3 Things**:

1. **Add Audit Hooks** (2-3h)

   ```typescript
   // In src/container-runner.ts, add to Agent SDK options:
   hooks: {
     PostToolUse: [{
       hooks: [{ type: "command", command: "log-tool-use.sh" }]
     }]
   }
   ```

   **Unlock**: Full visibility into what agents do (security + debugging)

2. **Enable Structured Outputs** (1-2h)

   ```typescript
   // Define dispatch completion schema, pass to Agent SDK
   // Guarantee responses match expected format
   ```

   **Unlock**: Quality gates + proper error handling

3. **Enable Streaming** (1h)

   ```typescript
   // In Agent SDK options: includePartialMessages: true
   // Wire stream events through router to WhatsApp
   ```

   **Unlock**: Real-time user feedback (better UX)

### Week 2: Phase 2 - Enhancement (6 hours)

1. **Runtime MCP Control** (2h)
   - Extend dispatch payload with `mcp_servers: ["github", "context7"]`
   - Different tools per task type

2. **Extended Thinking + Effort** (2h)
   - Route complex tasks to Opus with thinking budget
   - Route simple tasks to Haiku (save cost)

3. **Model Selection** (2h)
   - Add `model: "haiku" | "sonnet" | "opus"` to dispatch
   - Track savings

### Week 3+: Phase 3 - Advanced (8+ hours)

1. **Custom Tools** (4-6h per tool)
   - GitHub API wrapper (code review, PR management)
   - Database query tool
   - Knowledge base search

2. **Vision Capabilities** (3-4h)
   - Screenshot analysis for UI testing
   - Document OCR

---

## Codebase Integration Points

| File | Enhancement | Effort |
|------|-------------|--------|
| `src/container-runner.ts` | Pass hooks + MCP config | 1h |
| `src/dispatch-validator.ts` | Add optional fields (effort, model, mcp_servers) | 1h |
| `src/db.ts` | Add tool_audit table | 1h |
| `src/router.ts` | Wire streaming events | 1h |
| `.claude/hooks/*.sh` | Audit logging scripts | 1h |
| **Total Phase 1** | **6 hours** | |

---

## Feature Interaction Example

**Real Use Case: Code Review Task**

```javascript
// Dispatch with advanced options:
{
  groupId: "engineering",
  message: "Review PR #42",
  effort: "high",                    // Extended thinking
  model: "opus",                     // Best for complex analysis
  mcp_servers: ["github"],           // GitHub API access
  structuredOutput: codeReviewSchema // Guaranteed format
}

// What happens:
// 1. PreToolUse hook validates access to GitHub
// 2. Agent fetches PR via GitHub MCP
// 3. Deep thinking about code quality (~8k tokens)
// 4. Each tool call logged to tool_audit table
// 5. Stream events show "[Using GitHub...] → [Analyzing...] → [Formatting...]"
// 6. Response guaranteed to match codeReviewSchema
// 7. Cost optimized (Opus only for complex task)
// 8. Full audit trail for security compliance
```

---

## Cost Impact

**Model Selection Alone**:

- Simple queries (FAQ, basic search): Haiku ($0.80/MTok)
- Complex analysis: Sonnet ($3/MTok) or Opus ($15/MTok)
- **Potential Savings**: 50-80% on low-complexity tasks

**Extended Thinking Trade-off**:

- Slower but higher quality on complex reasoning
- Best for: Code review, architecture analysis, bug triage

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Hooks breaking tool execution | Test in isolation first; graceful fallback |
| Performance overhead | Benchmark <50ms per hook |
| Streaming errors | Test with WhatsApp integration |
| MCP server failures | Fail gracefully per tool type |
| Token budget overages | Set reasonable thinking limits |

---

## Next Steps (Action Items)

1. **TODAY**: Review this analysis with Andy
   - Which features matter most for your workflows?
   - Any blockers or concerns?

2. **TOMORROW**: Create feature tickets
   - Break Phase 1 into PRs
   - Assign to lanes

3. **THIS WEEK**: Implement Phase 1
   - Hooks infrastructure
   - Structured outputs
   - Streaming support

4. **NEXT WEEK**: Phase 2
   - MCP runtime control
   - Model selection
   - Extended thinking

5. **ONGOING**: Measure impact
   - Tool audit dashboard
   - Cost savings tracking
   - Security event monitoring

---

## Documents Created

1. **feature-gap-analysis.md** - Detailed feature-by-feature breakdown
2. **comprehensive-feature-recommendations.md** - Full architecture guide
3. **SUMMARY.md** (this file) - Executive overview

All saved in `.claude/analysis/`

---

## Key Takeaway

**NanoClaw is a strong foundation, but leaving value on the table.** The recent Agent SDK releases (v0.1.46+) and Claude Code features (v2.1.0+) unlock 6 high-impact improvements that integrate naturally with your existing architecture.

**Phase 1 (6 hours) = Security visibility + Quality gates + Better UX**

Start there. Measure impact. Iterate.
