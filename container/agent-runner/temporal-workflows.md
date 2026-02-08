# Temporal Workflow Catalog

Reference for all available Temporal workflows. Use `temporal workflow start` or `temporal workflow signal` to interact with them.

## Connection Details

- **Address**: Set via `TEMPORAL_ADDRESS` env var (default: `host.docker.internal:7233`)
- **Namespace**: Set via `TEMPORAL_NAMESPACE` env var (default: `default`)
- **Task Queue**: Set via `TEMPORAL_TASK_QUEUE` env var (default: `openclaw-queue`)

## CLI Usage

```bash
# Start a workflow
temporal workflow start \
  --task-queue "${TEMPORAL_TASK_QUEUE:-openclaw-queue}" \
  --type <WorkflowName> \
  --input '<json>' \
  --address "${TEMPORAL_ADDRESS:-host.docker.internal:7233}" \
  --namespace "${TEMPORAL_NAMESPACE:-default}"

# Query workflow state
temporal workflow query \
  --workflow-id <id> \
  --name <queryName> \
  --address "${TEMPORAL_ADDRESS:-host.docker.internal:7233}" \
  --namespace "${TEMPORAL_NAMESPACE:-default}"

# Signal a workflow
temporal workflow signal \
  --workflow-id <id> \
  --name <signalName> \
  --input '<json>' \
  --address "${TEMPORAL_ADDRESS:-host.docker.internal:7233}" \
  --namespace "${TEMPORAL_NAMESPACE:-default}"

# Describe a workflow (status, history)
temporal workflow describe \
  --workflow-id <id> \
  --address "${TEMPORAL_ADDRESS:-host.docker.internal:7233}" \
  --namespace "${TEMPORAL_NAMESPACE:-default}"

# List workflows
temporal workflow list \
  --address "${TEMPORAL_ADDRESS:-host.docker.internal:7233}" \
  --namespace "${TEMPORAL_NAMESPACE:-default}"
```

---

## Workflows

### 1. runAgentTask
Spawn an agent, verify output against Definition of Done (Dodik agent — Haiku-based), retry with feedback until verified or max cycles.

**Tags**: agent, core, verification

**Input**:
```json
{
  "task": "string (required) — task description",
  "agent": "string — named agent from agent-configs",
  "agentDef": { "description": "string", "prompt": "string" },
  "model": "'opus' | 'sonnet' | 'haiku'",
  "maxRetries": "number — max verification retry cycles",
  "dod": "string — definition of done criteria"
}
```

**Output**: `{ status: string, output?: unknown, verified?: boolean, attempts?: number }`

---

### 2. runWithApproval
Two-phase workflow: plan (architect agent) → approval gate → implement (developer agent).

**Tags**: agent, approval, pipeline

**Input**:
```json
{
  "planTask": "string (required) — planning task description",
  "implementTask": "string (required) — implementation task description",
  "agentId": "string — agent for implementation phase"
}
```

**Output**: `{ status: string, output?: unknown }`

**Signals**: `approve` (to approve the plan), `reject` (with feedback)

---

### 3. jiraTaskPipeline
Full JIRA lifecycle: research → plan → approve → implement → MR.

**Tags**: agent, jira, pipeline, approval

**Input**:
```json
{
  "ticketId": "string (required) — JIRA ticket ID (e.g., 'CLAWD-10')"
}
```

**Output**: `{ status: string, phases: string[] }`

---

### 4. sendNotification
Send a notification message (fire-and-forget with retry).

**Tags**: notification, core

**Input**:
```json
{
  "message": "string (required) — message to send"
}
```

---

### 5. sendReminder
Send a notification after a delay.

**Tags**: notification, reminder

**Input**:
```json
{
  "message": "string (required) — reminder message",
  "delayMinutes": "number (required) — minutes to wait before sending"
}
```

---

### 6. sendReminderAt
Send a notification at a specific Unix timestamp.

**Tags**: notification, reminder

**Input**:
```json
{
  "message": "string (required) — reminder message",
  "atTimestampMs": "number (required) — Unix timestamp in milliseconds"
}
```

---

### 7. reminder
Cancelable/queryable reminder with status tracking.

**Tags**: notification, reminder, queryable

**Input**:
```json
{
  "message": "string (required) — reminder message",
  "delayMinutes": "number (required) — minutes to wait"
}
```

**Output**: `{ delivered: boolean }`

**Queries**: `status` — returns current reminder state
**Signals**: `cancel` — cancels the reminder

---

### 8. scheduledWake
Trigger OpenClaw heartbeat at intervals.

**Tags**: monitoring, heartbeat

**Input**:
```json
{
  "intervalMinutes": "number (required) — minutes between wakes",
  "iterations": "number (required) — number of times to wake"
}
```

---

### 9. monitorWorkflows
Check for failed workflows, create JIRA tickets, notify if human review needed.

**Tags**: monitoring, jira, scheduled

**Input**:
```json
{
  "sinceMinutes": "number (default: 15) — check failures since N minutes ago"
}
```

**Output**: `{ checked, failed, ticketsCreated, needsHumanReview }`

---

### 10. checkOpenClawHealthWorkflow
Health check with auto-recovery: diagnose, restart if needed, notify on failure.

**Tags**: monitoring, health, scheduled

**Input**: none

**Output**: `{ healthy, action?, recovered? }`

---

### 11. webSearchWorkflow
Web search with fallback chain: Perplexity → Brave → Gemini.

**Tags**: search, research

**Input**:
```json
{
  "query": "string (required) — search query",
  "sources": "string[] — preferred sources",
  "maxResults": "number — max results",
  "context": "string — additional context for search"
}
```

**Output**: `{ success, source, query, answer?, citations?, error? }`

---

### 12. deepResearchWorkflow
Deep research using Perplexity sonar-pro. Notifies on completion.

**Tags**: search, research, deep

**Input**:
```json
{
  "query": "string (required) — research query",
  "notifyOnComplete": "boolean (default: true) — send result as notification"
}
```

**Output**: `{ success, source, query, answer?, citations?, error? }`

---

### 13. updateOpenClawWorkflow
Nightly OpenClaw update: check version, update, run doctor, analyze release notes, propose config changes.

**Tags**: maintenance, update, scheduled

**Input**:
```json
{
  "dryRun": "boolean — check without applying",
  "force": "boolean — force update even if current",
  "channel": "string — update channel",
  "notifyOnComplete": "boolean — send notification on complete"
}
```

**Output**: `{ updated, previousVersion, currentVersion, newReleases, doctorPassed, analysisScheduled, error? }`

---

### 14. runClaudeCodeWorkflow
Run Claude Code CLI as a Temporal workflow with agent configs, budget control, tool restrictions, and optional worktree isolation.

**Tags**: agent, claude-code, coding

**Input**:
```json
{
  "prompt": "string (required) — the task for Claude Code",
  "agent": "string — named agent from agent-configs",
  "agentDef": { "description": "string", "prompt": "string" },
  "model": "'opus' | 'sonnet' | 'haiku'",
  "workingDirectory": "string — working directory",
  "systemPrompt": "string — additional system prompt (appended)",
  "sessionId": "string — continue existing session",
  "timeoutMs": "number (default: 600000) — activity timeout in ms",
  "maxTurns": "number — max conversation turns",
  "maxBudgetUsd": "number — budget limit in USD"
}
```

**Output**: `{ success, output, sessionId?, error?, durationMs, costUsd?, filesChanged? }`

---

### 15. jiraPlanWorkflow
JIRA ticket orchestration: query ticket, detect type, load SDLC flow from KB, run dynamicAgentWorkflow with inline process docs.

**Tags**: jira, agent, orchestration, pipeline

**Input**:
```json
{
  "ticketKey": "string (required) — JIRA ticket key (e.g., 'CLAWD-10')",
  "ticketType": "'bug' | 'feature' | 'infrastructure' | 'documentation' — override type detection",
  "maxIterations": "number (default: 20) — max iterations for dynamic workflow",
  "startPhase": "string — start at a specific phase (e.g., 'development' to skip analysis)"
}
```

**Output**: `{ status, ticketKey, ticketType, workflowResult }`

---

### 16. jiraPollerWorkflow
Poll JIRA for To Do tickets, start agent workflows for each, transition to In Progress. Deduplicates via deterministic workflow IDs.

**Tags**: jira, poller, scheduled, agent

**Input**:
```json
{
  "project": "string (default: 'CLAWD') — JIRA project key",
  "maxTasks": "number (default: 3) — max tasks per poll"
}
```

**Output**: `{ found: number, started: number, alreadyRunning: number, tickets: Array<{ key, summary, action, error? }> }`

---

### 17. buildMonitorWorkflow
Monitor CI/CD pipeline (GitLab CI or GitHub Actions) via webhook signal + polling fallback. Returns build status and failed job logs.

**Tags**: ci, monitoring, build, pipeline

**Input**:
```json
{
  "ticketKey": "string (required) — JIRA ticket key",
  "branch": "string (required) — Git branch being monitored",
  "provider": "'gitlab' | 'github' (required) — CI/CD provider",
  "projectId": "string (required) — GitLab project ID or GitHub 'owner/repo'",
  "maxWaitMs": "number (default: 1200000) — max wait time in ms (20 min)",
  "pollIntervalMs": "number (default: 30000) — polling interval in ms"
}
```

**Output**: `{ status: 'success'|'failed'|'cancelled'|'timeout', pipelineUrl?, failedJobs?, logs? }`

**Signals**: `buildResult` — `{ status: 'success'|'failed'|'cancelled', pipelineUrl?, failedJobs? }`

---

### 18. dynamicAgentWorkflow
Dynamic AI-orchestrated workflow: orchestrator decides execution path at runtime, routes to agents, supports human-in-the-loop.

**Tags**: agent, orchestration, dynamic, core

**Input**:
```json
{
  "task": "string (required) — task description to accomplish",
  "workflowDescription": "string (required) — how the workflow should orchestrate agents",
  "maxIterations": "number (default: 20) — max iterations before stopping"
}
```

**Output**: `{ status: 'completed'|'failed'|'max_iterations', iterations, lastResult, decisionHistory, state }`

**Queries**: `getState` — returns current `WorkflowState`
**Signals**: `humanResponse` — provide human input when requested by orchestrator

---

## Quick Examples

### Start a notification
```bash
temporal workflow start \
  --task-queue "${TEMPORAL_TASK_QUEUE:-openclaw-queue}" \
  --type sendNotification \
  --input '{"message":"Hello from the agent!"}' \
  --address "${TEMPORAL_ADDRESS:-host.docker.internal:7233}"
```

### Start a reminder
```bash
temporal workflow start \
  --task-queue "${TEMPORAL_TASK_QUEUE:-openclaw-queue}" \
  --type sendReminder \
  --input '{"message":"Check the build","delayMinutes":30}' \
  --address "${TEMPORAL_ADDRESS:-host.docker.internal:7233}"
```

### Run a Claude Code task
```bash
temporal workflow start \
  --task-queue "${TEMPORAL_TASK_QUEUE:-openclaw-queue}" \
  --type runClaudeCodeWorkflow \
  --input '{"prompt":"Fix the failing test in src/utils.test.ts","model":"sonnet"}' \
  --address "${TEMPORAL_ADDRESS:-host.docker.internal:7233}"
```

### Start a web search
```bash
temporal workflow start \
  --task-queue "${TEMPORAL_TASK_QUEUE:-openclaw-queue}" \
  --type webSearchWorkflow \
  --input '{"query":"latest TypeScript 5.7 features"}' \
  --address "${TEMPORAL_ADDRESS:-host.docker.internal:7233}"
```

### Start deep research
```bash
temporal workflow start \
  --task-queue "${TEMPORAL_TASK_QUEUE:-openclaw-queue}" \
  --type deepResearchWorkflow \
  --input '{"query":"comparison of Temporal vs Inngest for workflow orchestration"}' \
  --address "${TEMPORAL_ADDRESS:-host.docker.internal:7233}"
```

### Signal a workflow
```bash
temporal workflow signal \
  --workflow-id "my-workflow-id" \
  --name approve \
  --address "${TEMPORAL_ADDRESS:-host.docker.internal:7233}"
```

### Query workflow state
```bash
temporal workflow query \
  --workflow-id "my-workflow-id" \
  --name getState \
  --address "${TEMPORAL_ADDRESS:-host.docker.internal:7233}"
```
