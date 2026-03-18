# Kaizen Telemetry & Investigations — Specification

Data collection, persistent reflections, and recursive investigations for the autonomous kaizen system.

## 1. Problem Statement

The autonomous kaizen spec (PR #112) defines a learning loop: capture → classify → analyze → prevent → meta-reflect. But the spec is silent on three foundational questions:

1. **Where does the raw data come from?** Agent sessions produce rich telemetry — tool calls, hook blocks, failures, timing, decisions. Today this evaporates when the session ends. Without persistent session data, investigations are based on memory (unreliable) and PR diffs (incomplete).

2. **Where do reflections go?** Today, kaizen reflections are written as text in PR comments or conversation responses. They serve double duty: completing a hook requirement AND capturing learning. This creates two problems:
   - **Distraction** — reflections clutter the PR workflow. The agent is trying to ship code; the reflection is a detour.
   - **Ephemeral** — reflections live in conversation context (lost when session ends) or PR comments (buried, unsearchable as structured data).

3. **How do investigations happen?** There's no defined process for looking at accumulated data and finding patterns. PR #112 describes periodic pattern analysis, but doesn't specify the data sources, storage, or how investigations chain together recursively.

### Concrete Example: The contract.json Incident

During the versioning & staging epic (PRs #100-#110), the `check-dirty-files` hook blocked pushes twice because `npm test` overwrites `contract.json`. Both times:
- The agent wrote a correct kaizen reflection (root cause, prevention idea)
- The agent restored the file and moved on
- The reflection text was lost in conversation context
- No one connected the two occurrences
- The second reflection didn't know the first existed

With telemetry + persistent reflections + investigations:
- Session telemetry would show: hook block → same file → same root cause → twice
- Both reflections would be in `Garsson-io/kaizen` repo, searchable
- An investigation (triggered by recurrence) would connect them and demand escalation
- The investigation output would be a `/write-prd` spec → tracked issue → fix

### Who experiences this

- **Dev agents** — write reflections that go nowhere, repeat the same analysis
- **Aviad** — reviews PRs without visibility into what the agent struggled with
- **The kaizen system itself** — can't learn from its own history

## 2. Desired End State

### Three layers, each feeding the next

```
Layer 1: SESSION TELEMETRY (raw data)
  Every agent session produces structured events:
  tool calls, hook outcomes, errors, timing, decisions.
  Stored per-session, retrievable by session ID.
         │
         ▼
Layer 2: REFLECTIONS (observations)
  At multiple points (hook blocks, CI failures, human
  corrections, session end), structured reflections are
  captured and saved to Garsson-io/kaizen repo.
  NOT in PRs. NOT in conversation. Persistent, searchable.
         │
         ▼
Layer 3: INVESTIGATIONS (analysis)
  On-demand or pattern-triggered, an agent reads accumulated
  reflections + session data, finds patterns, and produces
  actionable specs via /write-prd → tracked issues.
  Investigations are recursive: they read past investigations.
         │
         ▼
  PRDs → Issues → Implementation → Sessions → ...
```

### What "good" looks like

- After every session, structured telemetry is persisted. An investigation agent can ask "show me all sessions where hook X blocked a push" or "what tool calls failed most often this week."
- Reflections are written to `Garsson-io/kaizen` as JSON files, not as PR comments. They capture the observation without distracting from the work.
- Investigations are first-class artifacts — saved, searchable, recursive. An investigation can reference past investigations and ask "did we actually fix what we said we'd fix?"
- The flow from observation to action is: reflection → investigation → `/write-prd` → issue → implementation. Each step has a clear artifact.

### Out of scope

- Real-time monitoring/alerting (this is about dev process, not production)
- Cross-vertical telemetry (each vertical's kaizen is separate)
- Full conversation transcript capture (start with structured events; upgrade if investigations say it's needed)

## 3. Architecture

### 3a. Session Telemetry

**What to capture** (structured events):

| Event type | Data | When |
|------------|------|------|
| `tool_call` | tool name, args summary, success/failure, duration | Every tool invocation |
| `hook_block` | hook name, reason, file(s) involved, resolution | When a hook blocks an action |
| `hook_pass` | hook name | When a hook passes (for "never fires" detection) |
| `ci_result` | job name, pass/fail, duration, error summary | After CI run |
| `error` | error type, message, stack context | Unhandled errors, retries |
| `human_correction` | what was corrected, agent's original action | When user says "no, do X instead" |
| `decision` | what was decided, alternatives considered | Significant architectural choices |
| `session_summary` | duration, PRs created, commits, tools used, blocks encountered | Session end |

**Storage**: JSON file per session in `Garsson-io/kaizen` repo under `telemetry/sessions/`. Filename: `{YYMMDD}-{HHMM}-{session-id-short}.json`.

**Size management**: Start with structured events only (small). If investigations identify gaps ("I needed the full conversation to understand why the agent chose X"), upgrade to include conversation excerpts — guided by kaizen itself.

### 3b. Reflections

**Trigger points** (when reflections are captured):

| Trigger | What's captured | Current state |
|---------|----------------|---------------|
| Hook block | Root cause, resolution, class, recurrence | Exists (text in conversation, lost) |
| CI failure | What failed, why, what should have caught it earlier | Doesn't exist |
| Human correction | What was wrong, why agent did it, prevention | Exists (feedback memory, L1 only) |
| PR review finding | What review caught, why agent missed it | Partial (pr-review-loop) |
| Session end | Overall friction, DX gaps, improvement ideas | Doesn't exist |

**Reflection schema** (JSON):

```json
{
  "id": "ref-260318-0847-abc123",
  "timestamp": "2026-03-18T08:47:00Z",
  "session_id": "session-260318-0647",
  "trigger": "hook_block",
  "trigger_detail": "check-dirty-files blocked push: contract.json modified",

  "observation": "generate-contract.test.ts overwrites tracked contract.json during npm test",
  "bug_class": "test_side_effect",
  "root_cause_chain": [
    "test calls CLI directly",
    "CLI writes to tracked file",
    "file has timestamp that changes every run"
  ],
  "severity": "low",
  "human_affected": false,
  "recurrence": {
    "is_recurring": true,
    "previous_ref_ids": ["ref-260318-0752-def456"],
    "times_seen": 2
  },

  "proposed_fix": "Export generateContract(), test in-memory",
  "fix_level": "L3",
  "fix_implemented": false,

  "related_prs": ["#103", "#110"],
  "related_investigations": []
}
```

**Storage**: `Garsson-io/kaizen` repo under `reflections/`. One JSON file per reflection. Git gives history, search, cross-machine sync.

**Key design decision**: Reflections are **saved externally, not in PRs**. The hook still blocks and demands a reflection, but the output goes to the kaizen repo, not into the PR comment. The agent's response in the PR workflow is just "Reflected. See ref-260318-0847-abc123." This keeps the PR focused on shipping code.

### 3c. Investigations

**What triggers an investigation:**

| Trigger | Example |
|---------|---------|
| Recurrence detected | Same `bug_class` appears in 2+ reflections |
| On-demand | `/kaizen investigate` — agent or human asks |
| Pattern noticed during reflection | "I've seen this class before" while writing a reflection |

**Investigation process:**

```
1. GATHER — read reflections by class, time range, or keyword
   Also read session telemetry for the relevant sessions
   Also read past investigations on related topics

2. ANALYZE — find patterns:
   - Same root cause recurring? → escalation needed
   - Same agent mistake across sessions? → instruction/tooling gap
   - Same hook blocking repeatedly? → hook is catching symptoms, not cause
   - Past investigation recommended X — was X implemented? Did it work?

3. PRODUCE — output is one of:
   a. /write-prd spec → GitHub issue → tracked improvement
   b. Direct fix (if small enough)
   c. "No action needed" with reasoning (still saved)

4. SAVE — investigation saved to Garsson-io/kaizen under investigations/
   References the reflections and sessions it analyzed
```

**Investigation schema** (JSON):

```json
{
  "id": "inv-260318-0900-xyz789",
  "timestamp": "2026-03-18T09:00:00Z",
  "trigger": "recurrence_detected",
  "scope": "bug_class:test_side_effect, last 7 days",

  "reflections_analyzed": ["ref-260318-0752-def456", "ref-260318-0847-abc123"],
  "sessions_analyzed": ["session-260318-0647"],
  "past_investigations_reviewed": [],

  "findings": [
    {
      "pattern": "Same root cause identified twice, not fixed either time",
      "category": "escalation_failure",
      "evidence": "Two reflections with identical root_cause_chain, fix_implemented=false"
    }
  ],

  "actions": [
    {
      "type": "write_prd",
      "title": "Fix generate-contract test side effect",
      "issue_url": "https://github.com/Garsson-io/kaizen/issues/80",
      "status": "created"
    }
  ],

  "meta": {
    "past_investigation_followup": null,
    "kaizen_system_improvement": "Reflections need recurrence field populated automatically by checking existing reflections before saving"
  }
}
```

**Recursive investigations**: Every investigation checks: "Have past investigations on this topic already produced recommendations? Were they implemented? Did they work?" This is the "system that gets better on its own" — investigations evaluate whether previous improvements actually improved things.

### 3d. Storage Layout in Garsson-io/kaizen

```
Garsson-io/kaizen/
├── reflections/
│   ├── 2026-03/
│   │   ├── ref-260318-0752-def456.json
│   │   ├── ref-260318-0847-abc123.json
│   │   └── ...
│   └── 2026-04/
│       └── ...
├── investigations/
│   ├── inv-260318-0900-xyz789.json
│   └── ...
├── telemetry/
│   └── sessions/
│       ├── 260318-0647-abc.json
│       └── ...
└── issues/           (existing — GitHub Issues remain the human-facing view)
```

## 4. Interaction Models

### 4a. Agent session with telemetry capture

```
1. Session starts
2. Agent works — tool calls, decisions, errors logged as structured events
3. Hook blocks push (check-dirty-files)
4. Agent writes reflection → saved to Garsson-io/kaizen/reflections/
   - Before saving, checks: "any existing reflections with same bug_class?"
   - If recurrence found: marks is_recurring=true, links previous
5. Agent resolves the block, continues work
6. Session ends → session summary event saved to telemetry/sessions/
```

### 4b. On-demand investigation

```
1. Agent or human runs /kaizen investigate (or agent notices recurrence)
2. Agent reads reflections/ — filters by class, time, recurrence
3. Agent reads relevant session telemetry for context
4. Agent reads past investigations/ on related topics
5. Agent produces investigation report:
   - Patterns found
   - Actions: /write-prd for significant findings, direct fixes for small ones
   - Meta: did past investigations' recommendations get implemented?
6. Investigation saved to investigations/
7. If actionable: /write-prd → issue created in Garsson-io/kaizen
```

### 4c. Recursive self-improvement

```
1. Investigation reads past investigation inv-001 which recommended Fix X
2. Checks: was Fix X implemented? (look for PR/commit references)
3. Checks: did the bug class recur after Fix X? (query reflections post-implementation)
4. If Fix X wasn't implemented: escalate — create issue, flag to leads
5. If Fix X was implemented but class recurred: Fix X was insufficient
   → The fix level was wrong (L1 when L2 was needed, etc.)
   → Recommend escalation
6. If Fix X was implemented and class stopped recurring: success!
   → Record as validated prevention pattern
   → Can this pattern apply to other classes?
```

## 5. Relationship to Autonomous Kaizen (PR #112)

This spec provides the **data infrastructure** for PR #112's learning loop:

| PR #112 concept | This spec provides |
|-----------------|-------------------|
| Incident store | → Reflections (structured, persistent, cloud-visible) |
| Enhanced reflection protocol | → Reflection schema + trigger points |
| Cross-incident pattern analysis | → Investigations (recursive, saved, actionable) |
| Meta-kaizen | → Investigation recursion (check past investigations) |
| Blast radius scan | → Session telemetry (what else happened in the session?) |
| Signals from lifecycle stages | → Telemetry capture at multiple points |

PR #112 describes WHAT the system should do. This spec describes WHERE the data lives and HOW it flows.

## 6. What Exists vs What Needs Building

### Already Exists

| Capability | Implementation | Status |
|------------|---------------|--------|
| Hook-triggered reflections | `check-dirty-files.sh`, `kaizen-reflect.sh` | Working — but output is ephemeral text |
| Kaizen issue tracking | `Garsson-io/kaizen` GitHub Issues | Working |
| `/write-prd` skill | Creates specs from investigation findings | Working |
| Feedback memories | `~/.claude/` memory files | Working — L1, local only |

### Needs Building

| Component | What | Priority |
|-----------|------|----------|
| **Reflection writer** | Hook/tool that saves structured reflection JSON to `Garsson-io/kaizen/reflections/` | High — enables everything else |
| **Recurrence checker** | Before saving a reflection, search existing reflections for same `bug_class` | High — enables escalation |
| **Session telemetry collector** | Captures structured events during agent sessions | Medium — enriches investigations |
| **Investigation skill** | `/kaizen investigate` — reads reflections + telemetry, finds patterns, produces actions | Medium — the analytical layer |
| **Reflection trigger points** | Add capture at CI failure, human correction, session end (not just hook blocks) | Medium — broadens coverage |
| **Investigation recursion** | Investigations check past investigations for follow-through | Low — needs investigation history first |

## 7. Open Questions

### Storage format and location

**Q1: What format for reflections and investigations?**
Options:
- (a) JSON — machine-parseable, schema-enforceable, but verbose and hard to read/edit by hand
- (b) YAML — more readable, still structured, common in config-oriented repos
- (c) Markdown with frontmatter — human-readable body with structured metadata header
- (d) GitHub Issues with labels — no files at all, everything is an issue with structured body

Lean: Open. JSON is easiest to query programmatically. YAML is friendlier for human review. Markdown with frontmatter gives both. GitHub Issues avoid file management entirely but are harder to query structurally.

**Q2: Where do reflections and investigations live?**
Options:
- (a) `Garsson-io/kaizen` repo (files) — already exists, cloud-visible, git-synced
- (b) Dedicated repo (e.g. `Garsson-io/kaizen-data`) — separates operational issues from data
- (c) GitHub Issues in `Garsson-io/kaizen` — no file management, searchable via API, but noisy
- (d) GitHub Issues in a dedicated repo — clean separation, API-queryable
- (e) Hybrid — structured data as issues (queryable via API), investigations as files (longer-form)

Lean: Open. Files in a repo give git history and diffs. Issues give labels, search, and cross-referencing. A dedicated repo avoids polluting the operational kaizen backlog with raw data. Need to prototype and see what investigations actually need.

**Q3: How does the agent write to the kaizen store during a session?**
The agent works in a worktree of `nanoclaw`. Writing to a different repo requires either: (a) cloning/pulling kaizen repo into a temp dir, (b) using GitHub API to create files/issues, or (c) an IPC mechanism where the host writes on behalf of the agent.
Lean: GitHub API via `gh api` — simple, no local clone needed, works from any worktree. Also works for issue creation.

### Process and quality

**Q4: Should reflections be reviewed before saving?**
Options: (a) Auto-save all reflections (captures everything, including noise). (b) Agent self-reviews reflection quality before saving. (c) Significant reflections only (filter by severity/recurrence).
Lean: (a) initially — capture everything. Investigations filter the noise. If the store gets too noisy, add filtering based on what investigations actually use.

**Q5: How to bootstrap the `bug_class` taxonomy?**
Options: (a) Start with a seed list from known incidents. (b) Let agents classify freely, consolidate later. (c) Both.
Lean: (c) — seed from known classes (`test_side_effect`, `contract_violation`, `migration_incomplete`, `missing_enforcement`, `dx_friction`), let agents add new ones, periodically consolidate.

**Q6: Telemetry size and retention**
Session telemetry could grow fast. Options: (a) Keep everything forever. (b) Keep raw data for 90 days, summaries forever. (c) Keep only sessions referenced by reflections/investigations.
Lean: (b) — raw data has diminishing value after a few months; summaries and the reflections they produced are the durable artifacts.

### Multi-agent review and human feedback loops

**Q7: Should AI-generated plans be reviewed by multiple AI agents?**
This spec was written by one agent in one session. For big systemic plans like this, having multiple independent agents review the plan could catch blind spots, groupthink, and assumptions that a single agent wouldn't question. Options:
- (a) Single agent writes, human reviews (current)
- (b) Single agent writes, second agent reviews, human approves
- (c) Multiple agents independently propose, human synthesizes
- (d) Agent writes, human gives feedback, agent revises (current, but feedback is lost)

Lean: (b) for significant specs. The reviewing agent brings fresh context and different biases. But need to define "significant" — not every reflection needs multi-agent review.

**Q8: Where does human feedback on plans go?**
When a human reviews a spec and says "Fix B is too weak" or "you're missing X" — that feedback is itself a kaizen signal. Today it lives only in conversation context (lost when session ends). It should:
- Be captured as a reflection (source: `human_feedback`, trigger: `plan_review`)
- Reference the spec/PR it's about
- Feed into future investigations ("what kinds of feedback do humans give on agent-generated plans?")
- Influence how future plans are structured ("humans consistently push back on L1 solutions — default to L2+")

This is the "continued learning" loop: human feedback on the kaizen system IS kaizen data. It's turtles all the way down, but practically: every human correction on a plan should be a saved reflection that future planning agents can query.

**Q9: Should investigation findings be peer-reviewed before becoming issues?**
An investigation might produce wrong conclusions (bad pattern matching, false recurrence, over-engineering). Options:
- (a) Investigation → issue directly (fast, but may produce noise)
- (b) Investigation → human review → issue (safe, but bottleneck)
- (c) Investigation → second agent review → issue, human notified (balanced)

Lean: (c) for actionable findings that would create work. (a) for observations that just update the knowledge base.

## 8. Implementation Sequencing

```
Phase 1: Reflection persistence
  [reflection schema] → [reflection writer tool] → [recurrence checker]
  Hooks save reflections to Garsson-io/kaizen instead of PR comments.

Phase 2: Investigation capability
  [/kaizen investigate skill] → [investigation schema] → [/write-prd integration]
  Agents can analyze accumulated reflections and produce actionable specs.

Phase 3: Session telemetry
  [event collector] → [session summary] → [telemetry storage]
  Raw session data available for investigation enrichment.

Phase 4: Recursive self-improvement
  [investigation recursion] → [follow-through checker] → [meta-analysis]
  Investigations evaluate whether past recommendations were effective.
```

Phases 1 and 2 are the MVP — persistent reflections that feed into investigations. Phase 3 enriches the data. Phase 4 closes the loop.

## 9. References

- **PR #112** (`docs/autonomous-kaizen-spec.md`) — the autonomous kaizen vision this enables
- **PR #113** (`docs/test-side-effects-and-kaizen-escalation-spec.md`) — case study that motivated this spec
- **Garsson-io/kaizen#80** — the contract.json test side effect incident
- **Garsson-io/kaizen#81** — the autonomous kaizen tracking issue
