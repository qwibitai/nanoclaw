# Learning System Design

## Goal

Close the feedback loop between agent execution outcomes and future agent behavior. The system distills outcomes, user corrections, and agent self-reports into actionable rules injected into agent prompts, and records successful multi-step workflows as reusable procedures that can be offered or auto-executed on matching future tasks.

## Architecture

Event-driven learning wired into the existing event bus. Three components subscribe to events and write to shared stores:

```
task.started  → Procedure Recorder (begin IPC trace)
task.complete → Procedure Recorder (save procedure from trace)
              → Rules Engine (detect outcome patterns, create rules)
              → learn.* events (observability)

message.inbound → Feedback Capture (detect user corrections → rules)
               → Procedure Matcher (check for matching procedure → offer/execute)

agent spawn → Outcome Enricher (query relevant rules → inject into prompt)
```

**Tech stack:** SQLite (learned_rules table), existing procedure-store (JSON files), existing outcome-store, existing event bus.

---

## Components

### 1. Rules Engine (`src/learning/rules-engine.ts`)

Distills outcomes, user feedback, and agent self-reports into actionable rules.

#### Rule Schema

```typescript
interface LearnedRule {
  id: string;
  rule: string;              // "Refresh Gmail OAuth tokens before email operations"
  source: 'outcome_pattern' | 'user_feedback' | 'agent_reported';
  actionClasses: string[];   // ["email.read", "email.send"]
  groupId: string | null;    // null = global
  confidence: number;        // 0.0–1.0
  evidenceCount: number;     // how many outcomes support this rule
  createdAt: string;
  lastMatchedAt: string;
}
```

#### Rule Creation (Three Sources)

**Outcome patterns (confidence: 0.5):** When the same `actionClass` fails 2+ times with similar error messages within a 7-day window, generate a rule. Uses simple string similarity on error messages to cluster failures. Confidence increases by 0.1 per additional supporting outcome, capped at 0.8.

**User feedback (confidence: 0.9):** When a user corrects the agent, capture the correction as a rule. Highest trust — user knows their domain.

**Agent self-reported (confidence: 0.3):** When the agent emits a `_lesson` block, save it as a rule. Lowest trust — agents hallucinate.

#### Storage

SQLite table `learned_rules` in the existing database. FTS5 index on `rule` and `actionClasses` columns for fast relevance matching.

```sql
CREATE TABLE learned_rules (
  id TEXT PRIMARY KEY,
  rule TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('outcome_pattern', 'user_feedback', 'agent_reported')),
  action_classes TEXT NOT NULL, -- JSON array
  group_id TEXT,               -- NULL = global
  confidence REAL NOT NULL DEFAULT 0.5,
  evidence_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_matched_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE learned_rules_fts USING fts5(rule, action_classes, content=learned_rules, content_rowid=rowid);
```

#### Confidence Decay

Rules that haven't matched in 30 days drop confidence by 0.1 per month. Rules below 0.1 confidence are pruned automatically. Decay runs as part of the existing event log pruning cycle.

#### Source Hierarchy

When rules contradict for the same action class: `user_feedback > outcome_pattern > agent_reported`. Higher-source rules suppress lower-source contradictions.

#### API

```typescript
function addRule(rule: Omit<LearnedRule, 'id' | 'createdAt' | 'lastMatchedAt'>): string;
function queryRules(actionClasses: string[], groupId: string, limit?: number): LearnedRule[];
function markMatched(ruleId: string): void;
function pruneStaleRules(): number;        // returns count pruned
function deleteRule(id: string): void;
```

---

### 2. Outcome Enricher (`src/learning/outcome-enricher.ts`)

Queries relevant rules and formats them into a compact block injected into the agent prompt at spawn time.

#### Flow

1. Determine likely action classes for the incoming task via keyword map:
   - `"email"`, `"gmail"`, `"inbox"`, `"message"` → `["email.read", "email.send"]`
   - `"PR"`, `"pull request"`, `"github"`, `"repo"`, `"commit"` → `["github.read", "github.write"]`
   - `"browser"`, `"website"`, `"page"`, `"navigate"`, `"click"` → `["browser.read", "browser.write"]`
   - `"cost"`, `"budget"`, `"spending"` → `["cost.read"]`
   - `"schedule"`, `"task"`, `"reminder"` → `["task.schedule"]`
   - No match → return all rules for the group (unfiltered, still ranked by confidence)
2. Query `learned_rules` filtered by action classes + group (including global rules where `group_id IS NULL`)
3. Rank by confidence descending, take top 5
4. Format as a compact text block, max 500 characters
5. Append to the agent prompt context (not baked into CLAUDE.md — ephemeral per spawn)

#### Output Format

```
## Learned Rules (auto-generated)
- Refresh Gmail OAuth tokens before any email operation (token lifetime: 1hr)
- Use GitHub API for PR checks, not browser automation (faster, more reliable)
- Login page at example.com requires 2FA — use stored session, don't re-auth
```

#### Constraints

- Max 500 characters for the rules block
- Only rules from the last 90 days (by `lastMatchedAt` or `createdAt`)
- Skip injection if no rules match the inferred action classes
- Each injected rule gets `markMatched()` called to update `lastMatchedAt`

#### API

```typescript
function buildRulesBlock(message: string, groupId: string): string | null;
```

Returns `null` if no relevant rules found (caller skips injection).

---

### 3. Procedure Recorder (`src/learning/procedure-recorder.ts`)

Records IPC action traces during task execution and saves successful traces as procedures.

#### IPC Trace Recording

On `task.started`: begin collecting IPC actions for the `groupId + taskId` pair into an in-memory buffer.

```typescript
interface TracedAction {
  type: string;          // "browser_navigate", "send_message", etc.
  timestamp: number;
  inputSummary: string;  // first 200 chars of input
  result: 'success' | 'error';
}
```

Each call to `processTaskIpc` appends to the buffer (the recorder exposes an `addTrace(groupId, taskId, action)` method called from the IPC handler).

On `task.complete`:
- **Success:** Convert trace to procedure candidate, save via procedure-store
- **Failure:** Discard trace
- **Either way:** Clear the buffer for that task

#### Agent Narration (Hybrid Merge)

The container learning skill instructs agents to optionally emit a `_procedure` block:

```json
{
  "_procedure": {
    "name": "check-pr-status",
    "trigger": "check PR status",
    "description": "Check GitHub PR status and summarize",
    "steps": [
      { "action": "github_api", "details": "GET /repos/{owner}/{repo}/pulls/{number}" },
      { "action": "format_response", "details": "Summarize PR title, status, reviewers" }
    ]
  }
}
```

**Merge logic:** If the agent provides a `_procedure` block:
- Use the agent's human-readable `description` and step `details` for readability
- Validate against the IPC trace: drop steps the agent mentions that didn't appear in the trace (hallucination guard)
- Add IPC trace actions the agent omitted

If no `_procedure` block, save the raw IPC trace as the procedure with auto-generated descriptions.

#### Deduplication

Before saving, call `findProcedure(trigger, groupId)`. If a matching procedure exists:
- Same steps (>70% overlap): increment `success_count`
- Different steps (<70% overlap): save as a new variant

#### Minimum Trace Length

Only save procedures with 2+ IPC actions. Single-action tasks (e.g., one `send_message`) aren't worth recording as procedures.

#### API

```typescript
function startTrace(groupId: string, taskId: string): void;
function addTrace(groupId: string, taskId: string, action: TracedAction): void;
function finalizeTrace(groupId: string, taskId: string, success: boolean, agentProcedure?: AgentProcedure): void;
```

---

### 4. Procedure Matcher & Executor (`src/learning/procedure-matcher.ts`)

Matches incoming messages to learned procedures, offers or auto-executes them, handles user opt-in, and promotes across groups.

#### Matching

Hooks into the existing message processing pipeline in `src/index.ts`, called before `queue.enqueueMessageCheck()`. If a procedure matches and the user accepts, the procedure execution replaces the normal agent run for that message.

On `message.inbound`:

1. Extract keywords from the user's message
2. Call `findProcedure(trigger, groupId)` — procedure-store already does fuzzy trigger matching
3. If no match: return `null`, caller proceeds normally (message goes to agent queue)
4. If match found: check `auto_execute` flag

#### Execution Flow

**`auto_execute: false`:**
```
User: "Check PR status for nanoclaw"
Bot: "I have a learned procedure for this (87% success rate, ran 8 times).
      Run it? [Yes / Yes, always / No]"
```

- "Yes" → execute procedure this time, keep `auto_execute: false`
- "Yes, always" → set `auto_execute: true`, execute procedure
- "No" → proceed with normal agent run

**`auto_execute: true`:**
```
User: "Check PR status for nanoclaw"
→ Execute procedure silently, report result
→ If failure: fall back to normal agent run, set auto_execute = false, increment failure_count
```

#### Execution Mechanics

Procedures execute by spawning a normal agent container with the procedure steps injected as explicit instructions:

```
Execute this exact procedure (learned from prior success):
1. GET /repos/nanoclaw/pulls via GitHub API
2. Summarize PR title, status, and reviewers
3. Format and send the result

Follow these steps precisely. If any step fails, report the failure.
```

No new execution engine — reuses the existing container infrastructure. The procedure is structured guidance, not a macro.

#### Failed Auto-Execute Recovery

If an auto-executed procedure fails:
1. Set `auto_execute = false`
2. Increment `failure_count` via `updateProcedureStats(name, false, groupId)`
3. Send brief note to user: "Learned procedure failed, running normally."
4. Fall back to normal agent run with the original message

#### User Controls (IPC Commands)

Handled in `processTaskIpc` as new command types:

- `"stop auto-running [name]"` → sets `auto_execute = false`
- `"forget procedure [name]"` → calls `deleteProcedure()`
- `"list procedures"` → calls `listProcedures(groupId)`

These follow the existing trust/assistant command interception pattern.

#### Cross-Group Promotion

After a procedure succeeds, check if the same trigger has matching procedures in 2+ different groups. If so:

1. Copy the procedure to global scope (`store/procedures/`)
2. Merge stats from all group-level copies
3. Keep group-level copies intact (they may diverge over time)
4. Emit `learn.procedure_promoted` event

---

### 5. Feedback Capture (`src/learning/feedback-capture.ts`)

Detects user corrections in conversation and saves them as high-confidence rules.

#### Inline Detection

When a user message arrives within 2 minutes of the last bot response for the same group, check for corrective intent via keyword matching:

**Correction keywords:** `"wrong"`, `"don't"`, `"stop"`, `"instead"`, `"not that"`, `"shouldn't"`, `"bad"`, `"incorrect"`, `"no,"` (leading "no" followed by comma or period)

**Positive keywords:** `"perfect"`, `"exactly"`, `"great"`, `"keep doing"`, `"that worked"`

If correction detected:
- Extract the actionable content (the full user message minus filler)
- Save as a rule with `source: 'user_feedback'`, `confidence: 0.9`
- Infer `actionClasses` from the preceding bot response context

If positive detected:
- Find the most recent outcome for this group
- Boost its associated rules' confidence by 0.1

#### Explicit IPC Command

Containers can forward user corrections programmatically:

```json
{ "type": "learn_feedback", "feedback": "Use API not browser for GitHub", "groupId": "g1" }
```

Saved as a rule with `source: 'user_feedback'`, `confidence: 0.9`.

#### False Positive Prevention

- Only trigger on clear corrections, not ambiguous messages
- Require the message to be a direct reply context (within 2 minutes of last bot message)
- Never trigger on the first message in a conversation (no bot response to correct)

---

### 6. Initialization (`src/learning/index.ts`)

Single entry point wiring all learning subscribers to the event bus:

```typescript
function initLearningSystem(eventBus: EventBus, deps: LearningDeps): void;
```

Called from `src/index.ts` after `startEventLog(eventBus)`, following the same pattern.

**LearningDeps:**
```typescript
interface LearningDeps {
  eventBus: EventBus;
  getRegisteredGroups: () => Record<string, GroupInfo>;
  sendMessage: (jid: string, text: string) => Promise<void>;
  enqueueTask: (jid: string, taskId: string, fn: () => Promise<void>) => void;
}
```

Subscribers wired:
- `task.started` → `procedureRecorder.startTrace()`
- `task.complete` → `procedureRecorder.finalizeTrace()`, outcome pattern analysis
- `message.inbound` → `procedureMatcher.checkMatch()`, `feedbackCapture.check()`

---

## Event Types

Added to `src/events.ts` EventMap:

| Event | Payload | When |
|-------|---------|------|
| `learn.rule_created` | `{ ruleId, rule, source, groupId }` | Rule distilled from outcomes/feedback |
| `learn.rule_applied` | `{ ruleId, groupId, taskId }` | Rule injected into agent prompt |
| `learn.procedure_saved` | `{ name, trigger, groupId, stepCount }` | Procedure recorded from successful task |
| `learn.procedure_matched` | `{ name, trigger, groupId, autoExecute }` | Inbound message matched a procedure |
| `learn.procedure_executed` | `{ name, groupId, success, durationMs }` | Procedure ran to completion |
| `learn.procedure_promoted` | `{ name, fromGroups, stepCount }` | Procedure promoted to global scope |
| `learn.feedback_received` | `{ ruleId, feedback, groupId }` | User correction captured as rule |

---

## Container Skill

New file: `container/skills/learning/SKILL.md`

Instructs the agent on two optional output blocks:

1. **`_procedure`** — Structured JSON of steps taken during a multi-step task. Only emit after successful multi-step tasks. Include a trigger phrase that would match future similar requests.

2. **`_lesson`** — A short string describing something discovered during execution (e.g., "OAuth tokens for this Gmail account expire every 55 minutes, not 60").

Both are optional. The orchestrator captures IPC traces regardless — agent narration enriches but is not required.

---

## File Structure

```
src/learning/
  rules-engine.ts          # Rule CRUD, pattern extraction, confidence decay
  outcome-enricher.ts      # Query rules, format prompt block, inject at spawn
  procedure-recorder.ts    # IPC trace buffer, procedure saving, merge logic
  procedure-matcher.ts     # Match inbound messages, execute/offer, promote
  feedback-capture.ts      # Detect user corrections, save as rules
  index.ts                 # initLearningSystem() — wires all subscribers

container/skills/learning/
  SKILL.md                 # Agent instructions for _procedure and _lesson blocks
```

---

## Scope & Learning Model

**Per-group isolation by default.** Rules and procedures are scoped to the originating group. Each group learns independently — what works for email triage in one group doesn't auto-apply to a project-specific group.

**Global promotion on convergence.** When a procedure succeeds in 2+ different groups with the same trigger, it's promoted to global scope. Global rules/procedures are available to all groups but can be overridden by group-specific ones.

**User-controlled auto-execution.** Procedures start with `auto_execute: false`. Users explicitly opt in via "Yes, always" — no automatic graduation based on success count. Users can revoke at any time.

---

## Edge Cases

**Concurrent tasks:** IPC trace buffer is keyed by `groupId + taskId`, so concurrent tasks in different groups don't interfere.

**Procedure conflicts:** If two procedures match the same trigger, pick the one with the higher success rate. If tied, prefer group-scoped over global (local context wins).

**Failed auto-execute:** Fall back to normal agent run immediately. Set `auto_execute = false`, increment `failure_count`, notify user with brief message.

**Rule contradictions:** Source hierarchy resolves conflicts: `user_feedback > outcome_pattern > agent_reported`. Higher-source rules suppress lower-source contradictions for the same action class.

**Database growth:** `learned_rules` bounded by confidence decay + pruning (below 0.1 deleted). Procedures bounded by existing file-based procedure-store.

**Startup recovery:** In-memory trace buffer is lost on restart. Acceptable — one missed procedure recording per restart is negligible. All persisted state (rules, procedures) survives restart.

---

## Integration Points

| Existing Code | Change |
|---------------|--------|
| `src/index.ts` | Call `initLearningSystem()` after `startEventLog()`. Call `buildRulesBlock()` before `runAgent()` and append to prompt. |
| `src/ipc.ts` | Call `procedureRecorder.addTrace()` in `processTaskIpc()`. Add `learn_feedback` IPC type. |
| `src/events.ts` | Add 7 `learn.*` event type definitions to EventMap. |
| `src/container-runner.ts` | Parse `_procedure` and `_lesson` blocks from ContainerOutput. |
| `container/skills/learning/SKILL.md` | New file — agent instructions for optional output blocks. |
