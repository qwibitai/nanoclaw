# Background Kaizen Reflection — Specification

## 1. Problem Statement

Kaizen reflection gates block the main agent's Bash tool after `gh pr create` and `gh pr merge`. The agent must stop mid-task, reflect on impediments, search for existing issues, file kaizen issues or declare no-action, then resume work. This takes 2-5 minutes each time and breaks flow — especially painful when the agent is mid-implementation and needs to create a PR as an intermediate step, not a stopping point.

### Concrete scenario

```
Agent is implementing kaizen #111:
  1. Writes code, runs tests ✓
  2. Commits, pushes ✓
  3. `gh pr create` → kaizen-reflect.sh fires → enforce-pr-kaizen.sh BLOCKS Bash
  4. Agent must now: search issues, reflect, file kaizen issue, clear gate   ← 3 min blocked
  5. Agent can resume: queue auto-merge, monitor CI
  6. `gh pr merge --auto` merges → kaizen-reflect.sh fires again → BLOCKS Bash again
  7. Agent must now: reflect on merge, file issues, clear gate              ← 3 min blocked
  8. Agent can resume: sync main, mark case done
```

Steps 4 and 7 are valuable work — but they don't need to block the main task. The reflection can happen in the background while the agent continues with merge monitoring and post-merge steps.

### Who experiences this

Dev agents working on kaizen issues. Every PR creation and merge triggers a blocking reflection. In a session that ships 2 PRs, that's 4 blocking reflection gates (~12 minutes of blocked flow).

### Cost of not solving

Agent time wasted on context switching. The reflection itself doesn't suffer — the agent does the same work either way. But the main task stalls while waiting, and the agent loses its "mental model" of what it was doing mid-implementation.

## 2. Desired End State

When a kaizen gate fires (PR create or merge), the main agent:
1. Captures its current context (what was built, impediments encountered, PR URL)
2. Launches a background subagent with that context
3. Continues working on the main task immediately — gate does not block
4. The background subagent completes the reflection, files issues, and clears the gate
5. When the subagent finishes, its results are reported back to the main agent

The main agent never stops. The reflection happens concurrently. The gate clears without the main agent lifting a finger.

### What is explicitly NOT in scope

- Changing what reflection covers (the prompts stay the same)
- Removing the gates entirely (they're valuable — they ensure reflection happens)
- Running subagents for non-kaizen gates (PR review must remain synchronous — the agent needs to act on findings)
- Subagents launching their own subagents (must be prevented — see Section 4)

## 3. Roles & Boundaries

| Role | Can do | Cannot do |
|------|--------|-----------|
| Main agent | Launch kaizen subagent, continue working, receive results | Skip reflection entirely |
| Kaizen subagent | Search issues, file kaizen issues, add incident comments, declare no-action, clear the gate | Launch sub-subagents, edit code, create PRs, run tests, invoke tools beyond kaizen scope |

## 4. Architecture & Constraints

### Current gate mechanics

```
gh pr create/merge
  → kaizen-reflect.sh (PostToolUse/Bash) writes state file
  → enforce-pr-kaizen.sh (PreToolUse/Bash) blocks non-kaizen Bash
  → pr-kaizen-clear.sh (PostToolUse/Bash) clears on gh issue create or KAIZEN_NO_ACTION
```

### Key finding: Agent tool is NOT blocked during kaizen gate

`enforce-pr-kaizen.sh` only matches `Bash` tool. The `Agent` tool is not gated during kaizen reflection. This means **a background subagent can already be launched while the gate is active** — the mechanism exists, we just need to use it.

### The clearing problem

State clearing requires a **Bash PostToolUse event** in the current session:
- `gh issue create --repo Garsson-io/kaizen` with a GitHub URL in stdout
- `echo "KAIZEN_NO_ACTION: <reason>"`

A subagent's Bash calls fire PostToolUse in the subagent's context, not the main session's. So a subagent cannot directly clear the main session's gate via `pr-kaizen-clear.sh`.

**Proposed solution:** The subagent reports its results back to the main agent. The main agent then runs the actual gate-clearing command (a single allowed Bash call — `gh issue create` or `echo "KAIZEN_NO_ACTION: ..."`). This is a 5-second operation, not a 3-minute one.

Alternative: modify `pr-kaizen-clear.sh` to also check for a "reflection complete" marker file written by the subagent. This is more autonomous but adds complexity to the state file system.

**Recommendation:** Start with the simple approach (subagent reports, main agent clears). Evaluate whether the 5-second clearing step is worth eliminating after seeing it in practice.

### Preventing sub-subagent spawning

The kaizen subagent MUST NOT be able to launch its own subagents. This prevents:
- Recursive agent spawning (reflection spawns reflection spawns reflection)
- Unbounded resource consumption
- Unclear responsibility chains

**Enforcement mechanism:** The subagent prompt must explicitly instruct "Do NOT use the Agent tool." This is L1 (instructions to the subagent). For L2, the subagent could be launched with a restricted tool set — but Claude Code's Agent tool doesn't currently support tool restrictions on subagents.

**Open question:** Can Claude Code hooks detect and block a subagent from using the Agent tool? If `enforce-pr-kaizen.sh` were extended to also match `Agent` tool during `needs_pr_kaizen` state, it would block Agent invocations — but that blocks ALL Agent use, not just from subagents. A more targeted approach: the subagent runs with `subagent_type` set to a specialized agent type that has Agent excluded from its tool list. This needs investigation.

## 5. Interaction Model

### Happy path

```
1. Agent runs `gh pr create` → kaizen-reflect.sh fires, writes state file
2. Agent's next action: launch background kaizen subagent
   - Passes: PR URL, branch, list of impediments/friction from the session
   - Uses: Agent tool with run_in_background: true
3. Agent continues main work (merge monitoring, next task, etc.)
4. Background subagent:
   a. Reads the reflection prompt
   b. Searches existing kaizen issues: `gh issue list --search`
   c. For each impediment:
      - Match found → adds incident comment to existing issue
      - No match → files new kaizen issue
      - Trivial → declares KAIZEN_NO_ACTION with reason
   d. Reports results back to main agent
5. Main agent receives notification that subagent completed
6. Main agent runs gate-clearing command:
   - `gh issue create` (if subagent filed an issue — use the URL)
   - OR `echo "KAIZEN_NO_ACTION: <reason>"` (if subagent declared no action)
7. Gate clears. Main agent was never blocked.
```

### Edge case: subagent fails

If the subagent errors out or times out:
- The gate remains active (safe default)
- The main agent is notified of the failure
- The main agent must handle reflection manually (fallback to current behavior)

### Edge case: main agent finishes before subagent

If the main agent tries to stop while the subagent is still running:
- `enforce-post-merge-stop.sh` blocks (the post-merge gate is still active)
- The main agent waits for the subagent to complete
- This is acceptable — the agent can't leave without reflection completing

### Edge case: multiple PRs in quick succession

If the agent creates PR #1, launches a kaizen subagent, then creates PR #2:
- PR #2's create triggers a second state file
- The first subagent clears gate #1, the agent must handle gate #2
- Each PR gets its own reflection — no shortcuts

## 6. What the Subagent Prompt Looks Like

```
You are a kaizen reflection subagent. Your job is to reflect on the work
that just completed and produce actionable improvements.

CONSTRAINTS:
- Do NOT use the Agent tool. You must not launch sub-subagents.
- Do NOT edit files, create PRs, or modify code.
- You CAN use: Bash (for gh issue commands, git log), Read, Grep, Glob.

CONTEXT:
- PR: {pr_url}
- Branch: {branch}
- Changed files: {file_list}
- Impediments encountered: {impediment_list}

TASK:
1. For each impediment, search existing kaizen issues:
   `gh issue list --repo Garsson-io/kaizen --state open --search "<keywords>"`

2. If a match exists, add an incident comment:
   `gh issue comment {N} --repo Garsson-io/kaizen --body "..."`
   Use format: ## Incident #N (YYYY-MM-DD) / PR/Context / Impact / Details

3. If no match, file a new issue:
   `gh issue create --repo Garsson-io/kaizen --title "..." --body "..."`

4. If no action needed, explain why.

5. Report back: list of actions taken (issue URLs, incident comments, or no-action reasons).
```

## 7. What Exists vs What Needs Building

### Already Solved

| Capability | Current implementation | Status |
|------------|----------------------|--------|
| Agent tool with `run_in_background` | Built into Claude Code | Works |
| Kaizen reflection prompts | `kaizen-reflect.sh` | Shipped |
| Gate state file system | `state-utils.sh`, `enforce-pr-kaizen.sh` | Shipped |
| Incident comment format | `kaizen-reflect.sh` prompt (kaizen #124) | Just shipped |
| Issue search before filing | `kaizen-reflect.sh` prompt (kaizen #124) | Just shipped |

### Needs Building

All Phase 1 components were shipped in the initial implementation. See "Implementation Record" below.

## 8. Resolved Questions

### Q1: Should the subagent clear the gate directly?
**Decision: Option A** — Subagent reports, main agent clears. The 5-second overhead is negligible and avoids state file system changes.

### Q2: How to prevent sub-subagent spawning reliably?
**Decision: Not needed.** Claude Code has a hard architectural limit: subagents cannot spawn other subagents. This is L3 enforcement built into the platform — no hooks or restrictions needed. The kaizen-bg agent definition also excludes the Agent tool from its `tools` allowlist (defense-in-depth, L3).

### Q3: Should this replace or supplement the current flow?
**Decision: Replace.** The hook output now instructs agents to launch kaizen-bg instead of doing inline reflection. The subagent receives full context (PR URL, branch, changed files, impediments) as structured input. The gate stays as a safety net.

### Q4: What about the post-merge Stop gate?
**Deferred.** The post-merge Stop gate (`enforce-post-merge-stop.sh`) is separate from the PR kaizen gate. It blocks session end, not Bash. The kaizen-bg subagent handles the PR kaizen gate reflection. The Stop gate still requires the main agent to run `/kaizen` — this is less disruptive since it happens at session end, not mid-task.

## 9. Implementation Record

### Phase 1: Shipped — Hook-driven subagent launch (kaizen #131)

Skipped the "manual pattern" phase and went directly to modifying `kaizen-reflect.sh` — the manual pattern was obvious once the architecture was understood, and documenting it without shipping the hook change would have been pure L1.

**What was built:**

| Component | File | What it does |
|-----------|------|-------------|
| Agent definition | `.claude/agents/kaizen-bg.md` | Sonnet model, tools: Read/Grep/Glob/Bash/Skill, maxTurns: 30, kaizen skill preloaded. Prompt emphasizes thorough duplicate search and incident filing. |
| Modified reflection hook | `.claude/kaizen/hooks/kaizen-reflect.sh` | Both PR-create and PR-merge prompts now instruct the main agent to launch kaizen-bg subagent with context. Gate-clearing format included in output. |
| Tests | `.claude/kaizen/hooks/tests/test-kaizen-reflect.sh` | 19 tests: state file creation, subagent instruction presence, agent definition validation (tools, model, maxTurns). |

**What was NOT changed:**
- `enforce-pr-kaizen.sh` — gate enforcement unchanged
- `pr-kaizen-clear.sh` — clearing validation unchanged
- `state-utils.sh` — state file system unchanged
- Gate flow — same state files, same enforcement, same clearing commands

**Key discovery:** `gh pr checks` was already in the allowed commands list (kaizen #132 fix was already shipped but issue left open).

### Future phases

**Phase 2: Automatic subagent launch (L3)**
If agents consistently follow the launch instruction, modify `kaizen-reflect.sh` to emit a structured JSON signal that Claude Code's hook system could auto-trigger the Agent tool. This would remove the need for the agent to manually launch the subagent. Only warranted if data shows agents sometimes skip the launch.

**Phase 3: Quality telemetry**
Track reflection quality metrics: how many issues filed, incidents added, duplicates avoided. Compare background vs inline reflection quality. This feeds into kaizen #82 (telemetry infrastructure).
